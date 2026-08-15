// Pure, dependency-light helpers for the per-ticket inner loop (no AgentSession import, so they unit-test
// without pulling the model stack). The heavy runTicketTurn (which builds an AgentSession) lives in boardInner.ts.
import type { Emit } from './events'
import type { AgentEvent, StopReason } from '../../shared/ipc-types'
import type { BoardTicket } from './boardRunner'

export interface TicketTurnResult {
  ticketId: number
  turnId: string
  stopReason: StopReason
  error?: string
  notice?: string
  editedFiles: number
  promptTokens: number
  /** Cumulative OUTPUT tokens for the turn (W3c) — summed with promptTokens into the token cap. */
  completionTokens?: number
  /** One-line gist of the turn (the model's own final message) — the scannable card subtitle. */
  summary: string
  /** The turn's full final assistant text — used as the PLAN body for a plan-mode turn (plan-gate). */
  text: string
}

/** First non-empty line, trimmed + capped — a card-subtitle-sized gist. */
function oneLine(s: string): string {
  const line = s.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  return line.length > 100 ? line.slice(0, 100) + '…' : line
}

const SPEC_CAP = 16_000

const FEEDBACK_CAP = 4_000

/** A team lead's per-ticket brief is a thumbnail — keep it tiny so the worker stays lean (team-leads Phase 3). */
const BRIEF_CAP = 800

// R4: the title+body and the check were the only UNSLICED fields in the seed (every other field is capped:
// spec 16k, brief 800, feedback 4k×3). A runaway ticket body/check could push the seed past the lean budget, so
// cap them too — generous enough for any real ticket, bounded enough that the seed floor stays small.
const BODY_CAP = 8_000
const CHECK_CAP = 2_000

const PLAYBOOK_CAP = 4_000

/** The single user message that seeds a ticket's fresh agent turn: title + body, the spec when present, and
 *  — on a retry — the reason the previous attempt was rejected, so the revision actually addresses it. */
export function buildSeedMessage(
  ticket: Pick<BoardTicket, 'title' | 'body' | 'check' | 'spec_ref'>,
  spec?: string | null,
  revision?: { attempt: number; feedback: string },
  approvedPlan?: string,
  priorProgress?: string | null,
  leadBrief?: string,
  relevantFiles?: string[],
  projectPlaybook?: string | null
): string {
  let msg = `${ticket.title}\n\n${(ticket.body || '(no description)').slice(0, BODY_CAP)}`
  // Point the worker at the files it actually needs + a lean-research directive, so it doesn't read the whole
  // codebase to start a focused ticket (the "20k tokens of research before writing a line" problem). The list is a
  // cheap server-side relevance scan (relevantFiles.ts); the directive keeps reading targeted without starving it.
  if (relevantFiles && relevantFiles.length) {
    msg += `\n\n--- Files likely relevant to this ticket (start here; read only what you need) ---\n${relevantFiles.map((f) => `- ${f}`).join('\n')}`
  }
  msg +=
    '\n\n--- Work efficiently (do not over-research) ---\nRead ONLY the files this ticket creates, edits, or directly ' +
    'integrates with — the list above is your starting point. For a LARGE file, search/grep for the specific function ' +
    'or export you need instead of reading it end-to-end. Skip unrelated files and get to the implementation quickly; ' +
    'read more only if you hit a real gap.'
  msg +=
    '\n\n--- Import paths (get these right — a wrong path FAILS the build) ---\nImports are RELATIVE to the importing ' +
    "file's own location: a file in `src/game/` imports a sibling as `./Name` and a cousin as `../entities/Name`. " +
    'NEVER prefix an in-`src` import with `../src/…` (a common mistake). Put a test BESIDE the code it tests and import ' +
    'it with `./Name`.'
  if (projectPlaybook?.trim()) {
    msg += `\n\n--- Project playbook (apply to this ticket) ---\n${projectPlaybook.trim().slice(0, PLAYBOOK_CAP)}`
  }
  if (ticket.spec_ref && spec) msg += `\n\n--- Spec (${ticket.spec_ref}) ---\n${spec.slice(0, SPEC_CAP)}`
  // Team-lead brief (Phase 3): the lead distilled its team memory to what matters for THIS ticket, so the worker
  // gets a thumbnail of the team's craft instead of re-deriving it (or carrying the whole memory).
  if (leadBrief?.trim()) msg += `\n\n--- Your team lead's brief for this ticket (apply it) ---\n${leadBrief.slice(0, BRIEF_CAP).trim()}`
  if (ticket.check?.trim()) {
    msg += `\n\n--- Verification check (must pass) ---\n${ticket.check.trim().slice(0, CHECK_CAP)}\nFix the project work this verifies. Do not manipulate shell aliases, profiles, PATH, or create workaround scripts unless the ticket explicitly asks for them.`
  }
  // Durable intra-ticket progress from an earlier (interrupted) attempt/run — so a resumed big ticket continues
  // instead of restarting. Placed before the plan/revision so those still have the last word.
  if (priorProgress && priorProgress.trim()) {
    msg += `\n\n--- Progress so far (continue from here, do NOT restart) ---\n${priorProgress.slice(0, FEEDBACK_CAP).trim()}`
  }
  // A human-approved (possibly edited) plan — the act turn must follow it (plan-gate). Placed before the
  // revision section so retry feedback still has the last word.
  if (approvedPlan && approvedPlan.trim()) {
    msg += `\n\n--- Approved plan (follow it) ---\n${approvedPlan.slice(0, FEEDBACK_CAP).trim()}`
  }
  if (revision && revision.feedback.trim()) {
    msg += `\n\n--- Revision (attempt ${revision.attempt}) ---\nYour previous attempt was rejected. Address this feedback, then finish:\n${revision.feedback.slice(0, FEEDBACK_CAP).trim()}`
  }
  return msg
}

