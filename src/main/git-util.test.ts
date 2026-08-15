import { describe, it, expect } from 'vitest'
import { parsePorcelainZ, parseNumstatZ, buildGitFiles } from './git-util'

describe('parsePorcelainZ', () => {
  it('parses a plain modified + untracked entry', () => {
    const out = ' M src/a.ts\0?? new.txt\0'
    expect(parsePorcelainZ(out)).toEqual([
      { code: ' M', path: 'src/a.ts' },
      { code: '??', path: 'new.txt' }
    ])
  })

  it('handles a rename: keeps the destination, skips the source field', () => {
    // `R  <dest>\0<source>\0`
    const out = 'R  dest/new.ts\0src/old.ts\0 M other.ts\0'
    const files = parsePorcelainZ(out)
    expect(files).toEqual([
      { code: 'R ', path: 'dest/new.ts' },
      { code: ' M', path: 'other.ts' }
    ])
  })

  it('does not C-quote or mangle a non-ASCII path (raw bytes in -z)', () => {
    const out = ' M café.txt\0'
    expect(parsePorcelainZ(out)).toEqual([{ code: ' M', path: 'café.txt' }])
  })
})

describe('parseNumstatZ', () => {
  it('keys plain entries by path', () => {
    const counts = parseNumstatZ('12\t3\tsrc/a.ts\0-\t-\tbin.png\0')
    expect(counts.get('src/a.ts')).toEqual({ added: 12, deleted: 3 })
    expect(counts.get('bin.png')).toEqual({ added: 0, deleted: 0 }) // binary shows '-'
  })

  it('keys a rename on the new path (empty path field + two NUL fields)', () => {
    const counts = parseNumstatZ('4\t2\t\0src/old.ts\0dest/new.ts\0')
    expect(counts.get('dest/new.ts')).toEqual({ added: 4, deleted: 2 })
  })
})

describe('buildGitFiles', () => {
  it('joins status + numstat, matching a renamed file by its destination path', () => {
    const status = 'R  dest/new.ts\0src/old.ts\0'
    const numstat = '5\t1\t\0src/old.ts\0dest/new.ts\0'
    expect(buildGitFiles(status, numstat)).toEqual([
      { path: 'dest/new.ts', status: 'R', staged: true, added: 5, deleted: 1 }
    ])
  })

  it('marks an unstaged modification as not staged', () => {
    const files = buildGitFiles(' M a.ts\0', '1\t0\ta.ts\0')
    expect(files[0]).toEqual({ path: 'a.ts', status: 'M', staged: false, added: 1, deleted: 0 })
  })
})
