import { describe, expect, it } from 'vitest'
import { buildHelperScript, compareBuilds, MIN_ASAR_BYTES, parseUpdateResult, psQuote, type BuildStamp } from './selfUpdate'

const stamp = (mtimeMs: number, sizeBytes = MIN_ASAR_BYTES + 5_000_000): BuildStamp => ({ mtimeMs, sizeBytes })

describe('compareBuilds', () => {
  it('pending when the dist build is newer than the installed one', () => {
    expect(compareBuilds(stamp(1_000_000), stamp(2_000_000))).toBe('pending')
  })
  it('up-to-date when installed matches or is newer', () => {
    expect(compareBuilds(stamp(2_000_000), stamp(2_000_000))).toBe('up-to-date')
    expect(compareBuilds(stamp(3_000_000), stamp(2_000_000))).toBe('up-to-date')
  })
  it('tolerates sub-second timestamp wobble (robocopy/FAT)', () => {
    expect(compareBuilds(stamp(2_000_000, 100_000_000), stamp(2_000_500, 100_000_000))).toBe('up-to-date')
  })
  it('a size difference at equal-or-newer mtime still counts as pending', () => {
    expect(compareBuilds(stamp(2_000_000, 47_000_000), stamp(2_000_500, 48_000_000))).toBe('pending')
  })
  it('refuses an undersized (interrupted) package', () => {
    expect(compareBuilds(stamp(1_000_000), { mtimeMs: 2_000_000, sizeBytes: 30 * 1024 * 1024 })).toBe('pending-invalid')
  })
  it('no dist build → no-pending-build; nothing installed → anything valid is pending', () => {
    expect(compareBuilds(stamp(1), null)).toBe('no-pending-build')
    expect(compareBuilds(null, stamp(1))).toBe('pending')
  })
})

describe('psQuote', () => {
  it('wraps in single quotes and doubles embedded quotes (inert in PowerShell)', () => {
    expect(psQuote('C:\\Program Files\\NordCode')).toBe("'C:\\Program Files\\NordCode'")
    expect(psQuote("C:\\it's here")).toBe("'C:\\it''s here'")
  })
})

// Self-update mirrors a Windows install via a detached PowerShell helper — a win32-only feature
// by design; the generated script embeds platform paths, so the fixture is genuinely Windows.
describe.runIf(process.platform === 'win32')('buildHelperScript', () => {
  const script = buildHelperScript({
    pid: 4242,
    distDir: 'C:\\repo with space\\dist\\win-unpacked',
    installDir: "C:\\Users\\o'brien\\AppData\\Local\\Programs\\NordCode",
    exeName: 'NordCode.exe',
    resultFile: 'C:\\tmp\\result.json'
  })

  it('waits for the app PID, mirrors the WHOLE folder, verifies the asar, records, relaunches', () => {
    expect(script).toContain('Wait-Process -Id 4242')
    expect(script).toContain("robocopy 'C:\\repo with space\\dist\\win-unpacked'")
    expect(script).toMatch(/robocopy .+ \/E \/IS \/IT/) // whole-folder mirror, never asar-only
    expect(script).toContain('$rc -lt 8') // robocopy success codes
    expect(script).toContain("Join-Path 'C:\\repo with space\\dist\\win-unpacked' 'resources\\app.asar'")
    expect(script).toContain('$distAsar -eq $instAsar') // integrity: sizes must match after the copy
    expect(script).toContain("Set-Content -Path 'C:\\tmp\\result.json'")
    expect(script).toContain("Start-Process 'C:\\Users\\o''brien\\AppData\\Local\\Programs\\NordCode\\NordCode.exe'")
  })

  it('stays PowerShell 5.1 compatible (no ternary operator)', () => {
    expect(script).not.toMatch(/\?\s*'/)
  })
})

describe('parseUpdateResult', () => {
  it('round-trips the helper output and rejects garbage', () => {
    expect(parseUpdateResult('{"ok":true,"rc":3,"at":"2026-07-02T00:00:00Z"}')).toEqual({ ok: true, rc: 3, at: '2026-07-02T00:00:00Z' })
    expect(parseUpdateResult('{"ok":false,"rc":16}')).toEqual({ ok: false, rc: 16, at: undefined })
    expect(parseUpdateResult('not json')).toBeNull()
    expect(parseUpdateResult('{"rc":1}')).toBeNull()
  })
})
