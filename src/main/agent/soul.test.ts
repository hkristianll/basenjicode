import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setSoulDir, readSoul, soulDigest, DEFAULT_SOUL, SOUL_CAP } from './soul'

describe('soul (editable identity)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'soul-'))
    setSoulDir(dir)
  })
  afterEach(() => {
    setSoulDir('')
    rmSync(dir, { recursive: true, force: true })
  })

  it('seeds the default SOUL.md on first read so the user has something to edit', () => {
    expect(existsSync(join(dir, 'SOUL.md'))).toBe(false)
    const s = readSoul()
    expect(s).toBe(DEFAULT_SOUL)
    expect(existsSync(join(dir, 'SOUL.md'))).toBe(true)
    expect(readFileSync(join(dir, 'SOUL.md'), 'utf8')).toBe(DEFAULT_SOUL)
  })

  it('reads back a user-edited identity', () => {
    writeFileSync(join(dir, 'SOUL.md'), 'You are a terse Rust expert.')
    expect(readSoul()).toBe('You are a terse Rust expert.')
  })

  it('soulDigest wraps the identity in a labeled, capped block', () => {
    writeFileSync(join(dir, 'SOUL.md'), 'Be kind.')
    const d = soulDigest()
    expect(d).toMatch(/Identity \(SOUL\.md/)
    expect(d).toContain('Be kind.')
  })

  it('hard-caps an oversized identity', () => {
    writeFileSync(join(dir, 'SOUL.md'), 'x'.repeat(SOUL_CAP + 500))
    expect(soulDigest().length).toBeLessThanOrEqual(SOUL_CAP + 100) // cap + the label wrapper
  })

  it('never touches the filesystem or seeds a stray file when no dir is configured', () => {
    setSoulDir('')
    expect(readSoul()).toBe('')
    expect(soulDigest()).toBe('')
  })
})
