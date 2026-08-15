import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRunRecord, writeRunRecord, patchRunRecord, type HermesRunRecord } from './hermesRun'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hermesrun-'))
})
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const rec = (over: Partial<HermesRunRecord> = {}): HermesRunRecord => ({
  goal: 'build a slicer',
  project: 'proj',
  startedAt: 1000,
  updatedAt: 1000,
  status: 'running',
  ...over
})

describe('hermesRun record', () => {
  it('returns null when no record exists', () => {
    expect(readRunRecord(dir)).toBeNull()
  })

  it('round-trips a written record', () => {
    writeRunRecord(dir, rec())
    expect(readRunRecord(dir)).toEqual(rec())
  })

  it('patch preserves goal/startedAt and updates status + updatedAt', () => {
    writeRunRecord(dir, rec())
    patchRunRecord(dir, { status: 'complete' }, 2000)
    expect(readRunRecord(dir)).toEqual(rec({ status: 'complete', updatedAt: 2000 }))
  })

  it('patch with no prior record and no goal is a no-op', () => {
    patchRunRecord(dir, { status: 'stopped' }, 2000)
    expect(readRunRecord(dir)).toBeNull()
  })

  it('a corrupt record reads as null rather than throwing', () => {
    writeRunRecord(dir, rec()) // creates .nordcode/hermes/run.json
    writeFileSync(join(dir, '.nordcode', 'hermes', 'run.json'), '{ not valid json')
    expect(readRunRecord(dir)).toBeNull()
  })

  it('read/write under a path blocked by a file degrade quietly (no throw)', () => {
    writeFileSync(join(dir, 'blocker'), 'x')
    const bogus = join(dir, 'blocker', 'under') // parent is a FILE → internal mkdir/read fail, swallowed
    expect(() => writeRunRecord(bogus, rec())).not.toThrow()
    expect(readRunRecord(bogus)).toBeNull()
  })
})
