import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { Workspace } from '../workspace'
import { ReadTracker, SnapshotRecorder } from '../registry'
import { writeFileTool, analyzeShrink, DESTRUCTIVE_MIN_LINES } from './writeFile'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('write_file', () => {
  it('refuses to overwrite a file changed after the agent read it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-agent-write-'))
    roots.push(root)
    const file = path.join(root, 'notes.txt')
    await fs.writeFile(file, 'original', 'utf8')
    const before = await fs.stat(file)
    const reads = new ReadTracker()
    reads.record(file, before.mtimeMs)

    await fs.writeFile(file, 'changed elsewhere', 'utf8')
    // Some filesystems have coarse timestamps; make the external change unambiguous.
    await fs.utimes(file, new Date(), new Date(before.mtimeMs + 5_000))

    const result = await writeFileTool.handler(
      { path: 'notes.txt', content: 'agent replacement' },
      { workspace: new Workspace(root), signal: new AbortController().signal, reads, snapshots: new SnapshotRecorder() }
    )

    expect(result).toContain('changed on disk since you last read it')
    expect(await fs.readFile(file, 'utf8')).toBe('changed elsewhere')
  })

  it('refuses to overwrite a file that was only range-read, not fully read', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-agent-write-'))
    roots.push(root)
    const file = path.join(root, 'big.txt')
    await fs.writeFile(file, 'line1\nline2\nline3', 'utf8')
    const st = await fs.stat(file)
    const reads = new ReadTracker()
    reads.record(file, st.mtimeMs, false) // partial/ranged read only — must NOT arm the clobber guard

    const result = await writeFileTool.handler(
      { path: 'big.txt', content: 'replacement' },
      { workspace: new Workspace(root), signal: new AbortController().signal, reads, snapshots: new SnapshotRecorder() }
    )
    expect(result).toContain('has not been fully read')
    expect(await fs.readFile(file, 'utf8')).toBe('line1\nline2\nline3') // untouched
  })

  it('allows overwrite after a full read', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-agent-write-'))
    roots.push(root)
    const file = path.join(root, 'small.txt')
    await fs.writeFile(file, 'old', 'utf8')
    const st = await fs.stat(file)
    const reads = new ReadTracker()
    reads.record(file, st.mtimeMs) // full read (default)

    const result = await writeFileTool.handler(
      { path: 'small.txt', content: 'new' },
      { workspace: new Workspace(root), signal: new AbortController().signal, reads, snapshots: new SnapshotRecorder() }
    )
    expect(result).toContain('overwritten')
    expect(await fs.readFile(file, 'utf8')).toBe('new')
  })
})

describe('write_file destructive-shrink guard', () => {
  const big = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')

  it('blocks gutting a fully-read substantial file and leaves it untouched (no work lost)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-agent-write-'))
    roots.push(root)
    const file = path.join(root, 'main.ts')
    await fs.writeFile(file, big, 'utf8')
    const st = await fs.stat(file)
    const reads = new ReadTracker()
    reads.record(file, st.mtimeMs) // fully read — the clobber + stale guards are satisfied

    const result = await writeFileTool.handler(
      { path: 'main.ts', content: 'rewritten\nfrom\nscratch' },
      { workspace: new Workspace(root), signal: new AbortController().signal, reads, snapshots: new SnapshotRecorder() }
    )
    expect(result).toContain('deleting')
    expect(result).toContain('allow_shrink')
    expect(await fs.readFile(file, 'utf8')).toBe(big) // untouched — existing work preserved
  })

  it('permits the rewrite when allow_shrink is explicitly set', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-agent-write-'))
    roots.push(root)
    const file = path.join(root, 'main.ts')
    await fs.writeFile(file, big, 'utf8')
    const st = await fs.stat(file)
    const reads = new ReadTracker()
    reads.record(file, st.mtimeMs)

    const result = await writeFileTool.handler(
      { path: 'main.ts', content: 'deliberate\nfull\nrewrite', allow_shrink: true },
      { workspace: new Workspace(root), signal: new AbortController().signal, reads, snapshots: new SnapshotRecorder() }
    )
    expect(result).toContain('overwritten')
    expect(await fs.readFile(file, 'utf8')).toBe('deliberate\nfull\nrewrite')
  })
})

describe('analyzeShrink (pure)', () => {
  const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n')
  it('flags gutting a substantial file (100 → 5)', () => {
    expect(analyzeShrink(lines(100), lines(5)).destructive).toBe(true)
  })
  it('allows growth, modest changes, and small files', () => {
    expect(analyzeShrink(lines(10), lines(200)).destructive).toBe(false) // stub → implementation
    expect(analyzeShrink(lines(100), lines(80)).destructive).toBe(false) // modest trim
    expect(analyzeShrink(lines(DESTRUCTIVE_MIN_LINES - 1), '').destructive).toBe(false) // small file
  })
  it('trips strictly below half, not at exactly half', () => {
    expect(analyzeShrink(lines(40), lines(19)).destructive).toBe(true)
    expect(analyzeShrink(lines(40), lines(20)).destructive).toBe(false)
  })
})
