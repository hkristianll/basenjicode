import { describe, it, expect } from 'vitest'
import { selectParallelBatch, isBatchable, type BatchableTicket } from './parallelBatch'

const tkt = (id: number, role: string, files?: string[]): BatchableTicket => ({
  id,
  body: `**Department: ${role}**${files ? `\n**Files:** ${files.join(', ')}` : ''}\n\nbody`
})

describe('isBatchable', () => {
  it('only implementation tickets that declare files', () => {
    expect(isBatchable(tkt(1, 'implementation', ['src/a.ts']))).toBe(true)
    expect(isBatchable(tkt(2, 'implementation', undefined))).toBe(false) // no declared files → can't prove disjoint
    expect(isBatchable(tkt(3, 'design', ['src/d.ts']))).toBe(false) // not impl
    expect(isBatchable(tkt(4, 'testing', ['src/t.ts']))).toBe(false)
  })
})

describe('selectParallelBatch', () => {
  it('batches file-disjoint impl tickets up to max (the wide entity layer)', () => {
    const ts = [tkt(1, 'implementation', ['src/Paddle.ts']), tkt(2, 'implementation', ['src/Ball.ts']), tkt(3, 'implementation', ['src/Brick.ts'])]
    const { batch, rest } = selectParallelBatch(ts, 4)
    expect(batch.map((t) => t.id)).toEqual([1, 2, 3])
    expect(rest).toEqual([])
  })

  it('serializes tickets that SHARE a file (collisions all in GameScene)', () => {
    const ts = [tkt(1, 'implementation', ['src/GameScene.ts']), tkt(2, 'implementation', ['src/GameScene.ts']), tkt(3, 'implementation', ['src/Ball.ts'])]
    const { batch, rest } = selectParallelBatch(ts, 4)
    expect(batch.map((t) => t.id)).toEqual([1, 3]) // #1 takes GameScene, #2 conflicts → rest, #3 disjoint → batch
    expect(rest.map((t) => t.id)).toEqual([2])
  })

  it('respects the max cap', () => {
    const ts = [tkt(1, 'implementation', ['a.ts']), tkt(2, 'implementation', ['b.ts']), tkt(3, 'implementation', ['c.ts'])]
    const { batch, rest } = selectParallelBatch(ts, 2)
    expect(batch.map((t) => t.id)).toEqual([1, 2])
    expect(rest.map((t) => t.id)).toEqual([3])
  })

  it('normalizes paths for the disjointness check (./src/a.ts === src/A.ts)', () => {
    const ts = [tkt(1, 'implementation', ['src/A.ts']), tkt(2, 'implementation', ['./src/a.ts'])]
    const { batch, rest } = selectParallelBatch(ts, 4)
    expect(batch).toEqual([]) // same file → conflict → batch<2 → all sequential
    expect(rest.map((t) => t.id)).toEqual([1, 2])
  })

  it('max=1 never batches (sequential mode)', () => {
    const ts = [tkt(1, 'implementation', ['a.ts']), tkt(2, 'implementation', ['b.ts'])]
    expect(selectParallelBatch(ts, 1).batch).toEqual([])
  })

  it('a would-be batch of one collapses to all-sequential', () => {
    const ts = [tkt(1, 'implementation', ['a.ts']), tkt(2, 'design', ['d.ts'])] // only #1 batchable
    const { batch, rest } = selectParallelBatch(ts, 4)
    expect(batch).toEqual([])
    expect(rest.map((t) => t.id)).toEqual([1, 2])
  })
})
