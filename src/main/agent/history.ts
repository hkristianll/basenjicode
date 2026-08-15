import type { ChatMessage } from '../../shared/domain-types'

/**
 * Guarantee transcript well-formedness: every assistant `tool_calls` entry must be followed by a
 * matching `{role:'tool'}` reply, or the next request to the model is malformed (HTTP 400). When a
 * turn is cancelled mid-batch some replies are missing — stub them so the session never bricks.
 */
export function repairTranscript(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    // A legitimate tool reply is consumed inside the assistant branch below (which advances i past
    // it). Any tool message reached here has no preceding assistant tool_calls — it's an orphan that
    // makes the next request 400 ("tool message without preceding tool_calls"). Drop it.
    if (m.role === 'tool') continue
    out.push(m)
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      const replied = new Set<string>()
      let j = i + 1
      while (j < messages.length && messages[j].role === 'tool') {
        const id = messages[j].toolCallId
        if (id) replied.add(id)
        out.push(messages[j])
        j++
      }
      for (const tc of m.toolCalls) {
        if (!replied.has(tc.id)) {
          out.push({ role: 'tool', toolCallId: tc.id, content: 'CANCELLED: tool was interrupted before it ran.' })
        }
      }
      i = j - 1
    }
  }
  return out
}

/**
 * Rough token estimate: chars/4 plus ~4 tokens of role/delimiter framing per message.
 * chars/4 is calibrated for English prose and *underestimates* code/JSON (closer to chars/2.7),
 * so callers scale the result with a learned factor — see {@link calibrateScale}.
 */
/**
 * Rough per-image token cost. Vision models bill by tiled resolution, NOT by data-URL byte length,
 * so we charge a flat ~1500-token estimate per attached image rather than the (huge) base64 length.
 */
const IMAGE_TOKEN_CHARS = 1500 * 4

export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0
  for (const m of messages) {
    chars += m.content?.length ?? 0
    if (m.toolCalls) for (const tc of m.toolCalls) chars += tc.arguments.length + tc.name.length
    if (m.images) chars += m.images.length * IMAGE_TOKEN_CHARS
  }
  return Math.ceil(chars / 4) + messages.length * 4
}

/**
 * Tokens consumed by the tool-schema payload sent on EVERY request (names + descriptions + JSON
 * schemas). estimateTokens only counts the chat messages, so without this the budget undershoots by
 * a fixed few-thousand tokens — which made calibrateScale ratchet to its 4x ceiling on long sessions
 * and over-trim history. Counting it keeps the scale near the real tokenizer ratio.
 */
export function estimateToolsTokens(tools: readonly unknown[]): number {
  if (!tools?.length) return 0
  let chars = 0
  for (const t of tools) {
    const fn = (t as { function?: { name?: string; description?: string; parameters?: unknown } }).function
    chars += (fn?.name?.length ?? 0) + (fn?.description?.length ?? 0)
    try {
      chars += JSON.stringify(fn?.parameters ?? {}).length
    } catch {
      /* unserialisable schema — skip */
    }
  }
  return Math.ceil(chars / 4) + tools.length * 4
}

/**
 * Ratchet the estimate→real token scale up from observed usage. LM Studio reports the true
 * `prompt_tokens` each turn; comparing that to what we estimated for the same payload tells us how
 * far chars/4 undershoots for this conversation's content. We keep the worst case seen (never relax
 * within a session) plus a 10% safety margin, so the next trim budget reflects reality.
 */
export function calibrateScale(prev: number, estSent: number, realTokens: number): number {
  if (estSent <= 0 || realTokens <= 0) return prev
  const observed = (realTokens / estSent) * 1.1
  // Anomaly rejection: a single turn can't more than double the scale. One pathological turn (a giant
  // pasted blob/image inflating real prompt_tokens) shouldn't permanently ratchet the scale toward the
  // 4x ceiling and over-trim every later turn — sustained undershoot still climbs over a few turns.
  const capped = Math.min(observed, prev * 2)
  // Gentle decay floor so a one-off historical spike relaxes over a long session instead of sticking
  // forever (the old hard Math.max(prev, …) never relaxed, so one bad turn was permanent).
  const floor = prev * 0.98
  return Math.min(4, Math.max(floor, capped))
}

// Idempotent file-read tools whose repeated identical calls are safe to collapse to just the latest result:
// re-reading the same path/dir/search supersedes the earlier copy. Deliberately conservative — excludes
// shell/web/preview (which can be intentionally repeated or time-varying).
const DEDUP_READ_TOOLS = new Set(['read_file', 'list_dir', 'grep', 'glob'])

/**
 * Collapse repeated IDENTICAL reads down to the latest copy. A weak model re-reads the same file/dir/search
 * many times; every full copy then sits in context and inflates it, pushing the model toward its degraded
 * zone and triggering compaction sooner. For each dedup-eligible read call with identical arguments, keep the
 * LAST result intact and replace the earlier ones with a one-line stub pointing at it. The transcript stays
 * well-formed (a stubbed tool message is still a tool message, so tool_calls↔reply pairing is preserved).
 *
 * Callers pass the per-request sendable copy, so this never mutates the saved transcript and changes nothing
 * about the configured context window — it only keeps what's SENT lean. Returns the stub count and exact
 * content characters removed for per-request composition telemetry.
 */
