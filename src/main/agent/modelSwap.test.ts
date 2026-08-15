import { describe, it, expect, vi, afterEach } from 'vitest'
import { shouldSwap, unloadModel, rolesToFree } from './modelSwap'
import { lmsUnloadUnlocked } from '../lmstudio/loadModel'
import type { LoopConfig } from '../../shared/ipc-types'
import type { Settings, Connection } from '../../shared/domain-types'

// Isolate from the REAL `lms` CLI (present on the dev machine, so it would short-circuit the REST fallback).
// withServerLock is a passthrough; lmsUnloadUnlocked defaults to "CLI unavailable" so the REST-fallback tests
// exercise that path. A test that wants the CLI-success path overrides it per case.
vi.mock('../lmstudio/loadModel', () => ({
  withServerLock: (_baseURL: string, fn: () => Promise<unknown>) => fn(),
  lmsUnloadUnlocked: vi.fn(async () => false)
}))
const lmsMock = vi.mocked(lmsUnloadUnlocked)

function cfg(p: Partial<LoopConfig> = {}): LoopConfig {
  return {
    cwd: '/x',
    connectionId: 'worker',
    project: 'p',
    mode: 'auto',
    caps: { maxTickets: 1, maxTokens: 0, maxWallclockSec: 1, maxConsecutiveFailures: 1 },
    ...p
  }
}

describe('shouldSwap', () => {
  it('off when swapModels is explicitly false', () => {
    expect(shouldSwap(cfg({ reviewerConnectionId: 'rev', swapModels: false }))).toBe(false)
  })
  it('off when there is no reviewer', () => {
    expect(shouldSwap(cfg({ swapModels: true }))).toBe(false)
  })
  it('off when the reviewer is the same connection as the worker', () => {
    expect(shouldSwap(cfg({ reviewerConnectionId: 'worker', swapModels: true }))).toBe(false)
  })
  it('on when worker and reviewer share an LM Studio connection but select different models', () => {
    expect(shouldSwap(cfg({ reviewerConnectionId: 'worker', workerModel: 'coder', reviewerModel: 'reviewer' }))).toBe(true)
  })
  it('off when both roles explicitly select the same model', () => {
    expect(shouldSwap(cfg({ reviewerConnectionId: 'worker', workerModel: 'coder', reviewerModel: 'coder' }))).toBe(false)
  })
  it('on for a distinct reviewer (swapModels defaulting on, or explicit true)', () => {
    expect(shouldSwap(cfg({ reviewerConnectionId: 'rev' }))).toBe(true)
    expect(shouldSwap(cfg({ reviewerConnectionId: 'rev', swapModels: true }))).toBe(true)
  })
})

