import { describe, it, expect } from 'vitest'
import { createPauseGate } from './pauseGate'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('createPauseGate', () => {
  it('resolves immediately when not paused', async () => {
    const gate = createPauseGate()
    let resolved = false
    await gate.waitWhilePaused().then(() => (resolved = true))
    expect(resolved).toBe(true)
    expect(gate.isPaused()).toBe(false)
  })

  it('holds a waiter until resume(), then releases it', async () => {
    const gate = createPauseGate()
    gate.pause()
    expect(gate.isPaused()).toBe(true)

    let released = false
    const wait = gate.waitWhilePaused().then(() => (released = true))
    await flush()
    expect(released).toBe(false) // still held while paused

    gate.resume()
    await wait
    expect(released).toBe(true)
    expect(gate.isPaused()).toBe(false)
  })

  it('releases ALL concurrent waiters on a single resume', async () => {
    const gate = createPauseGate()
    gate.pause()
    let a = false
    let b = false
    const wa = gate.waitWhilePaused().then(() => (a = true))
    const wb = gate.waitWhilePaused().then(() => (b = true))
    await flush()
    expect([a, b]).toEqual([false, false])
    gate.resume()
    await Promise.all([wa, wb])
    expect([a, b]).toEqual([true, true])
  })

  it('releases a waiter when its signal aborts (a Stop never deadlocks a paused run)', async () => {
    const gate = createPauseGate()
    gate.pause()
    const ac = new AbortController()
    let released = false
    const wait = gate.waitWhilePaused(ac.signal).then(() => (released = true))
    await flush()
    expect(released).toBe(false)
    ac.abort()
    await wait
    expect(released).toBe(true)
    expect(gate.isPaused()).toBe(true) // abort releases the waiter but does NOT clear the pause state
  })

  it('resolves immediately when the signal is already aborted', async () => {
    const gate = createPauseGate()
    gate.pause()
    const ac = new AbortController()
    ac.abort()
    let resolved = false
    await gate.waitWhilePaused(ac.signal).then(() => (resolved = true))
    expect(resolved).toBe(true)
  })
})
