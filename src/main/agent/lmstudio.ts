import OpenAI from 'openai'
import type { ChatMessage, Connection } from '../../shared/domain-types'
import { ensureModelLoaded, fetchLoadedModelIds } from '../lmstudio/loadModel'

export type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool
export type ChatChunk = OpenAI.Chat.Completions.ChatCompletionChunk
export type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion

export interface ChatStreamParams {
  model: string
  messages: ChatMessage[]
  /** Omitted entirely when text tool-call mode is active. */
  tools?: ChatTool[]
  temperature: number
  maxTokens: number | null
  signal: AbortSignal
  /** Force TEXT tool-calls: when true, the native `tools`/`tool_choice` are NOT sent, so the model cannot use
   *  the native function-call channel (where weak local models emit empty/truncated args). It must instead
   *  emit `<tool_call>{…}</tool_call>` text — instructed by the prompt and parsed by the loop's text fallback.
   *  The args ride the normal content stream, so they can't be clipped/emptied by the native assembler. */
  preferTextToolCalls?: boolean
  /** Context (tokens) to reload the model at if it was evicted mid-run. Optional — callers that don't set it
   *  get DEFAULT_RELOAD_CTX, which matches the Hermes genius-zone clamp. */
  reloadCtx?: number
  /** Surface a recovery decision to the user (the loop forwards it as a chat notice) — e.g. W1c's
   *  "configured model is gone, following the swap to the loaded one". Optional; recoveries stay silent without it. */
  onNotice?: (text: string) => void
}

/** Context to reload an evicted model at when the caller didn't pass its configured window — matches the Hermes
 *  worker/reviewer clamp (loadCeiling in ensureModelLoaded caps it to what the GPU can actually fit). */
const DEFAULT_RELOAD_CTX = 80_000

/** True when an LM Studio completion failed because the target model was evicted/unloaded — idle TTL, an explicit
 *  `lms unload`, or another app (e.g. ComfyUI image/video gen) grabbing the VRAM. JIT does not always reload it,
 *  so the call errors out instead of transparently re-loading; we recover by reloading + retrying once. */
export function isModelUnloadedError(e: unknown): boolean {
  const o = e as { error?: { message?: string; code?: string }; message?: string; code?: string } | null
  if (o?.code === 'model_not_found' || o?.error?.code === 'model_not_found') return true
  const parts: string[] = []
  if (e instanceof Error && e.message) parts.push(e.message)
  if (o?.error?.message) parts.push(o.error.message)
  if (typeof o?.message === 'string') parts.push(o.message)
  const s = parts.join(' ')
  // Covers both shapes LM Studio emits: eviction ("model is not loaded"/"unloaded") and a swap/removal
  // 404 ("model 'x' not found" / "no such model" / "the model `x` does not exist").
  return /unloaded|not loaded|no models?\s+loaded|model_not_found|no such model|model\b.{0,60}\b(not found|does not exist)/i.test(s)
}

/** True when a server rejected a request specifically because it does not support streaming (some
 *  OpenAI-compat proxies / restricted gateways are non-streaming only). The loop reacts by switching that
 *  session to the non-streaming completion path — mirrors Hermes's reactive `_disable_streaming`. */
