import { useEffect, useRef, useState } from 'react'
import type { LoopEvent } from '../../shared/ipc-types'
import type { TodoItem } from '../../shared/domain-types'
import { verbOf, argTarget, shortArg } from '../toolVerb'

/** Latest todos checklist emitted by the selected ticket's session (the "what is it doing now" primitive). */
function latestTodos(events: LoopEvent[], id: number): TodoItem[] {
  let todos: TodoItem[] = []
  for (const e of events) {
    if (e.kind === 'agent-event' && e.id === id && e.event.type === 'todos') todos = e.event.todos
  }
  return todos
}

/** Latest reviewer verdict for the ticket — the thing that makes the loop a loop. */
function latestReview(events: LoopEvent[], id: number): { approved: boolean; feedback: string; round: number } | null {
  let r: { approved: boolean; feedback: string; round: number } | null = null
  for (const e of events) {
    if (e.kind === 'review-result' && e.id === id) r = { approved: e.approved, feedback: e.feedback, round: e.round }
  }
  return r
}

/** A plan-gate plan still awaiting the user's verdict: the latest plan-ready for this ticket with no later
 *  ticket-scoped activity (the act turn hasn't started → the gate is still open). Returns the plan plus the
 *  feed index of its plan-ready event as a stable identity, so the UI can detect a RE-gate (same ticket,
 *  new plan after a retry) and reset its verdict state. Stateless, derived from the feed. */
function pendingPlan(events: LoopEvent[], id: number): { plan: string; key: number } | null {
  let plan: string | null = null
  let planIdx = -1
  events.forEach((e, i) => {
    if (e.kind === 'plan-ready' && e.id === id) {
      plan = e.plan
      planIdx = i
    }
  })
  if (planIdx === -1 || plan === null) return null
  const started = events.slice(planIdx + 1).some(
    (e) =>
      'id' in e &&
      (e as { id: number }).id === id &&
      (e.kind === 'agent-event' || e.kind === 'check-result' || e.kind === 'review-result' || e.kind === 'ticket-done' || e.kind === 'ticket-failed')
  )
  return started ? null : { plan, key: planIdx }
}