describe('rolesToFree — generalize the VRAM swap to worker / reviewer / planner', () => {
  const lm = (id: string, model: string): Connection => ({ id, label: id, kind: 'lmstudio', baseURL: 'http://127.0.0.1:1234/v1', model }) as Connection
  // One shared LM Studio connection running four distinct models by id (the real single-GPU setup).
  const settings = (over: Partial<Settings> = {}): Settings =>
    ({ connections: [lm('local', 'active-model')], activeConnectionId: 'local', hermesPlannerConnectionId: 'local', hermesPlannerModel: 'planner-35b', ...over }) as Settings
  const hermesCfg = (over: Partial<LoopConfig> = {}): LoopConfig =>
    cfg({ connectionId: 'local', workerModel: 'worker-27b', reviewerConnectionId: 'local', reviewerModel: 'reviewer-gemma', ...over })

  it('keeping the WORKER frees the planner + reviewer (the planner→worker drain boundary)', () => {
    const freed = rolesToFree(settings(), hermesCfg(), 'worker-27b').map((r) => r.model).sort()
    expect(freed).toEqual(['planner-35b', 'reviewer-gemma'])
  })

  it('keeping the PLANNER frees the worker + reviewer (the worker→planner decompose boundary)', () => {
    const freed = rolesToFree(settings(), hermesCfg(), 'planner-35b').map((r) => r.model).sort()
    expect(freed).toEqual(['reviewer-gemma', 'worker-27b'])
  })

  it('never frees the model being kept, and dedupes a role that resolves to the same (server, model)', () => {
    // planner == worker model → the planner role collapses into the kept worker and is not freed.
    const freed = rolesToFree(settings({ hermesPlannerModel: 'worker-27b' }), hermesCfg(), 'worker-27b').map((r) => r.model)
    expect(freed).toEqual(['reviewer-gemma'])
  })

  it('co-reside ON: keeps coder + reviewer resident together, frees ONLY the planner (the no-swap drain)', () => {
    // Drain-side free with keepReviewerResident → the reviewer stays loaded alongside the worker (no code↔review swap).
    expect(rolesToFree(settings(), hermesCfg(), 'worker-27b', true).map((r) => r.model)).toEqual(['planner-35b'])
    // Symmetric: keeping the reviewer also keeps the coder → only the planner is ever freed during the drain.
    expect(rolesToFree(settings(), hermesCfg(), 'reviewer-gemma', true).map((r) => r.model)).toEqual(['planner-35b'])
  })

  it('co-reside is DRAIN-side only: the planner-side free (flag off) still frees the drain models', () => {
    // liveComplete passes no flag → a planning turn still gets VRAM to itself (planner + reviewer wouldn\'t fit).
    expect(rolesToFree(settings(), hermesCfg(), 'planner-35b', false).map((r) => r.model).sort()).toEqual(['reviewer-gemma', 'worker-27b'])
  })

  it('returns nothing when model-swap is disabled', () => {
    expect(rolesToFree(settings(), hermesCfg({ swapModels: false }), 'worker-27b')).toEqual([])
  })

  it('skips cloud / unmanaged backends (nothing to unload there)', () => {
    const cloud = { id: 'cloud', label: 'cloud', kind: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude' } as Connection
    const s = settings({ connections: [cloud], activeConnectionId: 'cloud', hermesPlannerConnectionId: 'cloud', hermesPlannerModel: 'big-cloud' })
    const c = hermesCfg({ connectionId: 'cloud', reviewerConnectionId: 'cloud' })
    expect(rolesToFree(s, c, 'worker-27b')).toEqual([]) // anthropic isn't unloadable
  })
})

describe('unloadModel — an empty model id must never wipe the whole server', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    lmsMock.mockResolvedValue(false) // restore the default (CLI unavailable → REST fallback)
  })

  it('does nothing (never even lists instances) when model is empty', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await unloadModel({ kind: 'lmstudio', baseURL: 'http://localhost:1234/v1' }, '')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the lms CLI first and skips the REST endpoint when it succeeds', async () => {
    lmsMock.mockResolvedValueOnce(true)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await unloadModel({ kind: 'lmstudio', baseURL: 'http://localhost:1234/v1' }, 'target')
    expect(lmsMock).toHaveBeenCalledWith('target')
    expect(fetchMock).not.toHaveBeenCalled() // CLI handled it — no fragile REST call
  })

  it('unloads only the matching instance for a real model id', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).endsWith('/api/v1/models')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'keep-me', instance_id: 'i1' },
              { id: 'target', instance_id: 'i2' }
            ]
          })
        } as unknown as Response
      }
      return { ok: true, json: async () => ({}) } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await unloadModel({ kind: 'lmstudio', baseURL: 'http://localhost:1234/v1' }, 'target')
    const unloadCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/api/v1/models/unload'))
    expect(unloadCalls).toHaveLength(1)
    expect(JSON.parse(String((unloadCalls[0][1] as RequestInit).body)).instance_id).toBe('i2')
  })
})
  it('on when worker and reviewer share an LM Studio connection but select different models', () => {
    expect(shouldSwap(cfg({ reviewerConnectionId: 'worker', workerModel: 'coder', reviewerModel: 'reviewer' }))).toBe(true)
  })
  it('off when both roles explicitly select the same model', () => {
    expect(shouldSwap(cfg({ reviewerConnectionId: 'worker', workerModel: 'coder', reviewerModel: 'coder' }))).toBe(false)
  })
