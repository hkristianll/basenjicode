import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the `lms` CLI (execFile) so no real LM Studio process is spawned; the closure lets us assert calls.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { planModelLoad, ensureModelLoaded } from './loadModel'

describe('planModelLoad', () => {
  it('returns null when state is unknown (leave LM Studio alone)', () => {
    expect(planModelLoad(null, 200_000)).toBeNull()
  })

  it('loads at the configured window when the model is not loaded', () => {
    expect(planModelLoad({ loaded: false, maxCtx: 262_144 }, 200_000)).toEqual({ target: 200_000, load: true })
  })

  it('does NOT reload a loaded model even when it is smaller than the window (preserve user FA/KV load)', () => {
    // A CLI reload resets the user's Flash Attention + KV-quant settings, so a loaded-but-small instance is
    // respected, not grown. The loop trims prompts to the loaded size instead.
    expect(planModelLoad({ loaded: true, loadedCtx: 4096, maxCtx: 262_144 }, 200_000)).toEqual({
      target: 4096,
      load: false
    })
  })

  it('does NOT reload (never shrinks) when already loaded at least as big as the window', () => {
    expect(planModelLoad({ loaded: true, loadedCtx: 262_144, maxCtx: 262_144 }, 200_000)).toEqual({
      target: 262_144,
      load: false
    })
  })

  it('treats the window as a floor: a model loaded above a small window is left untouched', () => {
    expect(planModelLoad({ loaded: true, loadedCtx: 262_144, maxCtx: 262_144 }, 32_768)).toEqual({
      target: 262_144,
      load: false
    })
  })

  it('clamps the target to the model max so `lms load -c` never exceeds it', () => {
    expect(planModelLoad({ loaded: false, maxCtx: 262_144 }, 2_000_000)).toEqual({ target: 262_144, load: true })
  })

  it('falls back to the requested window when max is unknown', () => {
    expect(planModelLoad({ loaded: false }, 200_000)).toEqual({ target: 200_000, load: true })
  })

  it('reloads an unloaded model even if a stale loadedCtx is reported', () => {
    expect(planModelLoad({ loaded: false, loadedCtx: 262_144, maxCtx: 262_144 }, 200_000)).toEqual({
      target: 200_000,
      load: true
    })
  })
})

describe('ensureModelLoaded — no reload thrash when the model maxes out below the request', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    // Every `lms` invocation "succeeds" (callback with no error → the helper resolves true).
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (e: unknown) => void) => cb(null))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('records the ceiling on the first short load, then skips the reload next turn', async () => {
    const base = 'http://localhost:1234/v1'
    const model = 'thrash-fixture-model' // unique id → the module ceiling map starts clean for it
    const state = (loadedCtx: number, loaded: boolean) => ({
      ok: true,
      json: async () => ({
        data: [{ id: model, state: loaded ? 'loaded' : 'idle', loaded_context_length: loadedCtx, max_context_length: 262_144 }]
      })
    })
    // fetchModelLoadState sequence: (1) pre-load = UNLOADED → load at 250k; (2) post-load = 170k (GPU gave
    // less) → record ceiling; (3) next turn pre-load = loaded 170k → planModelLoad says no reload (respect it).
    const responses = [state(0, false), state(170_000, true), state(170_000, true)]
    let i = 0
    vi.stubGlobal('fetch', vi.fn(async () => responses[i++] as unknown as Response))

    const r1 = await ensureModelLoaded(base, model, 250_000)
    expect(r1.reloaded).toBe(true)
    expect(r1.ctx).toBe(170_000)
    expect(r1.cappedTo).toBe(170_000) // first discovery of the cap → surfaced

    const r2 = await ensureModelLoaded(base, model, 250_000)
    expect(r2.reloaded).toBe(false) // ceiling clamps the request to 170k; already loaded there → no reload
    expect(r2.cappedTo).toBeUndefined() // not re-surfaced

    const loadCalls = execFileMock.mock.calls.filter((c) => Array.isArray(c[1]) && (c[1] as string[]).includes('load'))
    expect(loadCalls).toHaveLength(1) // `lms load` issued once (turn 1), not on turn 2
  })
})