export function isStreamingUnsupportedError(e: unknown): boolean {
  const parts: string[] = []
  if (e instanceof Error && e.message) parts.push(e.message)
  const o = e as { error?: { message?: string }; message?: string } | null
  if (o?.error?.message) parts.push(o.error.message)
  if (typeof o?.message === 'string') parts.push(o.message)
  const s = parts.join(' ')
  return /stream/i.test(s) && /not support|unsupported|does ?n['o]t support|not allowed|disabled/i.test(s)
}

/**
 * A streaming LLM backend. Every supported kind (LM Studio, Ollama, OpenAI, Anthropic via its
 * OpenAI-compat layer, generic OpenAI-compatible servers) speaks the same wire format, so a single
 * implementation covers them all. The interface exists so a session/sub-agent can hold ANY backend
 * and the loop never depends on a concrete class.
 */
export interface LLMConnection {
  listModels(): Promise<string[]>
  chatStream(p: ChatStreamParams): Promise<AsyncIterable<ChatChunk> & { controller: AbortController }>
  /** Non-streaming completion — the reactive fallback the loop uses when a server rejects streaming. Same
   *  request shape as {@link chatStream}; returns the whole completion at once. */
  chatComplete(p: ChatStreamParams): Promise<ChatCompletion>
}

/** Thin wrapper over the OpenAI SDK pointed at any OpenAI-compatible server. */
export class OpenAICompatClient implements LLMConnection {
  private client: OpenAI
  private baseURL: string

  constructor(opts: { baseURL: string; apiKey?: string; timeoutMs?: number }) {
    this.baseURL = opts.baseURL
    this.client = new OpenAI({
      baseURL: opts.baseURL,
      // Local servers ignore the key, but the SDK requires a non-empty string; cloud endpoints need a real one.
      apiKey: opts.apiKey && opts.apiKey.trim() ? opts.apiKey.trim() : 'lm-studio',
      // Local models can be slow to first token; allow plenty of time.
      timeout: opts.timeoutMs ?? 600_000,
      // We own the error UX — never silently retry against a dead local server.
      maxRetries: 0
    })
  }

  async listModels(): Promise<string[]> {
    const res = await this.client.models.list()
    return res.data.map((m) => m.id)
  }

  private openStream(p: ChatStreamParams): Promise<AsyncIterable<ChatChunk> & { controller: AbortController }> {
    // Text-tool-call mode: withhold the native tool schema so the model can't use the native channel (where
    // weak local models emit empty/truncated args) — it must emit <tool_call> text instead.
    const sendNative = (p.tools?.length ?? 0) > 0 && !p.preferTextToolCalls
    return this.client.chat.completions.create(
      {
        model: p.model,
        messages: toOpenAIMessages(p.messages),
        tools: sendNative ? p.tools : undefined,
        tool_choice: sendNative ? 'auto' : undefined,
        temperature: p.temperature,
        max_tokens: p.maxTokens ?? undefined,
        stream: true,
        stream_options: { include_usage: true }
      },
      { signal: p.signal }
    )
  }

  /** W1c: when the configured model can't be brought back (deleted, or the user deliberately loaded a
   *  DIFFERENT model — force-reloading ours would fight their swap for VRAM), follow the swap instead:
   *  if exactly ONE other model is loaded, that's unambiguously "the model" now. Null = don't guess. */
  private async soleLoadedAlternative(model: string): Promise<string | null> {
    const loaded = await fetchLoadedModelIds(this.baseURL)
    if (!loaded) return null
    const others = loaded.filter((id) => id !== model)
    return others.length === 1 ? others[0] : null
  }

  /** Model-eviction/model-swap recovery shared by the streaming and non-streaming paths: reload-and-retry
   *  once (idle TTL / VRAM grab), then follow an unambiguous model swap once. Anything else propagates. */
  private async withModelRecovery<T>(p: ChatStreamParams, run: (pp: ChatStreamParams) => Promise<T>): Promise<T> {
    try {
      return await run(p)
    } catch (e) {
      if (!isModelUnloadedError(e) || p.signal.aborted) throw e
      await ensureModelLoaded(this.baseURL, p.model, p.reloadCtx ?? DEFAULT_RELOAD_CTX)
      if (p.signal.aborted) throw e
      try {
        return await run(p) // retry once after the reload — covers eviction (idle TTL, VRAM grab)
      } catch (e2) {
        if (!isModelUnloadedError(e2) || p.signal.aborted) throw e2
        const alt = await this.soleLoadedAlternative(p.model)
        if (!alt) throw e2
        p.onNotice?.(`Model '${p.model}' is no longer available in LM Studio — continuing with the loaded model '${alt}'.`)
        return await run({ ...p, model: alt })
      }
    }
  }

  /** Streaming chat completion with tools. Throws on connection failure. Self-heals a mid-run model eviction:
   *  if the call fails because the model was unloaded, reload it (best-effort, no-op for cloud backends) and
   *  retry ONCE — so an idle TTL or a VRAM grab by another app doesn't kill the ticket. If the configured
   *  model is GONE and exactly one other model is loaded, it follows the swap (W1c) with a notice. */
  async chatStream(p: ChatStreamParams): Promise<AsyncIterable<ChatChunk> & { controller: AbortController }> {
    return this.withModelRecovery(p, (pp) => this.openStream(pp))
  }

  private openComplete(p: ChatStreamParams): Promise<ChatCompletion> {
    const sendNative = (p.tools?.length ?? 0) > 0 && !p.preferTextToolCalls
    return this.client.chat.completions.create(
      {
        model: p.model,
        messages: toOpenAIMessages(p.messages),
        tools: sendNative ? p.tools : undefined,
        tool_choice: sendNative ? 'auto' : undefined,
        temperature: p.temperature,
        max_tokens: p.maxTokens ?? undefined,
        stream: false
      },
      { signal: p.signal }
    )
  }

  /** Non-streaming sibling of {@link chatStream}, with the same model-eviction/model-swap recovery. */
  async chatComplete(p: ChatStreamParams): Promise<ChatCompletion> {
    return this.withModelRecovery(p, (pp) => this.openComplete(pp))
  }
}

/**
 * Back-compat alias. The original single-endpoint class was `LMStudioClient`; it is now the generic
 * OpenAI-compat client. Existing imports keep working while new code uses `OpenAICompatClient`.
 */
export const LMStudioClient = OpenAICompatClient
export type LMStudioClient = OpenAICompatClient

/** Build a live backend client from a persisted Connection config. */
export function createConnectionClient(conn: Pick<Connection, 'baseURL' | 'apiKey'>): LLMConnection {
  return new OpenAICompatClient({ baseURL: conn.baseURL, apiKey: conn.apiKey })
}

/** Convert our decoupled transcript into the OpenAI SDK param shape. */
export function toOpenAIMessages(
  messages: ChatMessage[]
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'assistant': {
        const out: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: m.content ?? ''
        }
        if (m.toolCalls && m.toolCalls.length) {
          out.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments }
          }))
        }
        return out
      }
      case 'tool':
        return {
          role: 'tool',
          tool_call_id: m.toolCallId ?? '',
          content: m.content ?? ''
        }
      case 'system':
        return { role: 'system', content: m.content ?? '' }
      default: {
        // A user message with images becomes multimodal content (text part + image_url parts),
        // which LM Studio forwards to a vision model. Text-only messages stay plain strings.
        if (m.images && m.images.length) {
          const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = []
          if (m.content) parts.push({ type: 'text', text: m.content })
          for (const url of m.images) parts.push({ type: 'image_url', image_url: { url } })
          return { role: 'user', content: parts }
        }
        return { role: 'user', content: m.content ?? '' }
      }
    }
  })
}
