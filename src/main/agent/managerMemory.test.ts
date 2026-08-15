import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setManagerMemoryDir, readManagerMemory, appendManagerMemory, writeManagerMemory, MANAGER_MEMORY_CAP } from './managerMemory'

describe('managerMemory — Brooke\'s durable cross-project learning store', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'brooke-mem-'))
    setManagerMemoryDir(dir)
  })
  afterEach(() => {
    setManagerMemoryDir('')
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads empty when nothing has been learned yet', () => {
    expect(readManagerMemory()).toBe('')
  })

  it('appends a lesson as a bullet and persists it to disk (survives the "next run")', () => {
    appendManagerMemory('A Phaser scaffold check must not bundle npm install into one boolean')
    const mem = readManagerMemory()
    expect(mem).toContain('- A Phaser scaffold check must not bundle npm install into one boolean')
    expect(existsSync(join(dir, 'brooke-memory.md'))).toBe(true)
    // A FRESH read (as a new run would do) sees it.
    expect(readManagerMemory()).toContain('npm install')
  })

  it('accumulates multiple lessons across calls', () => {
    appendManagerMemory('give each entity its own file')
    appendManagerMemory('a reasoning model loops on scaffolds')
    const mem = readManagerMemory()
    expect(mem).toContain('give each entity its own file')
    expect(mem).toContain('a reasoning model loops on scaffolds')
  })

  it('dedupes a near-identical lesson (sanitizer) so memory does not bloat with repeats', () => {
    appendManagerMemory('scope the tsc check to declared files')
    appendManagerMemory('Scope the tsc check to declared files.') // same idea, different casing/punct
    const bullets = readManagerMemory().split('\n').filter((l) => l.trim().startsWith('-'))
    expect(bullets.length).toBe(1)
  })

  it('respects an already-bulleted note (no double bullet)', () => {
    appendManagerMemory('- already a bullet')
    expect(readManagerMemory()).toContain('- already a bullet')
    expect(readManagerMemory()).not.toContain('- - already a bullet')
  })

  it('blank notes are no-ops', () => {
    appendManagerMemory('   ')
    expect(readManagerMemory()).toBe('')
  })

  it('hard-caps the store so it can never balloon her seed', () => {
    writeManagerMemory('- ' + 'x'.repeat(MANAGER_MEMORY_CAP + 2_000))
    expect(readManagerMemory().length).toBeLessThanOrEqual(MANAGER_MEMORY_CAP)
  })

  it('writeManagerMemory overwrites wholesale (for seeding / consolidation)', () => {
    appendManagerMemory('old lesson')
    writeManagerMemory('- fresh seeded lesson')
    expect(readManagerMemory()).toContain('fresh seeded lesson')
    expect(readManagerMemory()).not.toContain('old lesson')
  })

  it('degrades to empty (never throws) when the dir is unwritable/unset', () => {
    setManagerMemoryDir('') // no base dir
    expect(() => appendManagerMemory('x')).not.toThrow()
  })

  it('a pre-existing memory file (a prior session) is read on startup', () => {
    writeFileSync(join(dir, 'brooke-memory.md'), '- carried over from last run')
    expect(readManagerMemory()).toContain('carried over from last run')
  })
})
