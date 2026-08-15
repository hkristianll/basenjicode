import type { ChatMessage } from '../../shared/domain-types'

/**
 * W1a resumable streams — the pure machinery behind mid-stream drop recovery.
 *
 * A stream that dies AFTER emitting deltas used to end the whole turn as conn_error (26% of turns in the
 * 2026-06/07 instrumentation; it killed a 129-turn run at the finish line). The loop now re-requests the
 * completion with the already-emitted partial prefilled back as the assistant's own words, and de-duplicates
 * the regenerated overlap so the UI never sees repeated content. Everything decision-shaped lives here,
 * headless-testable; loop.ts only wires it into streamCompletion.
 */

/** Max resume attempts per completion (fresh each completion, like the connect-retry budget). */
export const MAX_STREAM_RESUMES = 2

/** How much regenerated text to hold back before the one-shot overlap trim in {@link OverlapTrimmer}. */
const HOLDBACK_CHARS = 240

/** Overlaps shorter than this are not trimmed: a tiny prefix ("the ", a newline) matching the committed
 *  tail is far more likely chance than repetition, and a false trim silently eats legitimate text. */
const MIN_OVERLAP_CHARS = 12

/**
 * True for the transport-shaped failures worth resuming: the socket died, the response body ended early,
 * the fetch layer gave up. Deliberately EXCLUDES abort (user stop and the stall watchdog both abort — the
 * caller checks those first) and HTTP-status errors (4xx/5xx are server verdicts, handled by the existing
 * connect-retry / model-reload paths, not evidence of a broken pipe mid-stream).
 */
export function isMidStreamDropError(e: unknown): boolean {
  if (!e) return false
  const name = (e as Error)?.name ?? ''
  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') return true
  const code = (e as { code?: string })?.code ?? ''
  if (['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED', 'UND_ERR_SOCKET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(code)) return true
  const parts: string[] = []
  if ((e as Error)?.message) parts.push((e as Error).message)
  const o = e as { error?: { message?: string } } | null
  if (o?.error?.message) parts.push(o.error.message)
  const s = parts.join(' ')
  return /ECONNRESET|socket hang ?up|premature close|fetch failed|network error|terminated|connection (error|closed|reset|lost)|stream (closed|destroyed|ended unexpectedly)/i.test(s)
}

/**
 * The resumed request: the original messages, plus the model's own partial reply as a completed assistant
 * turn, plus a steer to continue rather than restart. Weak local models follow this reliably (it is the
 * same shape as the thinking-prefill recovery); the regenerated lead-in that models still tend to repeat
 * is what {@link OverlapTrimmer} removes.
 */
export function buildResumeMessages(messages: ChatMessage[], committedText: string): ChatMessage[] {
  return [
    ...messages,
    { role: 'assistant', content: committedText },
    {
      role: 'system',
      content:
        'Your previous reply was cut off mid-stream by a connection error. Continue EXACTLY where your text above left off — do not repeat anything already written, do not restart the reply, and do not apologize for the interruption. If a tool call was cut off before it was complete, re-issue that tool call in full from its beginning.'
    }
  ]
}

/**
 * De-duplicates the seam between the already-emitted partial and a resumed stream. Holds back the first
 * {@link HOLDBACK_CHARS} of the continuation, then trims the longest prefix that repeats the committed
 * tail, once; everything after passes through untouched. Emitted text therefore never repeats, and if the
 * model genuinely continued (no overlap) nothing is lost.
 */
export class OverlapTrimmer {
  private buf = ''
  private settled = false
  private readonly tail: string

  constructor(committedText: string) {
    // Only the tail can overlap; keep a little more than the holdback so a full-holdback repeat still matches.
    this.tail = committedText.slice(-(HOLDBACK_CHARS * 2))
  }

  /** Feed a stream chunk; returns the part that is now safe to emit ('' while still buffering). */
  push(chunk: string): string {
    if (this.settled) return chunk
    this.buf += chunk
    if (this.buf.length < HOLDBACK_CHARS) return ''
    return this.settle()
  }

  /** End of stream — settle and return whatever is still held back. */
  flush(): string {
    if (this.settled) return ''
    return this.settle()
  }

  private settle(): string {
    this.settled = true
    const max = Math.min(this.tail.length, this.buf.length)
    for (let k = max; k >= MIN_OVERLAP_CHARS; k--) {
      if (this.tail.endsWith(this.buf.slice(0, k))) return this.buf.slice(k)
    }
    return this.buf
  }
}
