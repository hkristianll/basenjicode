// A worker's proactive "I'm stuck" signal. A per-ticket worker has no direct channel to its lead mid-turn, so the
// escalate_to_lead tool drops its reason HERE and boardFlow picks it up right after the turn, routing it into the
// existing lead-rescue. The board drain is SEQUENTIAL (one worker turn at a time) and the flow takes+clears this
// after every turn, so a single module-level slot is safe — no per-ticket keying needed.
let pending: string | null = null

/** The worker called escalate_to_lead — record WHY it is stuck for the flow to hand to the lead rescue. */
export function recordEscalation(reason: string): void {
  pending = reason.trim() || 'the worker is stuck but gave no reason'
}

/** Read AND clear the pending escalation (null when the worker did not escalate this turn). */
export function takeEscalation(): string | null {
  const r = pending
  pending = null
  return r
}
