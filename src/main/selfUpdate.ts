import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * W4a in-app self-update ("Install pending build").
 *
 * The manual deploy ritual (close app → robocopy dist\win-unpacked → relaunch) has three documented
 * failure modes: syncing while the app runs (file locks), syncing an interrupted package (undersized
 * app.asar → "Failed to open path"), and copying only app.asar onto the old exe (asar-integrity hash
 * mismatch — the exe bakes a hash of the asar, so the WHOLE win-unpacked must move together).
 *
 * This module encodes the ritual: compare installed vs pending builds, validate the pending asar, and
 * hand the actual swap to a detached PowerShell helper that waits for this process to exit, mirrors the
 * whole folder, verifies, writes a result file, and relaunches. Pure pieces exported for headless tests.
 */

export interface BuildStamp {
  mtimeMs: number
  sizeBytes: number
}

export type UpdateState = 'unconfigured' | 'no-pending-build' | 'up-to-date' | 'pending' | 'pending-invalid'

/** A complete NordCode app.asar is ~44-48 MB; an interrupted electron-builder run leaves a smaller one
 *  that PASSES existence checks but fails to launch. Never install below this floor. */
export const MIN_ASAR_BYTES = 40 * 1024 * 1024

/** Decide what the Update section shows. `installed`/`pending` are the two app.asar stamps (null = absent). */
export function compareBuilds(installed: BuildStamp | null, pending: BuildStamp | null): UpdateState {
  if (!pending) return 'no-pending-build'
  if (pending.sizeBytes < MIN_ASAR_BYTES) return 'pending-invalid'
  if (!installed) return 'pending' // nothing installed yet — anything valid is installable
  const newer = pending.mtimeMs > installed.mtimeMs + 1000 // FAT/robocopy timestamps can wobble ~1s
  const different = pending.sizeBytes !== installed.sizeBytes
  return newer || (different && pending.mtimeMs >= installed.mtimeMs) ? 'pending' : 'up-to-date'
}

/** PowerShell single-quoted literal: the only metacharacter is the quote itself (doubled). Keeps paths
 *  with spaces/apostrophes intact and inert — nothing in them can be interpreted as code. */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * The detached helper (PowerShell 5.1-compatible — no ternaries): wait for the app PID to exit, mirror
 * the WHOLE win-unpacked over the install dir, verify the asar landed byte-for-byte in size, record the
 * outcome, and relaunch. robocopy exit codes < 8 are success.
 */
export function buildHelperScript(opts: { pid: number; distDir: string; installDir: string; exeName: string; resultFile: string }): string {
  const dist = psQuote(opts.distDir)
  const install = psQuote(opts.installDir)
  const exe = psQuote(path.join(opts.installDir, opts.exeName))
  const result = psQuote(opts.resultFile)
  return [
    `$ErrorActionPreference = 'Continue'`,
    `Wait-Process -Id ${opts.pid} -ErrorAction SilentlyContinue`,
    `Start-Sleep -Seconds 1`, // let file handles fully release after process exit
    `robocopy ${dist} ${install} /E /IS /IT /NFL /NDL /NJH /NJS /NP | Out-Null`,
    `$rc = $LASTEXITCODE`,
    `$distAsar = (Get-Item (Join-Path ${dist} 'resources\\app.asar') -ErrorAction SilentlyContinue).Length`,
    `$instAsar = (Get-Item (Join-Path ${install} 'resources\\app.asar') -ErrorAction SilentlyContinue).Length`,
    `$ok = 'false'`,
    `if (($rc -lt 8) -and ($distAsar -gt 0) -and ($distAsar -eq $instAsar)) { $ok = 'true' }`,
    `Set-Content -Path ${result} -Value ('{"ok":' + $ok + ',"rc":' + $rc + ',"at":"' + (Get-Date -Format o) + '"}')`,
    `Start-Process ${exe}`
  ].join('\r\n')
}

export interface UpdateResult {
  ok: boolean
  rc?: number
  at?: string
}

/** Parse the helper's result file content; null on garbage (treated as "no prior self-update"). */
export function parseUpdateResult(content: string): UpdateResult | null {
  try {
    const v = JSON.parse(content) as { ok?: unknown; rc?: unknown; at?: unknown }
    if (typeof v.ok !== 'boolean') return null
    return { ok: v.ok, rc: typeof v.rc === 'number' ? v.rc : undefined, at: typeof v.at === 'string' ? v.at : undefined }
  } catch {
    return null
  }
}

// ── Effectful wrappers (thin; the logic above is the tested part) ────────────────────────────────

export function statBuild(asarPath: string): BuildStamp | null {
  try {
    const st = fs.statSync(asarPath)
    return { mtimeMs: st.mtimeMs, sizeBytes: st.size }
  } catch {
    return null
  }
}

/** Write the helper script to temp and launch it detached; the caller then quits the app. */
export function launchUpdateHelper(opts: { pid: number; distDir: string; installDir: string; exeName: string; resultFile: string }): void {
  const script = buildHelperScript(opts)
  const file = path.join(os.tmpdir(), `nordcode-self-update-${Date.now()}.ps1`)
  fs.writeFileSync(file, script, 'utf8')
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()
}
