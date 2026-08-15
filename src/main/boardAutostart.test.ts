import { describe, it, expect } from 'vitest'
import { ensureBoardRunning, ensureBoardThenResyncMcp, waitForBoardReady, type BoardAutostartDeps } from './boardAutostart'

const paths = { dbPath: '/tmp/board.db', publicDir: '/tmp/board-public' }
const base: BoardAutostartDeps = { reachable: async () => false, start: async () => {} }

describe('ensureBoardRunning (in-process board)', () => {
  it('board already reachable → defers, does not start a second instance', async () => {
    let started = 0
    const r = await ensureBoardRunning(paths, undefined, { ...base, reachable: async () => true, start: async () => void started++ })
    expect(r).toBe('already-up')
    expect(started).toBe(0)
  })

  it('a start failure is caught and reported, not thrown', async () => {
    const logs: string[] = []
    const r = await ensureBoardRunning(paths, (m) => logs.push(m), {
      ...base,
      start: async () => {
        throw new Error('boom')
      }
    })
    expect(r).toBe('error')
    expect(logs.some((l) => /Could not start/.test(l))).toBe(true)
  })

  // Runs LAST among the start cases: a successful start flips the process-wide guard, so any later call
  // short-circuits to 'already-up'.
  it('down + not yet started → starts exactly once with the given paths', async () => {
    let started = 0
    const got: Array<{ dbPath: string; publicDir: string }> = []
    const r = await ensureBoardRunning(paths, undefined, {
      ...base,
      start: async (dbPath, publicDir) => {
        started++
        got.push({ dbPath, publicDir })
      }
    })
    expect(r).toBe('started')
    expect(started).toBe(1)
    expect(got).toEqual([paths])
  })

  it('once started, a subsequent call short-circuits to already-up (process-wide guard)', async () => {
    let started = 0
    const r = await ensureBoardRunning(paths, undefined, { ...base, start: async () => void started++ })
    expect(r).toBe('already-up')
    expect(started).toBe(0)
  })
})

describe('ensureBoardThenResyncMcp (cold-launch board→MCP ordering)', () => {
  it('cold start: waits for the board to answer, THEN resyncs MCP', async () => {
    const order: string[] = []
    await ensureBoardThenResyncMcp({
      ensure: async () => (order.push('ensure'), 'started'),
      waitReady: async () => (order.push('ready'), true),
      resync: () => void order.push('resync')
    })
    expect(order).toEqual(['ensure', 'ready', 'resync'])
  })

  it('board already up: resyncs immediately without polling', async () => {
    const order: string[] = []
    await ensureBoardThenResyncMcp({
      ensure: async () => 'already-up',
      waitReady: async () => (order.push('ready'), true),
      resync: () => void order.push('resync')
    })
    expect(order).toEqual(['resync'])
  })

  it('start failed: still resyncs, so the retry (and its clear error) is not skipped', async () => {
    let resynced = 0
    await ensureBoardThenResyncMcp({
      ensure: async () => 'error',
      waitReady: async () => true,
      resync: () => void resynced++
    })
    expect(resynced).toBe(1)
  })
})

describe('waitForBoardReady', () => {
  const noSleep = async (): Promise<void> => {} // injected so the poll loop never waits real time

  it('resolves true as soon as the board answers', async () => {
    let calls = 0
    const ready = await waitForBoardReady({ sleep: noSleep, reachable: async () => ++calls >= 3 }) // up after 2 misses
    expect(ready).toBe(true)
    expect(calls).toBe(3)
  })

  it('resolves true immediately when already reachable (no sleeps)', async () => {
    let slept = 0
    const ready = await waitForBoardReady({ reachable: async () => true, sleep: async () => void slept++ })
    expect(ready).toBe(true)
    expect(slept).toBe(0)
  })

  it('resolves false if the board never comes up within the budget', async () => {
    const ready = await waitForBoardReady({ sleep: noSleep, reachable: async () => false, timeoutMs: 500, intervalMs: 100 })
    expect(ready).toBe(false)
  })
})