/** The per-ticket work pane: live plan checklist + worktree diff + per-ticket activity + a reply box. */
export function TicketDetail({
  ticket,
  events,
  isActive,
  status,
  onClose
}: {
  ticket: { id: number; title: string }
  events: LoopEvent[]
  isActive: boolean
  /** Live board status of this ticket (todo|in_progress|review|done|cancelled), for gating skip/retry. */
  status?: string
  onClose: () => void
}) {
  const todos = latestTodos(events, ticket.id)
  const review = latestReview(events, ticket.id)
  const ticketEvents = events.filter((e) => 'id' in e && (e as { id: number }).id === ticket.id)
  const activity = buildActivity(ticketEvents)
  const pending = pendingPlan(events, ticket.id)
  const planText = pending?.plan ?? null
  const planKey = pending?.key ?? null
  const [diff, setDiff] = useState('')
  const [reply, setReply] = useState('')
  const [posted, setPosted] = useState(false)
  const [planDraft, setPlanDraft] = useState('')
  const [planSubmitted, setPlanSubmitted] = useState(false)

  // Reset the plan-gate verdict + re-seed the editable draft whenever a NEW plan appears — keyed on the
  // plan-ready event's feed index so a re-gate of the SAME ticket (after a retry) re-opens the gate too,
  // not only a ticket switch. Editing the draft and toggling away/back to the same open plan is preserved.
  const seededKey = useRef<number | null>(null)
  useEffect(() => {
    if (planKey !== null && planKey !== seededKey.current) {
      seededKey.current = planKey
      setPlanDraft(planText ?? '')
      setPlanSubmitted(false)
    }
  }, [planKey, planText])

  // Live worktree diff for the active ticket; refresh as its events stream. Non-active → no live diff.
  useEffect(() => {
    if (!isActive) {
      setDiff('')
      return
    }
    let live = true
    window.api.loop
      .diff()
      .then((d) => {
        if (live) setDiff(d)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [isActive, ticket.id, events.length])

  async function send(): Promise<void> {
    const text = reply.trim()
    if (!text) return
    try {
      await window.api.loopBoard.comment(ticket.id, text)
      setReply('')
      setPosted(true)
      setTimeout(() => setPosted(false), 1500)
    } catch {
      /* board down — keep the text so the user can retry */
    }
  }

  const act = (action: 'pause' | 'stop' | 'skip' | 'retry'): void => {
    void window.api.loop.ticketAction({ id: ticket.id, action })
  }
  const decidePlan = (decision: 'approve' | 'reject'): void => {
    setPlanSubmitted(true)
    void window.api.loop.planDecision({ id: ticket.id, decision, editedPlan: decision === 'approve' ? planDraft : undefined })
  }
  const showPlanGate = planText !== null && !planSubmitted
  // Skip only makes sense on a still-queued ticket — skipping a finished (done/review) one would demote it and
  // re-gate its dependents. Retry is offered on any non-active ticket (re-run a parked/finished one).
  const canSkip = status === 'todo'
  const doneTodos = todos.filter((td) => td.status === 'completed').length
  const todoProgress = todos.length > 0 ? `${doneTodos}/${todos.length}` : 'none'
  const statusLabel = isActive ? 'active' : status ?? 'queued'
  const statusClass = statusLabel.replace(/_/g, '-')
  const reviewLabel = review ? `round ${review.round} ${review.approved ? 'approved' : 'changes'}` : 'not reviewed'

  return (
    <div className="ticket-detail">
      <div className="ticket-detail-head">
        <div className="ticket-detail-title-block">
          <span className="ticket-detail-kicker">Ticket #{ticket.id}</span>
          <span className="ticket-detail-title">{ticket.title}</span>
        </div>
        <div className="ticket-detail-actions">
          {isActive ? (
            <>
              <button className="btn ghost" onClick={() => act('pause')} title="Pause the run at the next ticket boundary">
                Pause
              </button>
              <button className="btn reject" onClick={() => act('stop')} title="Abort this ticket's in-flight turn; the run continues to the next ticket">
                Stop
              </button>
            </>
          ) : (
            <>
              <button className="btn ghost" onClick={() => act('retry')} title="Re-queue this ticket so the drain runs it again">
                Retry
              </button>
              {canSkip && (
                <button className="btn ghost" onClick={() => act('skip')} title="Set this ticket aside for this run (moves it to review)">
                  Skip
                </button>
              )}
            </>
          )}
        </div>
        <button className="icon-btn ticket-close" onClick={onClose} aria-label="Close detail">
          ×
        </button>
      </div>

      <div className="ticket-readout" aria-label="Ticket status summary">
        <div className={`ticket-readout-cell ticket-status-${statusClass}`}>
          <span>Status</span>
          <b>{statusLabel.replace(/_/g, ' ')}</b>
        </div>
        <div className="ticket-readout-cell">
          <span>Plan</span>
          <b>{todoProgress}</b>
        </div>
        <div className="ticket-readout-cell">
          <span>Activity</span>
          <b>{activity.length || 0} events</b>
        </div>
        <div className="ticket-readout-cell">
          <span>Review</span>
          <b>{reviewLabel}</b>
        </div>
      </div>

      <div className="ticket-detail-body">
      {showPlanGate && (
        <div className="ticket-section ticket-plan-gate">
          <div className="ticket-section-head">Plan — approve before editing</div>
          <textarea
            className="ticket-plan-edit"
            value={planDraft}
            onChange={(e) => setPlanDraft(e.target.value)}
            rows={10}
            spellCheck={false}
            aria-label="Editable plan"
          />
          <div className="ticket-plan-actions">
            <button className="btn primary" onClick={() => decidePlan('approve')} title="Run the worker on this (possibly edited) plan">
              Approve &amp; run
            </button>
            <button className="btn reject" onClick={() => decidePlan('reject')} title="Reject the plan; hand the ticket to review without editing">
              Reject
            </button>
          </div>
        </div>
      )}

      {review && (
        <div className="ticket-section">
          <div className="ticket-section-head">Review · round {review.round}</div>
          <span className={`review-verdict ${review.approved ? 'approved' : 'changes'}`}>
            {review.approved ? 'approved' : 'changes requested'}
          </span>
          {review.feedback && <div className="review-feedback">{review.feedback}</div>}
        </div>
      )}

      {todos.length > 0 && (
        <div className="ticket-section">
          <div className="ticket-section-head">Plan</div>
          <ul className="ticket-todos">
            {todos.map((td, i) => (
              <li key={i} className={`ticket-todo todo-${td.status}`}>
                <span className="todo-mark" aria-hidden="true">
                  {td.status === 'completed' ? '✓' : td.status === 'in_progress' ? '▸' : '◻'}
                </span>
                {td.content}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="ticket-section ticket-section-grow">
        <div className="ticket-section-head">Changes</div>
        {isActive ? (
          diff ? <DiffView text={diff} /> : <div className="ticket-empty">No uncommitted changes yet.</div>
        ) : (
          <div className="ticket-empty">Finished work is committed on the run branch — review it there.</div>
        )}
      </div>

      <div className="ticket-section">
        <div className="ticket-section-head">Activity</div>
        <div className="ticket-activity">
          {activity.length === 0 && <div className="ticket-empty">No activity yet.</div>}
          {activity.map((a, i) => (
            <ActivityRow key={i} a={a} />
          ))}
        </div>
      </div>
      </div>

      <div className="ticket-reply">
        <textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder={`Comment on #${ticket.id}…`} rows={2} />
        <button className="btn" disabled={!reply.trim()} onClick={() => void send()}>
          {posted ? 'Posted' : 'Comment'}
        </button>
      </div>
    </div>
  )
}

function DiffView({ text }: { text: string }) {
  return (
    <pre className="ticket-diff">
      {text.split('\n').map((line, i) => {
        const cls =
          line.startsWith('+') && !line.startsWith('+++')
            ? 'diff-add'
            : line.startsWith('-') && !line.startsWith('---')
              ? 'diff-del'
              : line.startsWith('@@')
                ? 'diff-hunk'
                : ''
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}

/** One coalesced row of the glass-box activity timeline. */
type ToolAct = { kind: 'tool'; name: string; arg: string; ok?: boolean; result?: string }
type Act =
  | { kind: 'say'; text: string }
  | ToolAct
  | { kind: 'note'; text: string; tone: 'ok' | 'err' | 'awaiting' | 'dim' }

/** Reduce the raw per-ticket event stream (which discards the worker's reasoning + tool acts today) into a
 *  readable timeline: streamed assistant text is accumulated into narration blocks, tool-call-proposed +
 *  tool-result are merged by callId into one row with a pass/fail badge, and loop milestones become notes. */
function buildActivity(events: LoopEvent[]): Act[] {
  const out: Act[] = []
  let buf = ''
  const flush = (): void => {
    const t = buf.trim()
    if (t) out.push({ kind: 'say', text: t })
    buf = ''
  }
  const toolByCall = new Map<string, ToolAct>()
  for (const e of events) {
    if (e.kind === 'agent-event') {
      const ev = e.event
      switch (ev.type) {
        case 'assistant-delta':
          buf += ev.text
          break
        case 'tool-call-proposed': {
          flush()
          const row: ToolAct = { kind: 'tool', name: ev.name, arg: argTarget(ev.args) }
          out.push(row)
          toolByCall.set(ev.callId, row)
          break
        }
        case 'tool-result': {
          flush()
          const row = toolByCall.get(ev.callId)
          if (row) {
            row.ok = ev.ok
            row.result = ev.result
          } else {
            out.push({ kind: 'tool', name: 'result', arg: '', ok: ev.ok, result: ev.result })
          }
          break
        }
        case 'notice':
          flush()
          out.push({ kind: 'note', text: ev.text, tone: 'dim' })
          break
        case 'turn-done':
          flush()
          if (ev.error) out.push({ kind: 'note', text: ev.error, tone: 'err' })
          break
        default:
          break
      }
    } else {
      flush()
      switch (e.kind) {
        case 'ticket-started':
          out.push({ kind: 'note', text: 'started', tone: 'dim' })
          break
        case 'check-result':
          out.push({
            kind: 'note',
            text: (e.passed ? 'check passed' : 'check failed') + (e.output ? ` — ${e.output.slice(0, 160)}` : ''),
            tone: e.passed ? 'ok' : 'err'
          })
          break
        case 'review-result':
          out.push({
            kind: 'note',
            text:
              `review ${e.round}: ${e.approved ? 'approved' : 'changes requested'}` +
              (!e.approved && e.feedback ? ` — ${e.feedback.split('\n')[0].slice(0, 120)}` : ''),
            tone: e.approved ? 'ok' : 'awaiting'
          })
          break
        case 'ticket-done':
          out.push({ kind: 'note', text: e.terminal, tone: e.terminal === 'done' ? 'ok' : e.terminal === 'review' ? 'awaiting' : 'err' })
          break
        case 'ticket-failed':
          out.push({ kind: 'note', text: `failed: ${e.error}`, tone: 'err' })
          break
        default:
          break
      }
    }
  }
  flush()
  return out
}

function ActivityRow({ a }: { a: Act }) {
  if (a.kind === 'say') {
    return (
      <div className="act-row act-row-say">
        <span className="act-marker" aria-hidden="true" />
        <div className="act-say">{a.text}</div>
      </div>
    )
  }
  if (a.kind === 'note') {
    return (
      <div className={`act-row act-row-note act-${a.tone}`}>
        <span className="act-marker" aria-hidden="true" />
        <div className="act-note">{a.text}</div>
      </div>
    )
  }
  const peek = a.result ? a.result.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
  const status = a.ok === false ? 'err' : a.ok === true ? 'ok' : 'pending'
  return (
    <div className={`act-row act-row-tool act-${status}`}>
      <span className="act-marker" aria-hidden="true" />
      <span className={`act-tool-status ${status}`} aria-hidden="true">
        {a.ok === false ? '✗' : a.ok === true ? '✓' : '▸'}
      </span>
      <div className="act-tool-main">
        <span className="act-tool-verb">{verbOf(a.name)}</span>
        {a.arg && <span className="act-tool-arg">{shortArg(a.arg)}</span>}
        {peek && <span className="act-tool-peek">{peek}</span>}
      </div>
    </div>
  )
}
