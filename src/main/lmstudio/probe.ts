import type { ProbeResult } from '../../shared/ipc-types'
import type { ConnectionKind } from '../../shared/domain-types'

/**
 * Reachability probe for any OpenAI-compatible server (LM Studio, Ollama, OpenAI, Anthropic compat,
 * OpenRouter, …): GET <baseURL>/models with a short timeout, yielding three states —
 * unreachable / server-up-but-no-model / ok. A bearer key is sent when provided (cloud endpoints).
 *
 * @param baseURL e.g. "http://127.0.0.1:1234/v1"
 * @param apiKey  optional bearer token for cloud endpoints
 * @param kind    backend kind — Anthropic needs native (x-api-key + version) headers to list models
 */
export async function probeConnection(baseURL: string, apiKey?: string, kind?: ConnectionKind): Promise<ProbeResult> {
  const url = baseURL.replace(/\/+$/, '') + '/models'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  const key = apiKey?.trim()
  const headers: Record<string, string> = {}
  if (kind === 'anthropic') {
    // Anthropic's /v1/models is the NATIVE API (x-api-key + anthropic-version), not the OpenAI-compat
    // Bearer surface its chat endpoint uses. Without these it 4xxs and the model picker shows empty.
    if (key) headers['x-api-key'] = key
    headers['anthropic-version'] = '2023-06-01'
  } else if (key) {
    headers.Authorization = `Bearer ${key}`
  }
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers })
    if (!res.ok) {
      // Reachable-but-rejected (bad key / endpoint without a /models route) is NOT "offline" — surface
      // it distinctly so a backend that actually chats fine isn't shown as server-down.
      if (res.status === 401 || res.status === 403) {
        return { status: 'auth', models: [], detail: `HTTP ${res.status} — check the API key` }
      }
      return { status: 'unreachable', models: [], detail: `HTTP ${res.status}` }
    }
    const data = (await res.json()) as { data?: Array<{ id?: string }> }
    const models = (data.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x))
    if (models.length === 0) {
      return { status: 'no-model', models: [], detail: 'server reachable, no model loaded' }
    }
    return { status: 'ok', models }
  } catch (e) {
    const detail = e instanceof Error ? `${e.name}` : 'error'
    return { status: 'unreachable', models: [], detail }
  } finally {
    clearTimeout(timer)
  }
}

/** @deprecated use {@link probeConnection}. Kept as a thin alias for local LM Studio probes. */
export const probeLMStudio = (baseURL: string): Promise<ProbeResult> => probeConnection(baseURL)

/** All DOWNLOADED chat models from LM Studio's native REST (`/api/v0/models`) — loaded AND not-loaded —
 *  minus embedding models. The OpenAI-compat `/v1/models` only lists what's resident, but a swap-based loop
 *  picks models that are deliberately unloaded, so the picker needs the full installed set. [] on any failure. */
async function lmStudioInstalledModels(baseURL: string): Promise<string[]> {
  const base = baseURL.replace(/\/v1\/?$/, '').replace(/\/+$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 3000)
  try {
    const res = await fetch(`${base}/api/v0/models`, { signal: ctrl.signal })
    if (!res.ok) return []
    const data = (await res.json()) as { data?: Array<{ id?: string; type?: string }> }
    return (data.data ?? [])
      .filter((m) => m.type !== 'embeddings') // not usable as a worker/reviewer chat model
      .map((m) => m.id)
      .filter((x): x is string => Boolean(x))
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Best available model list for a connection, for populating a model picker (NOT a status check — that's
 * {@link probeConnection}). LM Studio → every installed chat model (loaded + not-loaded) via the native API,
 * so a swap-based Loop drain can pick an unloaded model; every other backend → the served `/models` list.
 */
export async function listModels(baseURL: string, apiKey?: string, kind?: ConnectionKind): Promise<string[]> {
  if (kind === 'lmstudio') {
    const installed = await lmStudioInstalledModels(baseURL)
    if (installed.length) return installed
  }
  return (await probeConnection(baseURL, apiKey, kind)).models
}

/**
 * Fetch each model's real context length from LM Studio's native REST API, so we trim and meter
 * against what the model actually loaded with — not a fixed guess. Returns {} if unavailable.
 */
export async function fetchModelContextLengths(baseURL: string): Promise<Record<string, number>> {
  const base = baseURL.replace(/\/v1\/?$/, '').replace(/\/+$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 3000)
  try {
    const res = await fetch(`${base}/api/v0/models`, { signal: ctrl.signal })
    if (!res.ok) return {}
    const data = (await res.json()) as {
      data?: Array<{ id?: string; loaded_context_length?: number; max_context_length?: number }>
    }
    const out: Record<string, number> = {}
    for (const m of data.data ?? []) {
      const ctx = m.loaded_context_length ?? m.max_context_length
      if (m.id && typeof ctx === 'number' && ctx > 0) out[m.id] = ctx
    }
    return out
  } catch {
    return {}
  } finally {
    clearTimeout(timer)
  }
}
