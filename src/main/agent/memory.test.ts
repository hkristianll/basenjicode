import { describe, it, expect } from 'vitest'
import { applyRemember, applyForget, rankEntries, MAX_ENTRIES, MAX_TOTAL_CHARS } from './memory'

describe('applyRemember — anti-bloat caps', () => {
  it('appends a new fact', () => {
    const { entries, note } = applyRemember(['a', 'b'], 'c')
    expect(entries).toEqual(['a', 'b', 'c'])
    expect(note).toBe('')
  })

  it('dedups a near-identical fact (whitespace/case-insensitive) and moves it to the end', () => {
    const { entries, note } = applyRemember(['First fact', 'second'], '  first   FACT ')
    expect(entries).toEqual(['second', 'first FACT']) // old dropped, normalised re-add at end
    expect(entries).toHaveLength(2) // no duplicate stacked
    expect(note).toContain('updated an existing similar entry')
  })

  it('evicts the oldest when the entry-count cap is exceeded (FIFO)', () => {
    const full = Array.from({ length: MAX_ENTRIES }, (_, i) => `fact ${i}`)
    const { entries, note } = applyRemember(full, 'newest')
    expect(entries).toHaveLength(MAX_ENTRIES)
    expect(entries[0]).toBe('fact 1') // 'fact 0' evicted
    expect(entries[entries.length - 1]).toBe('newest')
    expect(note).toContain('memory was full')
  })

  it('evicts oldest until under the total-size cap when entries are large', () => {
    // Enough ~195-char entries to blow past MAX_TOTAL_CHARS but stay under MAX_ENTRIES, so the SIZE cap
    // (not the count cap) is what trips.
    const n = Math.min(MAX_ENTRIES - 1, Math.ceil(MAX_TOTAL_CHARS / 195) + 5)
    const big = Array.from({ length: n }, (_, i) => `e${i} ` + 'x'.repeat(189))
    const { entries } = applyRemember(big, 'small new fact')
    const total = entries.reduce((acc, e) => acc + e.length + 3, 0)
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_CHARS)
    expect(entries[entries.length - 1]).toBe('small new fact')
  })
})

describe('rankEntries — relevance + recency retrieval', () => {
  const entries = ['uses Vite for bundling', 'auth via JWT tokens', 'tests run with vitest', 'CRLF line endings on Windows']

  it('surfaces entries matching the query first', () => {
    expect(rankEntries(entries, 'how does the bundling step work', 2)).toContain('uses Vite for bundling')
  })

  it('falls back to the most recent k for an empty or term-less query', () => {
    expect(rankEntries(entries, '', 2)).toEqual(['tests run with vitest', 'CRLF line endings on Windows'])
    expect(rankEntries(entries, 'a an the', 2)).toEqual(['tests run with vitest', 'CRLF line endings on Windows'])
  })

  it('returns at most k, in chronological order', () => {
    const r = rankEntries(entries, 'vite jwt windows', 3)
    expect(r).toHaveLength(3)
    expect(r).toEqual(entries.filter((e) => r.includes(e))) // chronological among the selected
  })

  it('no entries → empty', () => {
    expect(rankEntries([], 'anything', 5)).toEqual([])
  })
})

describe('applyForget', () => {
  it('removes every entry containing the query (case-insensitive)', () => {
    const { entries, removed } = applyForget(['uses Vite', 'uses vitest', 'unrelated'], 'vite')
    expect(removed).toEqual(['uses Vite', 'uses vitest'])
    expect(entries).toEqual(['unrelated'])
  })

  it('no-ops on an empty query', () => {
    const { entries, removed } = applyForget(['a', 'b'], '   ')
    expect(removed).toEqual([])
    expect(entries).toEqual(['a', 'b'])
  })
})
