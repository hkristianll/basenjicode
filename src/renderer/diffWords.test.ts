import { describe, it, expect } from 'vitest'
import { parseDiffRows, wordDiff, pairWordDiffs } from './diffWords'

describe('wordDiff', () => {
  it('highlights only the changed token on each side', () => {
    const { del, add } = wordDiff('const x = 1', 'const x = 2')
    expect(del.filter((s) => s.changed).map((s) => s.text).join('')).toBe('1')
    expect(add.filter((s) => s.changed).map((s) => s.text).join('')).toBe('2')
    expect(del.filter((s) => !s.changed).map((s) => s.text).join('')).toBe('const x = ')
    expect(add.filter((s) => !s.changed).map((s) => s.text).join('')).toBe('const x = ')
  })

  it('marks every segment changed when nothing is shared', () => {
    const { del, add } = wordDiff('foo', 'bar')
    expect(del.every((s) => s.changed)).toBe(true)
    expect(add.every((s) => s.changed)).toBe(true)
  })

  it('reconstructs each line exactly from its segments', () => {
    const oldL = 'a.method(oldArg, keep)'
    const newL = 'a.method(newArg, keep)'
    const { del, add } = wordDiff(oldL, newL)
    expect(del.map((s) => s.text).join('')).toBe(oldL)
    expect(add.map((s) => s.text).join('')).toBe(newL)
  })
})

describe('parseDiffRows', () => {
  const unified = ['@@ -10,3 +10,3 @@', ' ctx line', '-old line', '+new line', ' tail'].join('\n')
  it('assigns classes, signs, and gutters from the hunk header', () => {
    const rows = parseDiffRows(unified)
    expect(rows.map((r) => r.cls)).toEqual(['hunk', 'ctx', 'del', 'add', 'ctx'])
    expect(rows[2].sign).toBe('-')
    expect(rows[3].sign).toBe('+')
    expect(rows[2].gutter).toBe('11') // old line: 10 (ctx) then 11 (del)
    expect(rows[3].gutter).toBe('11') // new line: 10 (ctx) then 11 (add)
    expect(rows[2].content).toBe('old line')
    expect(rows[3].content).toBe('new line')
  })
})

describe('pairWordDiffs', () => {
  it('word-diffs a del immediately followed by an add', () => {
    const rows = parseDiffRows(['@@ -1,1 +1,1 @@', '-let a = 1', '+let a = 2'].join('\n'))
    const map = pairWordDiffs(rows)
    expect(map.has(1)).toBe(true) // the del row
    expect(map.has(2)).toBe(true) // the add row
    expect(map.get(2)!.filter((s) => s.changed).map((s) => s.text).join('')).toBe('2')
  })

  it('leaves a pure addition untouched (no false modification)', () => {
    const rows = parseDiffRows(['@@ -1,0 +1,1 @@', '+brand new line'].join('\n'))
    const map = pairWordDiffs(rows)
    expect(map.size).toBe(0)
  })
})
