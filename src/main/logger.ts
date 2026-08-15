import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

let logFile: string | null = null

const MAX_LOG_BYTES = 10 * 1024 * 1024 // cap main.log at 10MB, then roll over (safety net vs any runaway)
let logBytes = 0 // in-memory size tracker so we don't statSync on every (hot-path) write

function resolveFile(): string {
  if (!logFile) {
    const dir = app.getPath('logs')
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* ignore */
    }
    logFile = path.join(dir, 'main.log')
    try {
      logBytes = fs.statSync(logFile).size // seed from the existing file so we rotate even after a restart
    } catch {
      logBytes = 0
    }
  }
  return logFile
}

/** Roll main.log → main.log.1 (overwriting the previous backup) once it exceeds the cap, so a single
 *  log file can never grow without bound — bounded disk use even if something logs in a tight loop. */
function rotateIfNeeded(file: string): void {
  if (logBytes < MAX_LOG_BYTES) return
  try {
    fs.renameSync(file, `${file}.1`) // keep one previous segment; older .1 is overwritten
  } catch {
    try {
      fs.truncateSync(file, 0) // rename failed (e.g. .1 locked) — just clear the active file
    } catch {
      /* ignore */
    }
  }
  logBytes = 0
}

function fmt(a: unknown): string {
  if (a instanceof Error) return `${a.message}${a.stack ? `\n${a.stack}` : ''}`
  if (typeof a === 'object' && a !== null) {
    try {
      return JSON.stringify(a)
    } catch {
      return String(a)
    }
  }
  return String(a)
}

/** Append a line to %APPDATA%/<app>/logs/main.log and mirror to the console. */
export function log(level: 'INFO' | 'ERROR', ...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${level} ${args.map(fmt).join(' ')}\n`
  try {
    const file = resolveFile()
    rotateIfNeeded(file)
    fs.appendFileSync(file, line)
    logBytes += Buffer.byteLength(line)
  } catch {
    /* logging must never throw */
  }
  // Mirror to the console, but NEVER let a broken stdout/stderr pipe throw: an uncaught EPIPE here
  // re-enters the uncaughtException handler, which logs again → another broken-pipe write → an infinite
  // ~2000/sec error storm that fills the disk. Swallow any console-write failure.
  try {
    if (level === 'ERROR') console.error(...args)
    else console.log(...args)
  } catch {
    /* console pipe closed (EPIPE) — already persisted to file above */
  }
}
