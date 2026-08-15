// Brooke's DURABLE, CROSS-PROJECT memory — the group manager's learning loop. Team memory (teamMemory.ts) is
// per-department AND per-project (lives in a work folder); it's lost when the project changes. Brooke's planning
// craft — "a Phaser scaffold check must not bundle npm install", "give each entity its own file", "a reasoning
// model loops on scaffolds" — GENERALIZES across projects, so it lives globally in userData and is injected into her
// seed every run. She grows it herself via the `remember` tool. Reuses teamMemory's sanitizer (dedupe + junk strip)
// so a weak manager model can't poison it. Pure fs + best-effort (a failed read/write degrades to "no memory",
// never throws) and electron-free (main sets the dir at startup) so it unit-tests headless.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { sanitizeTeamMemory } from './teamMemory'

/** Bounded so Brooke's memory never balloons her (already context-clamped) seed. Over the cap she should be nudged
 *  to consolidate; the write also hard-trims as a backstop. Larger than a team's (4k) — she carries cross-project craft. */
export const MANAGER_MEMORY_CAP = 6_000

// Set once by main (ipc.ts) to app.getPath('userData'); overridden by tests to a temp dir. Kept here (not imported
// from electron) so this module is unit-testable without an Electron runtime.
let baseDir = ''
export function setManagerMemoryDir(dir: string): void {
  baseDir = dir
}
function managerMemoryPath(): string {
  return join(baseDir || '.', 'brooke-memory.md')
}

/** Brooke's accumulated memory, or '' when none/unreadable (reads as "nothing learned yet"). */
export function readManagerMemory(): string {
  try {
    const p = managerMemoryPath()
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  } catch {
    return ''
  }
}

/**
 * Append a durable lesson to Brooke's memory as a bullet, then sanitize (dedupe + junk strip) and hard-cap the whole
 * store. Returns the new memory text. Best-effort: a failed write returns the current memory unchanged. Empty/blank
 * notes are no-ops. A note may itself be multi-line (she can record a small structured lesson).
 */
export function appendManagerMemory(note: string): string {
  const add = note.trim()
  if (!add) return readManagerMemory()
  try {
    const current = readManagerMemory()
    // Prefix new content with a bullet only when it isn't already bulleted, so her own formatting round-trips.
    const bulleted = /^\s*[-*]/.test(add) ? add : `- ${add}`
    const merged = sanitizeTeamMemory(`${current}\n${bulleted}`.replace(/^\n+/, '')).slice(0, MANAGER_MEMORY_CAP)
    const p = managerMemoryPath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, merged)
    return merged
  } catch {
    return readManagerMemory()
  }
}

/** Overwrite Brooke's memory wholesale (sanitized + capped) — used to SEED it or let her consolidate. Best-effort. */
export function writeManagerMemory(content: string): void {
  const clean = sanitizeTeamMemory(content).slice(0, MANAGER_MEMORY_CAP)
  try {
    const p = managerMemoryPath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, clean)
  } catch {
    /* best-effort */
  }
}