export function dedupeReads(messages: ChatMessage[]): { stubbed: number; savedChars: number } {
  // toolCallId → signature (tool name + exact args) for the dedup-eligible read calls
  const sigByCall = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) {
        if (DEDUP_READ_TOOLS.has(tc.name)) sigByCall.set(tc.id, `${tc.name}\u0000${tc.arguments}`)
      }
    }
  }
  if (sigByCall.size === 0) return { stubbed: 0, savedChars: 0 }
  // The newest tool-message index for each signature — the one copy we keep.
  const lastIdx = new Map<string, number>()
  messages.forEach((m, i) => {
    if (m.role === 'tool' && m.toolCallId) {
      const sig = sigByCall.get(m.toolCallId)
      if (sig) lastIdx.set(sig, i)
    }
  })
  let stubbed = 0
  let savedChars = 0
  messages.forEach((m, i) => {
    if (m.role !== 'tool' || !m.toolCallId) return
    const sig = sigByCall.get(m.toolCallId)
    if (!sig || lastIdx.get(sig) === i) return // not eligible, or this IS the latest copy
    if (typeof m.content !== 'string' || m.content.length <= 200) return // too small to be worth stubbing
    const content = '[earlier identical read — superseded by the latest result of the same call below]'
    savedChars += m.content.length - content.length
    messages[i] = { ...m, content }
    stubbed++
  })
  return { stubbed, savedChars }
}

export interface SendableComposition {
  sendableMsgs: number
  dedupeSavedChars: number
  trimmedMsgs: number
  imageCount: number
  imageBytes: number
  toolsTokens: number
}

/** Pure accounting for the final request message list. Mutation remains exclusively in dedupeReads and
 *  trimHistory; this helper only reports what the already-built payload contains. */
export function countSendableComposition(
  messages: readonly ChatMessage[],
  build: Pick<SendableComposition, 'dedupeSavedChars' | 'trimmedMsgs' | 'toolsTokens'>
): SendableComposition {
  let imageCount = 0
  let imageBytes = 0
  for (const message of messages) {
    for (const image of message.images ?? []) {
      imageCount++
      imageBytes += Buffer.byteLength(image, 'utf8')
    }
  }
  return {
    sendableMsgs: messages.length,
    dedupeSavedChars: build.dedupeSavedChars,
    trimmedMsgs: build.trimmedMsgs,
    imageCount,
    imageBytes,
    toolsTokens: build.toolsTokens
  }
}

export function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i
  }
  return messages.length - 1
}

/**
 * Trim oldest exchanges until the transcript fits the budget, then guarantee a model-valid shape.
 * Exchanges are dropped as whole units (a user turn plus the assistant/tool messages that answer it,
 * up to the next user turn) so a `tool_calls` message is never split from its replies. The system
 * prompt (index 0) and the most recent user turn are always kept. Mutates `messages` in place.
 *
 * Critically, the first non-system message must be a `user` message: some chat templates (e.g.
 * Qwen3) throw "No user query found in messages" otherwise. Both the drop logic and a final cleanup
 * enforce this. Returns the number of messages dropped.
 */
export function trimHistory(
  messages: ChatMessage[],
  contextLimitTokens: number,
  reserveTokens: number,
  scale = 1.4
): number {
  const budget = contextLimitTokens - reserveTokens - 2000
  const over = (): boolean => estimateTokens(messages) * scale > budget
  let dropped = 0

  // 1. Drop whole oldest exchanges (messages[1] through just before the next user turn) until we fit.
  if (budget > 0) {
    while (over()) {
      const protect = lastUserIndex(messages)
      if (protect <= 1) break // only the system prompt + last user turn remain — stop
      let count = 1
      while (1 + count < messages.length && messages[1 + count].role !== 'user') count++
      messages.splice(1, count)
      dropped += count
    }
  }

  // 2. Enforce user-first: drop any leading orphaned assistant/tool messages (after the system
  //    block) so the first real message is a user turn. No-op for a normal transcript.
  if (messages.some((m) => m.role === 'user')) {
    let i = 1
    while (i < messages.length && messages[i].role === 'system') i++
    while (i < messages.length && messages[i].role !== 'user') {
      messages.splice(i, 1)
      dropped++
    }
  }

  // 3. A long agentic turn accumulates large tool outputs AFTER the last user message, which the
  //    exchange-drop above can't touch (it protects everything from the last user turn onward). If
  //    we're still over budget, stub the OLDEST tool outputs — keeping the most recent intact — so
  //    the model keeps the context it needs to continue while we reclaim space.
  let compacted = false
  if (budget > 0 && over()) {
    for (let i = 1; i < messages.length && over(); i++) {
      const m = messages[i]
      if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 120) {
        messages[i] = { ...m, content: '[earlier tool output trimmed to fit the context window]' }
        compacted = true
      }
    }
  }

  // 4. Note the truncation for the model.
  if (dropped > 0 || compacted) {
    messages.splice(1, 0, {
      role: 'system',
      content: '[Earlier conversation truncated to fit the context window.]'
    })
  }

  // 5. Last resort: if the protected messages (system + last user) alone exceed the budget, shrink
  //    the last user message (keep head + tail) so we never hand the model an overfull prompt.
  if (budget > 0 && over()) {
    const li = lastUserIndex(messages)
    const msg = messages[li]
    if (li >= 1 && typeof msg.content === 'string' && msg.content.length > 400) {
      let content = msg.content
      while (content.length > 400 && over()) {
        const keep = Math.floor(content.length / 2)
        const head = Math.ceil(keep / 2)
        const tail = keep - head
        content =
          content.slice(0, head) +
          '\n\n[... middle truncated to fit the context window ...]\n\n' +
          content.slice(content.length - tail)
        messages[li] = { ...msg, content }
      }
    }
  }

  return dropped
}
