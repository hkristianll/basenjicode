import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

/** One model's load state, read from LM Studio's native REST API (`/api/v0/models`). */
export interface ModelLoadState {
  /** True when LM Studio reports the model `state: 'loaded'`. */
  loaded: boolean
  /** Context length the loaded instance was allocated with (absent when not loaded). */
  loadedCtx?: number
  /** The model's maximum supported context length (the ceiling for `lms load -c`). */
  maxCtx?: number
}

/** What `ensureModelLoaded` decided to do — surfaced separately so the decision is unit-testable. */
export interface LoadPlan {
  /** Context length we want the model loaded at (clamped to the model's max). */
  target: number
  /** True when a reload is required (model unloaded, or loaded smaller than `target`). */
  load: boolean
}

/**
 * Decide whether to (re)load the model and at what context length, given its current state and the
 * user's configured window (`minCtx`). Pure so it can be tested without touching LM Studio.
 *
 * Rule: the configured window is a FLOOR. We reload at `min(minCtx, max)` only when the model is
 * unloaded or loaded smaller than that floor — never to SHRINK a model already loaded bigger.
 * Returns null when state is unknown (older LM Studio / native API off) so the caller leaves it alone.
 */
export function planModelLoad(state: ModelLoadState | null, minCtx: number): LoadPlan | null {
  if (!state) return null
  // RESPECT AN ALREADY-LOADED INSTANCE — never reload it. A CLI `lms load` exposes no flags for Flash
  // Attention or KV-cache quantization, so any reload respawns the model at LM Studio's defaults and silently
  // wipes the user's deliberately-tuned load (FA on, Q8 KV, etc.). Reloading just to GROW context isn't worth
  // destroying those settings — so we only (re)load when the model is genuinely UNLOADED (cold start /
  // eviction recovery). A model loaded SMALLER than the configured window is left alone; the loop trims its
  // prompts to the loaded size elsewhere (configFromSettings / trimHistory).
  if (state.loaded) {
    return { target: typeof state.loadedCtx === 'number' ? state.loadedCtx : Math.max(1, minCtx), load: false }
  }
  const cap = state.maxCtx && state.maxCtx > 0 ? state.maxCtx : minCtx
  const target = Math.max(1, Math.min(minCtx, cap))
  return { target, load: true }
}

