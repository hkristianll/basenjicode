import { describe, it, expect } from 'vitest'
import { buildSeedMessage } from './boardSeed'

const ticket = { title: 'Build the parser', body: 'Parse the thing', check: 'npm test', spec_ref: 'board:proj' }

describe('buildSeedMessage', () => {
  it('includes title + body, and the spec when spec_ref is set', () => {
    const msg = buildSeedMessage(ticket, '# the spec')
    expect(msg).toContain('Build the parser')
    expect(msg).toContain('Parse the thing')
    expect(msg).toContain('# the spec')
    expect(msg).toContain('Verification check (must pass)')
    expect(msg).toContain('npm test')
  })

  it('injects prior progress so a resumed ticket continues instead of restarting', () => {
    const msg = buildSeedMessage(ticket, null, undefined, undefined, 'Done: lexer. TODO: parser, tests.')
    expect(msg).toContain('Progress so far')
    expect(msg).toContain('TODO: parser, tests')
  })

  it('omits the progress section when there is none', () => {
    expect(buildSeedMessage(ticket, null)).not.toContain('Progress so far')
  })

  it('keeps revision feedback after the progress (last word on a retry)', () => {
    const msg = buildSeedMessage(ticket, null, { attempt: 2, feedback: 'fix the edge case' }, undefined, 'earlier progress')
    expect(msg.indexOf('Progress so far')).toBeLessThan(msg.indexOf('Revision'))
  })

  it("injects the team lead's brief when provided (team-leads Phase 3)", () => {
    const msg = buildSeedMessage(ticket, '# spec', undefined, undefined, null, '- mock the clock with fake timers')
    expect(msg).toContain("team lead's brief")
    expect(msg).toContain('mock the clock with fake timers')
  })

  it('omits the lead-brief section when there is none', () => {
    expect(buildSeedMessage(ticket, '# spec')).not.toContain("team lead's brief")
  })
})