/**
 * Run one agent turn (injected as `run`) and distill its emitted events into a TicketTurnResult. runTurn
 * returns void — the outcome arrives through the emit callback: the LAST `usage` event is the turn's token
 * cost, and `turn-done` carries the stop reason. A thrown run is coerced to stopReason 'error' so one
 * ticket can never kill the outer loop. `forward` re-streams every inner event to the Loop activity feed.
 */
export async function captureTurn(
  turnId: string,
  ticketId: number,
  run: (emit: Emit) => Promise<void>,
  forward?: (e: AgentEvent) => void
): Promise<TicketTurnResult> {
  let stopReason: StopReason = 'completed'
  let error: string | undefined
  let notice: string | undefined
  let editedFiles = 0
  let promptTokens = 0
  let completionTokens = 0
  let assistant = ''
  const emit: Emit = (e) => {
    if (e.type === 'usage') {
      promptTokens = e.promptTokens
      completionTokens = e.completionTokens ?? completionTokens // cumulative from the loop — last wins = turn total
    }
    if (e.type === 'assistant-delta') assistant += e.text
    if (e.type === 'assistant-message-done' && e.finalText) assistant = e.finalText
    if (e.type === 'turn-done') {
      stopReason = e.stopReason
      error = e.error
      notice = e.notice
      editedFiles = e.editedFiles ?? 0
    }
    forward?.(e)
  }
  try {
    await run(emit)
  } catch (e) {
    stopReason = 'error'
    error = e instanceof Error ? e.message : String(e)
  }
  return { ticketId, turnId, stopReason, error, notice, editedFiles, promptTokens, completionTokens, summary: oneLine(assistant), text: assistant }
}

const BOARD_URL = (process.env.TICKET_BOARD_URL || 'http://127.0.0.1:8930').replace(/\/+$/, '')

/** Best-effort fetch of a project's saved spec content; null on missing/unreachable (must not abort a ticket). */
export async function fetchSpec(project: string): Promise<string | null> {
  try {
    const res = await fetch(`${BOARD_URL}/api/spec?project=${encodeURIComponent(project)}`)
    if (!res.ok) return null
    const data = (await res.json().catch(() => null)) as { content?: string } | null
    return data?.content ?? null
  } catch {
    return null
  }
}