/** Read one model's load state from LM Studio's native REST API. Returns null if unavailable. */
export async function fetchModelLoadState(baseURL: string, modelId: string): Promise<ModelLoadState | null> {
  const base = baseURL.replace(/\/v1\/?$/, '').replace(/\/+$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 3000)
  try {
    const res = await fetch(`${base}/api/v0/models`, { signal: ctrl.signal })
    if (!res.ok) return null
    const data = (await res.json()) as {
      data?: Array<{ id?: string; state?: string; loaded_context_length?: number; max_context_length?: number }>
    }
    const m = (data.data ?? []).find((x) => x.id === modelId)
    if (!m) return null
    return {
      loaded: m.state === 'loaded',
      loadedCtx: typeof m.loaded_context_length === 'number' ? m.loaded_context_length : undefined,
      maxCtx: typeof m.max_context_length === 'number' ? m.max_context_length : undefined
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Ids of the models LM Studio currently has LOADED (embedding models excluded). Null when the native
 *  /api/v0 endpoint is unavailable (older LM Studio, non-LM-Studio backend) — callers treat that as
 *  "unknown", never as "none loaded". */
export async function fetchLoadedModelIds(baseURL: string): Promise<string[] | null> {
  const base = baseURL.replace(/\/v1\/?$/, '').replace(/\/+$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 3000)
  try {
    const res = await fetch(`${base}/api/v0/models`, { signal: ctrl.signal })
    if (!res.ok) return null
    const data = (await res.json()) as { data?: Array<{ id?: string; state?: string; type?: string }> }
    return (data.data ?? [])
      .filter((m) => m.state === 'loaded' && m.type !== 'embeddings' && typeof m.id === 'string')
      .map((m) => m.id as string)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function lmsPath(): string {
  // LM Studio's CLI is `lms.exe` on Windows, `lms` on macOS/Linux.
  const bin = process.platform === 'win32' ? 'lms.exe' : 'lms'
  return path.join(os.homedir(), '.lmstudio', 'bin', bin)
}

/**
 * True when `baseURL` points at an LM Studio on THIS machine.
 *
 * The `lms` CLI has no notion of a target server — it always drives the local instance. Every CLI path
 * must therefore be gated on this: against a remote LM Studio the CLI reports success while operating on
 * an entirely different machine, and the caller's real server is left untouched.
 */
export function isLocalLmStudio(baseURL: string): boolean {
  try {
    const h = new URL(baseURL).hostname.toLowerCase()
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
  } catch {
    return false
  }
}

/**
 * Run an `lms` subcommand. Resolves true only on a real success (best-effort, never throws).
 *
 * Exit code alone is not enough: `lms unload <id>` EXITS 0 when the model isn't loaded, printing
 * "Model Not Found". Treating that as success is actively harmful — it makes a no-op look like a
 * completed unload and suppresses the REST fallback that would have reached the right server.
 */
function lms(args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(lmsPath(), args, { timeout: timeoutMs }, (err, stdout, stderr) => {
        if (err) return resolve(false)
        resolve(!/model not found|cannot find a model/i.test(`${stdout ?? ''}${stderr ?? ''}`))
      })
    } catch {
      resolve(false)
    }
  })
}

/** Unload one model via the `lms` CLI — the RELIABLE path (the REST /api/v1/models/unload shape is
 *  LM-Studio-version-dependent and silently no-ops on some builds). Does NOT take the server lock: the
 *  worker↔reviewer swap caller already holds it (`withServerLock` is not reentrant). Best-effort. */
export function lmsUnloadUnlocked(baseURL: string, modelId: string): Promise<boolean> {
  if (!modelId) return Promise.resolve(true)
  // Remote server → the CLI cannot reach it; report failure so the caller falls through to REST.
  if (!isLocalLmStudio(baseURL)) return Promise.resolve(false)
  return lms(['unload', modelId], 30_000)
}

/** Server root (strip a trailing /v1, /v0, …) — the lock key, so every connection pointed at one LM Studio
 *  instance shares a single load/unload queue. */
function serverRoot(baseURL: string): string {
  return baseURL.replace(/\/+$/, '').replace(/\/v\d+$/, '')
}

/** Serialize load/unload ops per LM Studio server. A board worker↔reviewer swap drives `lms unload`/`lms load`
 *  (and the unload REST endpoint) on the SAME global server a concurrent chat turn may be (re)loading — without
 *  this, the two interleave and one clobbers the other's model. Same pattern as ipc.ts's `wakeOp`/`mcpSyncOp`,
 *  but keyed per server. Each op runs after the prior one settles (success OR failure). */
const serverLocks = new Map<string, Promise<unknown>>()
export function withServerLock<T>(baseURL: string, fn: () => Promise<T>): Promise<T> {
  const key = serverRoot(baseURL)
  const prev = serverLocks.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn) // run regardless of the prior op's outcome
  serverLocks.set(
    key,
    run.catch(() => undefined) // keep the chain alive even if this op rejects
  )
  return run
}

/**
 * Per (server, model) record of the largest context LM Studio ACTUALLY delivered when we asked for more —
 * the model's real ceiling on this GPU. Without it, a configured window the hardware can't fit (e.g. 250k
 * requested, only 170k loads) makes `planModelLoad` see `loaded < target` and reload EVERY turn forever.
 * Recording the ceiling and clamping future requests to it stops the churn. Resets on app restart, so a
 * transient VRAM shortfall isn't cached for the whole session.
 */
const loadCeiling = new Map<string, number>()
function ceilKey(baseURL: string, modelId: string): string {
  return serverRoot(baseURL) + '\0' + modelId
}

export interface EnsureLoadedResult {
  /** The model's context length after the call (null when unknown). */
  ctx: number | null
  /** True when we issued an `lms load` (i.e. the model was respawned at `target`). */
  reloaded: boolean
  /** Set when the model maxed out BELOW the requested context (its real ceiling on this GPU) — lets the
   *  caller surface a one-time "your context setting exceeds what fits" hint. */
  cappedTo?: number
}

/**
 * Make sure `modelId` is loaded in LM Studio with at least `minCtx` tokens of context.
 *
 * LM Studio JIT-reloads an unloaded model — after its TTL expires, after `generate_video` runs
 * `lms unload --all`, or after a manual reload — at its DEFAULT context length, silently dropping a
 * large configured window. We pin it instead: when the model is unloaded (or loaded smaller than the
 * configured window) we explicitly `lms load -c <target>` so the setting survives the respawn. It is a
 * no-op when the model is already loaded big enough, so a model sitting at its max is never shrunk.
 *
 * Best-effort: if the native API is unreachable or `lms` fails, we return `reloaded: false` and let
 * LM Studio's own JIT behaviour take over, exactly as before this existed.
 */
export async function ensureModelLoaded(
  baseURL: string,
  modelId: string,
  minCtx: number,
  onReloadStart?: (ctx: number) => void
): Promise<EnsureLoadedResult> {
  if (!modelId) return { ctx: null, reloaded: false }
  // Serialized per server so a concurrent swap-unload can't race this (re)load on the same LM Studio instance.
  return withServerLock(baseURL, async () => {
    // Never ask for more than this GPU already proved it can give — otherwise we'd reload every turn chasing
    // a context the hardware can't fit. `wanted` is the request clamped to the recorded ceiling (if any).
    const key = ceilKey(baseURL, modelId)
    const ceiling = loadCeiling.get(key)
    const wanted = ceiling ? Math.min(minCtx, ceiling) : minCtx
    const state = await fetchModelLoadState(baseURL, modelId)
    const plan = planModelLoad(state, wanted)
    if (!plan || !plan.load) return { ctx: plan?.target ?? null, reloaded: false }
    // A (re)load needs the `lms` CLI, which only drives the LOCAL instance. Against a remote server we
    // cannot load anything, so bail BEFORE onReloadStart — otherwise the user is told "Loading … at
    // N-token context" for a reload that provably never happens. LM Studio's own JIT takes over instead.
    if (!isLocalLmStudio(baseURL)) return { ctx: state?.loadedCtx ?? null, reloaded: false }

    onReloadStart?.(plan.target)
    // A smaller instance is already loaded under this id — unload it first so `lms load` reloads in place
    // instead of spawning a second instance (which the OpenAI-compat API can't address unambiguously).
    if (state?.loaded) await lms(['unload', modelId], 30_000)
    const ok = await lms(['load', modelId, '-c', String(plan.target), '-y'], 180_000)
    if (!ok) return { ctx: state?.loadedCtx ?? null, reloaded: false }

    const after = await fetchModelLoadState(baseURL, modelId)
    const got = after?.loadedCtx ?? plan.target
    // LM Studio gave us less than we asked for → record the real ceiling so we stop re-attempting bigger.
    // Surface `cappedTo` only the FIRST time we discover the cap (it wasn't known going in).
    if (typeof got === 'number' && got < wanted) {
      const firstDiscovery = ceiling === undefined
      loadCeiling.set(key, got)
      return { ctx: got, reloaded: true, ...(firstDiscovery ? { cappedTo: got } : {}) }
    }
    return { ctx: got, reloaded: true }
  })
}
