import { describe, it, expect } from 'vitest'
import { decideReview, parseVerdict } from './boardReview'

describe('decideReview', () => {
  it('approved → done', () => {
    expect(decideReview({ approved: true, attemptsSoFar: 1, maxAttempts: 3 })).toEqual({ kind: 'done' })
  })
  it('rejected below the cap → iterate to the next attempt', () => {
    expect(decideReview({ approved: false, attemptsSoFar: 1, maxAttempts: 3 })).toEqual({ kind: 'iterate', attempt: 2 })
  })
  it('rejected at the cap → park, reason names the rounds', () => {
    const d = decideReview({ approved: false, attemptsSoFar: 3, maxAttempts: 3 })
    expect(d.kind).toBe('park')
    if (d.kind === 'park') expect(d.reason).toContain('3 review rounds')
  })
})

describe('parseVerdict', () => {
  it('reads a JSON verdict', () => {
    expect(parseVerdict('Here is my review: {"approved": false, "feedback": "missing tests"}')).toEqual({
      approved: false,
      feedback: 'missing tests'
    })
  })
  it('reads an approving JSON verdict', () => {
    expect(parseVerdict('{"approved": true, "feedback": "looks good"}')).toEqual({ approved: true, feedback: 'looks good' })
  })
  it('falls back to a keyword heuristic, defaulting to NOT approved when unsure', () => {
    expect(parseVerdict('I request changes: the function is incomplete.').approved).toBe(false)
    expect(parseVerdict('This looks complete and correct — approved.').approved).toBe(true)
    expect(parseVerdict('hmm, unclear rambling with no verdict').approved).toBe(false)
  })
  it('R10: a brace inside the feedback string does not truncate the verdict JSON', () => {
    const v = parseVerdict('{"approved": true, "feedback": "use a { brace } in the output"}')
    expect(v.approved).toBe(true)
    expect(v.feedback).toBe('use a { brace } in the output')
  })
  it('R10: a stray brace-object before the verdict does not capture it', () => {
    const v = parseVerdict('example: {"foo": 1}\nverdict: {"approved": true, "feedback": "ok"}')
    expect(v.approved).toBe(true)
    expect(v.feedback).toBe('ok')
  })
  it('R10: heuristic no longer flips an approving "does not break anything" to rejected', () => {
    expect(parseVerdict('Approved. This change does not break anything.').approved).toBe(true)
  })

  it('extracts a <memory> block, decoupled from the verdict JSON (team-leads Phase 2)', () => {
    const v = parseVerdict('{"approved": true, "feedback": "ok"}\n<memory>- mock the clock with vi.useFakeTimers\n- runner exits 0 on no tests</memory>')
    expect(v.approved).toBe(true)
    expect(v.feedback).toBe('ok')
    expect(v.memoryUpdate).toBe('- mock the clock with vi.useFakeTimers\n- runner exits 0 on no tests')
  })

  it('leaves memoryUpdate undefined when there is no <memory> block', () => {
    expect(parseVerdict('{"approved": true, "feedback": "ok"}').memoryUpdate).toBeUndefined()
  })

  it('recovers the <memory> block even when the verdict JSON is malformed (decoupled)', () => {
    const v = parseVerdict('approved! but the json is broken { oops <memory>- keep using the shared fixture</memory>')
    expect(v.memoryUpdate).toBe('- keep using the shared fixture')
  })
})
