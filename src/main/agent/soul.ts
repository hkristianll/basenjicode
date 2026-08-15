// SOUL — the user's editable, durable IDENTITY for the chat agent. Hermes ships a SOUL.md the user edits to
// shape the agent's persona/values; this is the NordCode parity. It is user-level (one identity across every
// project, like Brooke's memory), prepended to the chat system prompt every turn. On first use a sensible
// default is written so there is something to edit. Pure fs + best-effort (a failed read/write degrades to
// "no identity", never throws) and electron-free (main sets the dir at startup) so it unit-tests headless.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** Bounded so a long identity can't dominate the (context-clamped) chat prompt. The read hard-trims as a backstop. */
export const SOUL_CAP = 4_000

// Set once by main (ipc.ts) to app.getPath('userData'); overridden by tests to a temp dir. Kept here (not
// imported from electron) so this module is unit-testable without an Electron runtime.
let baseDir = ''
export function setSoulDir(dir: string): void {
  baseDir = dir
}
function soulPath(): string {
  return join(baseDir || '.', 'SOUL.md')
}

/** The starter identity, written on first read so the file exists for the user to edit. Complements (does not
 *  replace) the coding-agent system prompt — persona + standing preferences, not tool mechanics. */
export const DEFAULT_SOUL = `# Identity (SOUL.md)

You are the user's personal coding agent. You are persistent, direct, and resourceful: you keep working
until the task is genuinely done, you recover from errors instead of giving up, and you prefer acting
(calling tools) over narrating what you might do.

Edit this file to shape your assistant's personality, values, and standing preferences. It is prepended to
every chat, so keep it short and high-signal.
`

/**
 * The user's identity text. Creates the default file on first use (best-effort) so it's discoverable and
 * editable. Returns '' only when the dir is unset/unwritable — read as "no identity layer".
 */
export function readSoul(): string {
  // No dir configured (unit tests, or before main initialises) — never touch the filesystem / seed a stray
  // SOUL.md in the cwd. Degrade to "no identity layer".
  if (!baseDir) return ''
  try {
    const p = soulPath()
    if (!existsSync(p)) {
      try {
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, DEFAULT_SOUL)
      } catch {
        return '' // can't seed (read-only fs / unset dir) — degrade silently
      }
      return DEFAULT_SOUL
    }
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** The identity formatted for prompt injection — trimmed + hard-capped, or '' when there's nothing to add. */
export function soulDigest(): string {
  const s = readSoul().trim()
  if (!s) return ''
  return `--- Identity (SOUL.md — user-editable) ---\n${s.slice(0, SOUL_CAP)}\n--- End identity ---`
}
