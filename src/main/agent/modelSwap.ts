// Workerâ†”reviewer VRAM swap: keep only ONE model resident so a constrained GPU doesn't OOM running both.
// `shouldSwap` is the pure, unit-tested decision; `unloadModel` is best-effort I/O that NEVER throws (a
// failed unload must not break the loop â€” the model just JIT-reloads on its next request).
import type { Connection, Settings } from '../../shared/domain-types'
import type { LoopConfig } from '../../shared/ipc-types'
import { withServerLock, lmsUnloadUnlocked } from '../lmstudio/loadModel'

type SwapConn = Pick<Connection, 'kind' | 'baseURL'>

/** Swap only when enabled AND a distinct reviewer model is configured (same model = nothing to swap). */
export function shouldSwap(config: LoopConfig): boolean {
  if (config.swapModels === false || !config.reviewerConnectionId) return false
  const workerModel = config.workerModel?.trim()
  const reviewerModel = config.reviewerModel?.trim()
  if (workerModel && reviewerModel && workerModel === reviewerModel) return false
  if (config.reviewerConnectionId !== config.connectionId) return true
  // A shared LM Studio connection may still run two explicitly selected models.
  // Blank role models both mean "use the backend default", so there is nothing safe to swap.
  return !!workerModel && !!reviewerModel && workerModel !== reviewerModel
}

/** OpenAI-compat baseURL â†’ server root (strip a trailing /v1, /v0, â€¦). */
function rootOf(baseURL: string): string {
  return baseURL.replace(/\/+$/, '').replace(/\/v\d+$/, '')
}

/** Both shapes LM Studio's /api/v1/models has shipped - see loadedInstanceIds. */
export interface LmsModelsResponse {
  /** Newer builds: one entry per model, each carrying its loaded instances. */
  models?: Array<{ key?: string; loaded_instances?: Array<{ id?: string }> }>
  /** Older builds: a flat list where each entry IS an instance. */
  data?: Array<{ id?: string; instance_id?: string }>
}

/**
 * Instance ids of `model` that are currently loaded, across both response shapes.
 *
 * Only the flat `data[].instance_id` form was handled before, and current LM Studio does not emit it —
 * it returns `models[].loaded_instances[].id` instead, so the lookup silently matched nothing and the
 * swap freed no VRAM at all. Reading both shapes keeps older servers working.
 */
export function loadedInstanceIds(data: LmsModelsResponse | null, model: string): string[] {
  if (!data || !model) return []
  const fromModels = (data.models ?? [])
    .filter((m) => m.key === model)
    .flatMap((m) => m.loaded_instances ?? [])
    .map((i) => i.id)
  const fromData = (data.data ?? []).filter((m) => m.id === model).map((m) => m.instance_id)
  return [...fromModels, ...fromData].filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/**
 * Unload a model from VRAM, best-effort. NEVER throws.
 * - Ollama: POST /api/generate {keep_alive:0} immediately frees it (documented).
 * - LM Studio (0.4.0+): list loaded instances and unload by instance_id; ALSO enable Auto-Evict in LM
 *   Studio for the reliable path, since the REST shape is version-dependent.
 * - openai / anthropic / openai-compat: cloud or unmanaged â€” nothing to unload.
 */
export async function unloadModel(conn: SwapConn, model: string): Promise<void> {
  try {
    // No specific model resolved (e.g. the shipped default `model:''`) → unload NOTHING. Without this an
    // empty id matched every loaded instance below and wiped the whole server, not just the swap target.
    if (!model) return
    // Serialized per server so this unload can't race a concurrent (re)load on the same LM Studio instance.
    await withServerLock(conn.baseURL, async () => {
      const root = rootOf(conn.baseURL)
      if (conn.kind === 'ollama') {
        await fetch(`${root}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, keep_alive: 0 })
        })
        return
      }
      if (conn.kind === 'lmstudio') {
        // Reliable path: the `lms` CLI (the same one ensureModelLoaded drives). Only fall back to the
        // version-dependent REST endpoint if the CLI is unavailable, so the swap actually frees VRAM.
        if (await lmsUnloadUnlocked(conn.baseURL, model)) return
        const res = await fetch(`${root}/api/v1/models`)
        if (!res.ok) return
        const data = (await res.json().catch(() => null)) as LmsModelsResponse | null
        for (const id of loadedInstanceIds(data, model)) {
          await fetch(`${root}/api/v1/models/unload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instance_id: id })
          }).catch(() => undefined)
        }
      }
    })
  } catch {
    /* best-effort: a failed unload must never break the loop */
  }
}

