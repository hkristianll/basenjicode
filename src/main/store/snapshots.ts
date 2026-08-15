import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { writeJsonAtomic } from './settings'

export interface FileEdit {
  path: string
  before: string | null
}

function snapFile(sessionId: string, turnId: string): string {
  return path.join(app.getPath('userData'), 'snapshots', sessionId, `${turnId}.json`)
}

export function saveSnapshot(sessionId: string, turnId: string, edits: FileEdit[]): void {
  if (!edits.length) return
  writeJsonAtomic(snapFile(sessionId, turnId), edits)
}

export function loadSnapshot(sessionId: string, turnId: string): FileEdit[] | null {
  try {
    const v = JSON.parse(fs.readFileSync(snapFile(sessionId, turnId), 'utf8'))
    return Array.isArray(v) ? (v as FileEdit[]) : null
  } catch {
    return null
  }
}

export function deleteSnapshot(sessionId: string, turnId: string): void {
  try {
    fs.rmSync(snapFile(sessionId, turnId))
  } catch {
    /* ignore */
  }
}

/** Remove a session's entire snapshot directory — call when the session itself is deleted so per-turn
 *  snapshot files don't leak on disk forever. */
export function deleteSessionSnapshots(sessionId: string): void {
  try {
    fs.rmSync(path.join(app.getPath('userData'), 'snapshots', sessionId), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
