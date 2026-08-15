import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTeamMemory, writeTeamMemory, sanitizeTeamMemory, isOverCap, TEAM_MEMORY_CAP } from './teamMemory'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'teammem-'))
})
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('teamMemory', () => {
  it('reads empty for a team with no memory yet', () => {
    expect(readTeamMemory(dir, 'testing')).toBe('')
  })

  it('round-trips a write, isolated per department', () => {
    writeTeamMemory(dir, 'design', '- reuse the shared tokens, do not hardcode colors\n')
    expect(readTeamMemory(dir, 'design')).toBe('- reuse the shared tokens, do not hardcode colors\n')
    expect(readTeamMemory(dir, 'testing')).toBe('') // a different dept is untouched
  })

  it('hard-caps stored content as a backstop', () => {
    writeTeamMemory(dir, 'implementation', 'x'.repeat(TEAM_MEMORY_CAP + 500))
    expect(readTeamMemory(dir, 'implementation').length).toBe(TEAM_MEMORY_CAP)
  })

  it('isOverCap flags when the lead should summarize instead of append', () => {
    expect(isOverCap('short note')).toBe(false)
    expect(isOverCap('x'.repeat(TEAM_MEMORY_CAP))).toBe(true)
  })

  it('an unwritable path degrades to empty, never throws', () => {
    writeFileSync(join(dir, 'blocker'), 'x')
    const bogus = join(dir, 'blocker', 'under') // parent is a FILE → internal mkdir/read fail, swallowed
    expect(() => writeTeamMemory(bogus, 'docs', 'hi')).not.toThrow()
    expect(readTeamMemory(bogus, 'docs')).toBe('')
  })
})

describe('sanitizeTeamMemory (R11)', () => {
  it('keeps legit craft bullets verbatim (never drops a `- bullet`)', () => {
    const m = '- mock the clock with vi.useFakeTimers\n- the runner exits 0 on no tests'
    expect(sanitizeTeamMemory(m)).toBe(m)
  })
  it('strips code fences, diff headers, and meta-instructions but keeps real bullets', () => {
    const m = ['- keep this real bullet', '```ts', '```', '--- a/foo.ts', '+++ b/foo.ts', '@@ -1,2 +1,2 @@', 'rewrite everything from scratch'].join('\n')
    const out = sanitizeTeamMemory(m)
    expect(out).toContain('- keep this real bullet')
    expect(out).not.toContain('```')
    expect(out).not.toContain('a/foo.ts')
    expect(out).not.toContain('@@')
    expect(out).not.toMatch(/rewrite everything/i)
  })
  it('drops near-duplicate bullets (case/punctuation-insensitive)', () => {
    expect(sanitizeTeamMemory('- use the shared fixture\n- Use the shared fixture.')).toBe('- use the shared fixture')
  })
  it('returns empty for all-junk so writeTeamMemory leaves memory unchanged', () => {
    const allJunk = '```\n```\n@@ x @@'
    expect(sanitizeTeamMemory(allJunk).trim()).toBe('')
    writeTeamMemory(dir, 'docs', allJunk)
    expect(readTeamMemory(dir, 'docs')).toBe('') // nothing persisted
  })
})
