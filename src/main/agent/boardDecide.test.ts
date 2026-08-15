import { describe, it, expect } from 'vitest'
import { isUnverified, decideTerminal } from './boardDecide'

describe('isUnverified', () => {
  it('true when there is neither a check nor a reviewer (no evidence → never auto-done)', () => {
    expect(isUnverified(undefined, false)).toBe(true)
    expect(isUnverified('', false)).toBe(true)
    expect(isUnverified('   ', false)).toBe(true)
    expect(isUnverified(null, false)).toBe(true)
  })
  it('false when a check exists', () => {
    expect(isUnverified('npm test', false)).toBe(false)
  })
  it('false when a reviewer is configured', () => {
    expect(isUnverified(undefined, true)).toBe(false)
  })
})

describe('decideTerminal (gate authority)', () => {
  it('no check → review, never done', () => {
    expect(decideTerminal({ attemptsSoFar: 1, maxAttempts: 3 })).toEqual({ kind: 'review' })
  })
  it('passing check → done in auto mode', () => {
    expect(decideTerminal({ check: 'npm test', outcome: { passed: true, code: 0, timedOut: false }, attemptsSoFar: 1, maxAttempts: 3 })).toEqual({ kind: 'done' })
  })
  it('failing check with attempts left → iterate', () => {
    expect(decideTerminal({ check: 'npm test', outcome: { passed: false, code: 1, timedOut: false }, attemptsSoFar: 1, maxAttempts: 3 })).toEqual({ kind: 'iterate', attempt: 2 })
  })
  it('failing check at the cap → park', () => {
    const t = decideTerminal({ check: 'npm test', outcome: { passed: false, code: 1, timedOut: false }, attemptsSoFar: 3, maxAttempts: 3 })
    expect(t.kind).toBe('park')
  })
  it('R4: a structurally-broken check parks immediately (check-broken), before burning attempts', () => {
    const t = decideTerminal({ check: 'test -f dist/app.js', outcome: { passed: false, code: 1, timedOut: false }, attemptsSoFar: 1, maxAttempts: 3 })
    expect(t.kind).toBe('park')
    if (t.kind === 'park') expect(t.reason).toContain('check-broken')
  })
  it('R4: a valid failing check still iterates (not misclassified as check-broken)', () => {
    expect(decideTerminal({ check: 'npx tsc --noEmit', outcome: { passed: false, code: 1, timedOut: false }, attemptsSoFar: 1, maxAttempts: 3 })).toEqual({ kind: 'iterate', attempt: 2 })
  })
})
