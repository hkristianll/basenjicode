import { describe, it, expect } from 'vitest'
import {
  normalizeLevel,
  parseConsoleMessage,
  filterByLevel,
  formatNetworkDiagnostic,
  normalizeViewport,
  VIEWPORT_MIN,
  VIEWPORT_MAX,
  type ConsoleLine
} from './preview-util'

describe('normalizeViewport', () => {
  it('returns null when no size is asked for, so the panel is captured as-is', () => {
    expect(normalizeViewport({})).toBeNull()
    expect(normalizeViewport({ width: undefined, height: undefined })).toBeNull()
  })

  it('passes both dimensions through', () => {
    expect(normalizeViewport({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 })
  })

  it('completes a single dimension to 16:9 instead of rejecting it', () => {
    expect(normalizeViewport({ width: 1920 })).toEqual({ width: 1920, height: 1080 })
    expect(normalizeViewport({ height: 1080 })).toEqual({ width: 1920, height: 1080 })
  })

  it('clamps to the usable range', () => {
    expect(normalizeViewport({ width: 10, height: 10 })).toEqual({ width: VIEWPORT_MIN, height: VIEWPORT_MIN })
    expect(normalizeViewport({ width: 99_999, height: 99_999 })).toEqual({ width: VIEWPORT_MAX, height: VIEWPORT_MAX })
  })

  it('ignores junk values rather than emulating a zero-size viewport', () => {
    expect(normalizeViewport({ width: 0, height: 0 })).toBeNull()
    expect(normalizeViewport({ width: -800 })).toBeNull()
    expect(normalizeViewport({ width: Number.NaN })).toBeNull()
    expect(normalizeViewport({ width: '1920' as unknown as number })).toBeNull()
  })

  it('rounds fractional sizes', () => {
    expect(normalizeViewport({ width: 1280.6, height: 720.4 })).toEqual({ width: 1281, height: 720 })
  })
})

describe('normalizeLevel', () => {
  it('maps Electron ≥36 string levels', () => {
    expect(normalizeLevel('error')).toBe('error')
    expect(normalizeLevel('warning')).toBe('warning')
    expect(normalizeLevel('warn')).toBe('warning')
    expect(normalizeLevel('info')).toBe('info')
    expect(normalizeLevel('debug')).toBe('debug')
    expect(normalizeLevel('verbose')).toBe('debug')
    expect(normalizeLevel('log')).toBe('log')
    expect(normalizeLevel('something-else')).toBe('log')
  })

  it('maps legacy numeric levels', () => {
    expect(normalizeLevel(0)).toBe('debug')
    expect(normalizeLevel(1)).toBe('log') // info bucket → 'log' default
    expect(normalizeLevel(2)).toBe('warning')
    expect(normalizeLevel(3)).toBe('error')
  })

  it('falls back to log for junk', () => {
    expect(normalizeLevel(undefined)).toBe('log')
    expect(normalizeLevel(null)).toBe('log')
    expect(normalizeLevel({})).toBe('log')
  })
})

describe('parseConsoleMessage', () => {
  it('reads the Electron ≥36 single-object form', () => {
    const r = parseConsoleMessage([{ level: 'error', message: 'boom', lineNumber: 4 }])
    expect(r).toEqual({ level: 'error', message: 'boom' })
  })

  it('reads the legacy positional form (event, level, message)', () => {
    const r = parseConsoleMessage([{ preventDefault() {} }, 2, 'careful', 10, 'app.js'])
    expect(r).toEqual({ level: 'warning', message: 'careful' })
  })

  it('coerces a missing message to an empty string', () => {
    const r = parseConsoleMessage([{ preventDefault() {} }, 3])
    expect(r).toEqual({ level: 'error', message: '' })
  })
})

describe('filterByLevel', () => {
  const lines: ConsoleLine[] = [
    { ts: 1, level: 'debug', message: 'd' },
    { ts: 2, level: 'log', message: 'l' },
    { ts: 3, level: 'info', message: 'i' },
    { ts: 4, level: 'warning', message: 'w' },
    { ts: 5, level: 'error', message: 'e' }
  ]

  it('returns everything when no minimum is given', () => {
    expect(filterByLevel(lines)).toHaveLength(5)
  })

  it('keeps only warning and above', () => {
    expect(filterByLevel(lines, 'warning').map((l) => l.message)).toEqual(['w', 'e'])
  })

  it('keeps only errors', () => {
    expect(filterByLevel(lines, 'error').map((l) => l.message)).toEqual(['e'])
  })

  it('treats info and log as the same rank', () => {
    expect(filterByLevel(lines, 'info').map((l) => l.message)).toEqual(['l', 'i', 'w', 'e'])
  })
})

describe('formatNetworkDiagnostic', () => {
  it('reports failed requests without leaking query values', () => {
    expect(
      formatNetworkDiagnostic({
        method: 'GET',
        resourceType: 'xhr',
        url: 'http://localhost:5173/api/items?token=secret',
        statusCode: 500
      })
    ).toBe('[network] GET xhr http://localhost:5173/api/items?… returned HTTP 500')
  })

  it('reports transport failures and ignores ordinary completions/navigation aborts', () => {
    expect(
      formatNetworkDiagnostic({ method: 'POST', resourceType: 'fetch', url: 'http://localhost/api', error: 'net::ERR_CONNECTION_REFUSED' })
    ).toContain('failed (net::ERR_CONNECTION_REFUSED)')
    expect(formatNetworkDiagnostic({ resourceType: 'script', url: 'http://localhost/app.js', statusCode: 200 })).toBeNull()
    expect(formatNetworkDiagnostic({ resourceType: 'script', url: 'http://localhost/app.js', error: 'net::ERR_ABORTED' })).toBeNull()
    expect(formatNetworkDiagnostic({ resourceType: 'mainFrame', url: 'http://localhost/', statusCode: 500 })).toBeNull()
  })
})