/** Resolve a role's connection by id, falling back to the active/first connection (undefined only with zero
 *  connections configured). */
function connFor(settings: Settings, id: string | undefined): Connection | undefined {
  return (id ? settings.connections.find((c) => c.id === id) : undefined) ?? settings.connections.find((c) => c.id === settings.activeConnectionId) ?? settings.connections[0]
}

/**
 * The configured ROLE models (worker / reviewer / planner) to FREE from VRAM before loading `keepModel`, so a
 * constrained GPU keeps ~one model resident. The original swap only managed worker↔reviewer; the planner
 * (decompose/replan/critic on a separate, bigger model) was never unloaded when the drain started, nor the worker
 * when the planner loaded — both then sat resident and the GPU thrashed. This generalizes the swap to all three
 * roles. Only unloadable backends (lmstudio/ollama), only distinct non-empty models, deduped by (server, model).
 * Empty when model-swap is off. Pure → unit-tested.
 */
export function rolesToFree(
  settings: Settings,
  config: LoopConfig,
  keepModel: string | undefined,
  coResideDrainModels = false
): Array<{ conn: SwapConn; model: string }> {
  if (config.swapModels === false) return []
  const keep = new Set<string>([(keepModel ?? '').trim()].filter(Boolean))
  if (coResideDrainModels) {
    // The user has confirmed the DRAIN models fit in VRAM together — keep the coder + reviewer + designer ALL
    // resident so the code↔review cycle never swaps; only the (big) planner is ever freed during the drain. The
    // planner-side free does NOT pass this flag, so a planning turn still gets the VRAM to itself.
    for (const m of [
      config.workerModel || connFor(settings, config.connectionId)?.model,
      config.reviewerModel || (config.reviewerConnectionId ? connFor(settings, config.reviewerConnectionId)?.model : undefined),
      settings.hermesDesignerModel || (settings.hermesDesignerConnectionId ? connFor(settings, settings.hermesDesignerConnectionId)?.model : undefined)
    ]) {
      const t = (m ?? '').trim()
      if (t) keep.add(t)
    }
  }
  const candidates: Array<{ connId?: string; model?: string }> = [
    { connId: config.connectionId, model: config.workerModel || connFor(settings, config.connectionId)?.model },
    { connId: config.reviewerConnectionId, model: config.reviewerModel },
    { connId: settings.hermesPlannerConnectionId, model: settings.hermesPlannerModel || (settings.hermesPlannerConnectionId ? connFor(settings, settings.hermesPlannerConnectionId)?.model : undefined) },
    { connId: settings.hermesDesignerConnectionId, model: settings.hermesDesignerModel || (settings.hermesDesignerConnectionId ? connFor(settings, settings.hermesDesignerConnectionId)?.model : undefined) }
  ]
  const out: Array<{ conn: SwapConn; model: string }> = []
  const seen = new Set<string>()
  for (const r of candidates) {
    const model = (r.model ?? '').trim()
    if (!model || keep.has(model)) continue
    const conn = connFor(settings, r.connId)
    if (!conn || (conn.kind !== 'lmstudio' && conn.kind !== 'ollama')) continue
    const dedupe = rootOf(conn.baseURL) + '\0' + model
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    out.push({ conn, model })
  }
  return out
}

/** Free every OTHER configured role model from VRAM before loading `keepModel`. Best-effort (unloadModel never
 *  throws); emits a notice per model freed so the swap is visible in the run log. When `coResideDrainModels` is set
 *  (drain-side callers, gated by the keepReviewerResident setting), the coder+reviewer+designer stay resident together
 *  and only the planner is freed. */
export async function freeOtherRoleModels(
  settings: Settings,
  config: LoopConfig,
  keepModel: string | undefined,
  emit?: (text: string) => void,
  coResideDrainModels = false
): Promise<void> {
  for (const r of rolesToFree(settings, config, keepModel, coResideDrainModels)) {
    emit?.(`Freeing ${r.model} from VRAM (model swap)`)
    await unloadModel(r.conn, r.model)
  }
}
