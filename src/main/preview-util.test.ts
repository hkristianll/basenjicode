import { describe, it, expect } from 'vitest'
import { normalizeLevel, parseConsoleMessage, filterByLevel, type ConsoleLine } from './preview-util'

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
