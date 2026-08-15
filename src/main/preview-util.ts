/**
 * Pure helpers for the preview service — kept electron-free so they can be unit-tested
 * (importing preview.ts pulls in `electron`, which isn't available under vitest).
 */

export type ConsoleLevel = 'log' | 'info' | 'warning' | 'error' | 'debug'

export interface ConsoleLine {
  ts: number
  level: ConsoleLevel
  message: string
}

export const LEVEL_RANK: Record<ConsoleLevel, number> = { debug: 0, log: 1, info: 1, warning: 2, error: 3 }

/** Map Electron's string ('info'|'warning'|'error'|'debug') or legacy numeric level to ours. */
export function normalizeLevel(raw: unknown): ConsoleLevel {
  if (typeof raw === 'string') {
    const s = raw.toLowerCase()
    if (s === 'error') return 'error'
    if (s === 'warning' || s === 'warn') return 'warning'
    if (s === 'debug' || s === 'verbose') return 'debug'
    if (s === 'info') return 'info'
    return 'log'
  }
  // Legacy numeric: 0 verbose/log, 1 info, 2 warning, 3 error.
  switch (raw) {
    case 3:
      return 'error'
    case 2:
      return 'warning'
    case 0:
      return 'debug'
    default:
      return 'log'
  }
}

/**
 * Normalize the variadic args Electron passes to a `console-message` handler.
 * Electron ≥36 passes a single object `{ level, message, ... }`; older versions pass
 * positional `(event, level: number, message: string, ...)`.
 */
export function parseConsoleMessage(args: unknown[]): { level: ConsoleLevel; message: string } {
  const first = args[0] as Record<string, unknown> | undefined
  if (first && typeof first === 'object' && typeof first['message'] === 'string') {
    return { level: normalizeLevel(first['level']), message: first['message'] as string }
  }
  return { level: normalizeLevel(args[1]), message: String(args[2] ?? '') }
}

/** Keep only messages at `min` level or above (error > warning > info/log > debug). */
export function filterByLevel(lines: ConsoleLine[], min?: ConsoleLevel): ConsoleLine[] {
  if (!min) return lines
  const rank = LEVEL_RANK[min]
  return lines.filter((l) => LEVEL_RANK[l.level] >= rank)
}
