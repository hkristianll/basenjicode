import { describe, it, expect } from 'vitest'
import { applyEdit, applyEdits, countOccurrences } from './editing'

describe('countOccurrences', () => {
  it('counts non-overlapping occurrences; empty needle is 0', () => {
    expect(countOccurrences('a.b.a.b', 'a')).toBe(2)
    expect(countOccurrences('aaaa', 'aa')).toBe(2)
    expect(countOccurrences('x', '')).toBe(0)
  })
})

describe('applyEdit', () => {
  it('replaces a unique occurrence', () => {
    const r = applyEdit('const PORT = 3000', { old_string: '3000', new_string: '8080' })
    expect(r).toEqual({ updated: 'const PORT = 8080' })
  })

  it('errors when old_string is missing', () => {
    const r = applyEdit('abc', { old_string: 'zzz', new_string: 'x' })
    expect('error' in r && r.error).toMatch(/not found/)
  })

  it('errors on multiple matches without replace_all', () => {
    const r = applyEdit('a a a', { old_string: 'a', new_string: 'b' })
    expect('error' in r && r.error).toMatch(/matched 3 times/)
  })

  it('replaces every match with replace_all', () => {
    const r = applyEdit('a a a', { old_string: 'a', new_string: 'b', replace_all: true })
    expect(r).toEqual({ updated: 'b b b' })
  })

  it('rejects identical and empty old_string', () => {
    expect('error' in applyEdit('x', { old_string: 'x', new_string: 'x' })).toBe(true)
    expect('error' in applyEdit('x', { old_string: '', new_string: 'y' })).toBe(true)
  })
})

describe('applyEdits', () => {
  it('applies edits in sequence, each seeing the previous result', () => {
    const r = applyEdits('foo', [
      { old_string: 'foo', new_string: 'bar' },
      { old_string: 'bar', new_string: 'baz' }
    ])
    expect(r).toEqual({ updated: 'baz', applied: 2 })
  })

  it('stops at the first failing edit and reports its index', () => {
    const r = applyEdits('foo', [
      { old_string: 'foo', new_string: 'bar' },
      { old_string: 'nope', new_string: 'x' }
    ])
    expect('error' in r && r.error).toMatch(/^edit 2\/2:/)
  })
})
