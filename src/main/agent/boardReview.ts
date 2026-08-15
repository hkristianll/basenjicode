// Pure review decision + verdict parsing — no electron, unit-tested. The reviewer's verdict is what lets
// the loop REJECT work and send it back, instead of rubber-stamping every ticket into "review".

export interface ReviewVerdict {
  approved: boolean
  feedback: string
  /** The reviewer could not be reached/run at all (network/config failure) — distinct from a genuine
   *  approve/reject. The flow routes this to human review instead of rubber-stamping the ticket done. */
  unreachable?: boolean
  /** Team-lead memory (Phase 2): the lead's UPDATED team memory (full new content), emitted in a <memory> block
   *  only when this ticket taught a durable, non-obvious fact. undefined = leave the team memory unchanged. */
  memoryUpdate?: string
}

export type ReviewDecision = { kind: 'done' } | { kind: 'iterate'; attempt: number } | { kind: 'park'; reason: string }

/** Approve → done; changes-requested with rounds left → iterate (re-run the worker); at the cap → park. */
export function decideReview(input: { approved: boolean; attemptsSoFar: number; maxAttempts: number }): ReviewDecision {
  if (input.approved) return { kind: 'done' }
  if (input.attemptsSoFar < input.maxAttempts) return { kind: 'iterate', attempt: input.attemptsSoFar + 1 }
  return { kind: 'park', reason: `parked after ${input.maxAttempts} review rounds — changes still requested` }
}

/** Pull a {approved, feedback} verdict out of the reviewer's free text. Prefers a JSON object; falls back
 *  to a keyword heuristic. Defaults to NOT approved when unsure, so a garbled verdict never auto-passes. */
export function parseVerdict(text: string): ReviewVerdict {
  // Team-lead memory (Phase 2): a <memory>…</memory> block carries the updated team memory, parsed SEPARATELY
  // from the verdict JSON so a malformed or large memory block can never break the approve/reject decision.
  const memMatch = text.match(/<memory>([\s\S]*?)<\/memory>/i)
  const memoryUpdate = memMatch?.[1].trim() || undefined

  // Scan EVERY balanced top-level object and use the one whose body has a boolean `approved` — so a stray
  // brace-object in the reviewer's prose (a fenced example, a preamble) can't capture the verdict, and a brace
  // INSIDE the feedback string can't end the match early (the two bugs in the old lazy `{…"approved"…}` regex).
  const s = text.replace(/```(?:json)?/gi, '')
  for (let start = s.indexOf('{'); start !== -1; start = s.indexOf('{', start + 1)) {
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < s.length; i++) {
      const c = s[i]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}') {
        if (--depth === 0) {
          try {
            const o = JSON.parse(s.slice(start, i + 1)) as { approved?: unknown; feedback?: unknown }
            if (typeof o.approved === 'boolean') {
              return { approved: o.approved, feedback: String(o.feedback ?? '').slice(0, 2000).trim(), memoryUpdate }
            }
          } catch {
            /* not the verdict object — try the next top-level object */
          }
          break // this object closed without an `approved` boolean; advance to the next `{`
        }
      }
    }
  }
  // Heuristic fallback — TIGHTENED: only explicit reject phrases. The incidental 'incomplete'/'does not'/
  // "doesn't" were dropped because they flipped approving prose like "does not break anything" to REJECTED.
  const lower = text.toLowerCase()
  const rejected = /\b(request changes|changes requested|not approved|reject)\b/.test(lower)
  const approved = !rejected && /\bapprove(d)?\b/.test(lower)
  return { approved, feedback: text.slice(0, 2000).trim(), memoryUpdate }
}
