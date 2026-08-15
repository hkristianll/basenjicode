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

export interface Viewport {
  width: number
  height: number
}

/** Guard rails for an emulated viewport: below MIN nothing lays out, above MAX the PNG gets huge. */
export const VIEWPORT_MIN = 240
export const VIEWPORT_MAX = 4096

function clampDim(v: number): number {
  return Math.min(VIEWPORT_MAX, Math.max(VIEWPORT_MIN, Math.round(v)))
}

function usableDim(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? clampDim(v) : null
}

/**
 * Resolve the viewport a screenshot should render at. Returns null when neither dimension was
 * given — meaning "capture the Preview panel at whatever size it happens to be", the old behaviour.
 *
 * A single dimension is completed to 16:9 rather than rejected: the model usually asks in the form
 * "check it at 1920", and bouncing that back to ask for a second number costs a whole turn.
 */
export function normalizeViewport(opts: { width?: number; height?: number }): Viewport | null {
  const w = usableDim(opts.width)
  const h = usableDim(opts.height)
  if (w === null && h === null) return null
  if (w !== null && h !== null) return { width: w, height: h }
  if (w !== null) return { width: w, height: clampDim((w * 9) / 16) }
  return { width: clampDim((h as number) * (16 / 9)), height: h as number }
}

/** Keep only messages at `min` level or above (error > warning > info/log > debug). */
export function filterByLevel(lines: ConsoleLine[], min?: ConsoleLevel): ConsoleLine[] {
  if (!min) return lines
  const rank = LEVEL_RANK[min]
  return lines.filter((l) => LEVEL_RANK[l.level] >= rank)
}
