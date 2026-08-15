// The per-ticket inner loop: build a FRESH throwaway AgentSession (fresh context â€” the ~100k-chunk
// discipline), seed it from the ticket, run ONE turn in auto-approve mode, distill the result. Heavy
// imports (AgentSession + the model client) live here, isolated from the unit-tested helpers in boardSeed.ts.
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { AgentSession, type AgentConfig } from './loop'
import { createConnectionClient } from './lmstudio'
import { ensureModelLoaded } from '../lmstudio/loadModel'
import { freeOtherRoleModels } from './modelSwap'
import { runPowerShell } from '../shell/powershell'
import { runGit } from '../git'
import { LIMITS, truncateMiddle } from './util'
import type { AgentEvent, LoopConfig } from '../../shared/ipc-types'
import type { Settings, Connection, ChatMessage, AgentMode } from '../../shared/domain-types'
import type { BoardTicket, TicketOutcome, TicketRunHooks } from './boardRunner'
import { buildSeedMessage, captureTurn, fetchSpec, type TicketTurnResult } from './boardSeed'
import { pickRelevantFiles } from './relevantFiles'
import { departmentOf } from './specPlan'
import { readTeamMemory } from './teamMemory'
import type { ToolRegistry } from './registry'
import type { CheckOutcome } from './boardDecide'
import { parseVerdict, type ReviewVerdict } from './boardReview'
import { runTicketFlow, type RunnerDeps } from './boardFlow'

export type { RunnerDeps } from './boardFlow'

/**
 * Tools a per-ticket worker must NOT have. The orchestrator/runner owns ticket flow (claim → check → review →
 * done → replan); a worker holding `kanban` or the board MCP tools claims the next ticket and drains the whole
 * board itself in ONE session — bypassing the gates, the per-ticket isolation, and the replan loop (the exact
 * "the same worker starts the next task" / "reviewer can't see the work" bug). ipc.ts filters these out of the
 * worker's registry via `registry.without(BOARD_DRIVING_TOOLS)`.
 */
export const BOARD_DRIVING_TOOLS = [
  'kanban', // built-in board tool
  // ticket-board MCP server tools (Desktop\ticket-board\src\mcp.js) — same board, different surface
  'add_ticket',
  'add_dependency',
  'claim',
  'claim_next',
  'update_status',
  'list_tickets',
  'get_ticket',
  'set_spec',
  'get_spec',
  'board_summary',
  'next_ready',
  'comment'
]

/** FILE-mutating tools denied to REVIEW workers. They still READ and RUN (run_shell/run_background) — an
 *  auditor must be able to run the tests/lint to review — but they never write, edit, or delete code. */
const REVIEW_EDIT_TOOLS = ['write_file', 'edit_file', 'multi_edit', 'delete_file', 'move_file', 'generate_image', 'generate_video']

/** The toolset for a ticket's worker, by department. REVIEW: read + run + file_finding, but no file edits
 *  (audit & route). Everyone else: their normal implementing tools, minus file_finding (only review files it). */
function pickWorkerRegistry(base: ToolRegistry, ticket: BoardTicket): ToolRegistry {
  // Strip `task` (sub-agent delegation) from EVERY board worker: a focused ticket should implement its own files,
  // not spawn a child agent on another connection — that loads a SECOND model (VRAM overcommit + churn) and an
  // agentic-tuned coder reaches for it readily. Review workers also lose the edit tools.
  return departmentOf(ticket.body) === 'review' ? base.without([...REVIEW_EDIT_TOOLS, 'task']) : base.without(['file_finding', 'task'])
}

// A ticket is a focused unit of work, but it must be a REACHABLE one. Telemetry (turns.jsonl, board:true vs
// chat) showed the old 14-round cap starved real multi-file tickets: the SAME local model averages ~21.5
// tool-rounds to FINISH a ticket in chat (where it completes ~30% of the time), so a 14-round board cap killed
// 90% of board turns at max_turns before the check could pass — every ticket parked, the drain stalled with
// work left. 28 clears the observed chat average with headroom while staying focused. The run's token +
// wall-clock caps (not this) bound total cost. Overridable per-user via settings.loopMaxTurnsPerTicket.
// NOTE the coupling: loop.ts derives maxCompletions = maxTurns*2+20 (28 -> 76). Don't drop below ~12.
const LOOP_SESSION_MAX_TURNS = 28

// Context-engineering (the local model reasons near-Opus UNDER ~100k tokens, then hallucinates/loops). Keep every
// call inside the genius zone: clamp the per-call window so loop.ts's compaction trigger (0.8×) fires near 64k, and
// cap the one-shot reviewer diff so a big/multi-file ticket can't feed it a 50-150k-token diff (R1 + R2).
const GENIUS_ZONE_CTX = 80_000
const REVIEW_DIFF_CAP = 80_000
// Loop protection: hard-cap a board coder's SINGLE completion. Without this, a null maxTokens lets one completion
// stream unbounded — a reasoning model can spiral in narration for 40k+ tokens (one continuous generation) and slip
// past every loop guard (stall = not silent, repetition/identical-call = output varies, maxCompletions = still in
// completion #1). Capping forces the completion to END, so those guards (and the board's clean-restart) can engage.
// Generous enough for any single focused file write (~1200 lines); a runaway gets cut here.
const BOARD_CODER_MAX_OUTPUT = 16_384

/** Context window for a REVIEWER / lead-slot model load — clamped to the genius zone, exactly like workers. When the
 *  reviewer/lead and a worker/designer share ONE model (e.g. designer = reviewer = the 27B), this stops the model
 *  being reloaded JUST to grow its context 80k↔200k (the "reloads to the same model" churn). The review diff is
 *  capped at REVIEW_DIFF_CAP chars, so 80k tokens is ample. */
function reviewerCtx(connCtx: number | null | undefined, settingsCtx: number | null | undefined): number {
  return Math.min(connCtx ?? settingsCtx ?? GENIUS_ZONE_CTX, GENIUS_ZONE_CTX)
}

/** AgentConfig for an executor connection â€” mirrors ipc.ts configFromSettings, but for a CHOSEN connection
 *  (not the active one) and with voicePersona OFF (Loop is not a spoken-assistant context). */
export function buildAgentConfig(settings: Settings, conn: Connection, modelOverride?: string): AgentConfig {
  return {
    model: modelOverride?.trim() || conn.model,
    temperature: conn.temperature ?? settings.temperature,
    maxTokens: Math.min(conn.maxTokens ?? settings.maxTokens ?? BOARD_CODER_MAX_OUTPUT, BOARD_CODER_MAX_OUTPUT), // loop protection: never unbounded
    maxTurns: Math.min(settings.maxTurns, settings.loopMaxTurnsPerTicket ?? LOOP_SESSION_MAX_TURNS),
    contextLimitTokens: Math.min(conn.contextLimitTokens ?? settings.contextLimitTokens ?? GENIUS_ZONE_CTX, GENIUS_ZONE_CTX), // R1: never above the genius zone
    images: settings.image,
    voicePersona: false,
    connectionKind: conn.kind,
    connectionLabel: conn.label,
    // Hermes default: the board worker is a weak local model. Steer it to <tool_call> TEXT (which loop.ts's
    // recovery rebuilds from result.text) instead of native function-calls that truncate large args, and
    // suppress chain-of-thought so it can't starve the tool call. An explicit per-connection value still wins.
    preferTextToolCalls: conn.preferTextToolCalls ?? true,
    reasoningEffort: conn.reasoningEffort ?? 'off',
    // W3a: board workers run full-auto with nobody watching — a screened shell command is DENIED with
    // guidance (the model adapts) rather than raising an approval prompt no one will answer.
    shellScreening: settings.shellScreening ?? 'screen',
    headless: true
  }
}

/** Connection + model for a ticket's WORKER turn, by ROLE. A DESIGN ticket routes to the configured designer model
 *  (visual/art work owned by a separate model from the coder); every other role uses the worker/coder connection.
 *  Falls back to the worker connection/model when no designer is configured — preserving prior behaviour. Pure →
 *  unit-tested. */
export function resolveTicketWorker(ticket: BoardTicket, config: LoopConfig, settings: Settings): { conn: Connection | undefined; model: string } {
  const workerConn = settings.connections.find((c) => c.id === config.connectionId) ?? settings.connections[0]
  const designConfigured = !!settings.hermesDesignerConnectionId || !!settings.hermesDesignerModel?.trim()
  if (departmentOf(ticket.body) === 'design' && designConfigured) {
    const dConn = settings.hermesDesignerConnectionId ? settings.connections.find((c) => c.id === settings.hermesDesignerConnectionId) : undefined
    const conn = dConn ?? workerConn
    return { conn, model: settings.hermesDesignerModel?.trim() || dConn?.model || config.workerModel?.trim() || conn?.model || '' }
  }
  return { conn: workerConn, model: config.workerModel?.trim() || workerConn?.model || '' }
}

interface TurnOpts {
  revision?: { attempt: number; feedback: string }
  /** A human-approved (possibly edited) plan to seed the act turn with (plan-gate). */
  approvedPlan?: string
  /** The team lead's distilled brief for this ticket (team-leads Phase 3) — seeded so the worker gets the
   *  team's relevant craft without carrying the whole memory. */
  leadBrief?: string
  /** 'auto' = full auto-approve act turn (default); 'plan' = read-only PLAN turn (mutations denied). */
  mode?: AgentMode
}

/** Build a fresh throwaway AgentSession from the ticket, run ONE turn, distill the result. Shared by the act
 *  turn (runTicketTurn, auto mode) and the plan turn (runPlanTurn, plan mode). */
async function runSession(
  ticket: BoardTicket,
  config: LoopConfig,
  deps: RunnerDeps,
  hooks: TicketRunHooks | undefined,
  opts: TurnOpts
): Promise<TicketTurnResult> {
  // Resolve the executor connection + model by the ticket's ROLE (design → designer model, else worker/coder).
  const { conn: resolved, model: roleModel } = resolveTicketWorker(ticket, config, deps.settings)
  const conn = resolved ?? deps.settings.connections[0]
  if (!resolved && config.connectionId) {
    deps.emit?.({ kind: 'notice', text: `executor connection for #${ticket.id} not found â€” using ${conn?.label ?? 'default'}` })
  }
  const client = createConnectionClient(conn)
  const agentConfig = buildAgentConfig(deps.settings, conn, roleModel)

  // Catch-all VRAM swap: free EVERY other role model (reviewer/lead + planner) before the worker model loads, so a
  // worker turn is always the SOLE resident. This closes the whole "two models pinned" class — e.g. a lead brief
  // that returned NONE leaving the reviewer model loaded, then the worker loading on top. Best-effort + no-op when
  // swap is off or nothing else is loaded; idempotent with the boardFlow review/rescue swaps.
  await freeOtherRoleModels(deps.settings, config, agentConfig.model, (text) => deps.emit?.({ kind: 'notice', text }), deps.settings.keepReviewerResident)
  // Pin LM Studio at the configured context window BEFORE the turn. The board JIT-spawns a fresh model (and
  // a swap may have just unloaded it), which LM Studio reloads at its tiny DEFAULT context — silently
  // dropping the configured window. ensureModelLoaded is a no-op when already loaded big enough, and
  // best-effort (never throws), so this is safe for the autonomous loop.
  if (conn.kind === 'lmstudio' && typeof agentConfig.contextLimitTokens === 'number' && agentConfig.contextLimitTokens > 0) {
    await ensureModelLoaded(conn.baseURL, agentConfig.model, agentConfig.contextLimitTokens)
  }

  const spec = ticket.spec_ref ? await fetchSpec(ticket.project) : null
  // Durable intra-ticket progress from an earlier (interrupted) run/attempt — injected so a resumed big ticket
  // continues instead of restarting. Only an act turn resumes; a read-only plan turn ignores it.
  const priorProgress = opts.mode === 'plan' ? null : readProgress(config.cwd, ticket.id)
  // Point the worker at the files relevant to THIS ticket (cheap server-side scan, recomputed per turn so it
  // reflects edits) so it doesn't read the whole codebase to start. Paired with the lean directive in the seed.
  const relevantFiles = pickRelevantFiles(config.cwd, ticket)
  const seed = buildSeedMessage(ticket, spec, opts.revision, opts.approvedPlan, priorProgress, opts.leadBrief, relevantFiles)
  const turnId = randomUUID()

  // Fresh session per turn: empty history, shared registry. 'auto' = full auto-approve; 'plan' = read-only
  // (the safety layer denies all mutations) so a plan turn produces intent as text without touching the worktree.
  const session = new AgentSession({
    id: `loop-${ticket.id}-${turnId}`,
    workspaceRoot: config.cwd,
    client,
    // Review workers get a read-only + file_finding registry; others implement. hermesProject lets a review
    // worker's file_finding file into THIS ticket's project; workerRole scopes its prompt to one ticket + its
    // real tools (so a restricted worker doesn't flail calling tools it doesn't have).
    registry: pickWorkerRegistry(deps.registry, ticket),
    config: { ...agentConfig, hermesProject: ticket.project, workerRole: departmentOf(ticket.body) ?? undefined },
    mode: opts.mode ?? 'auto',
    history: []
  })
  const forward = deps.emit ? (e: AgentEvent) => deps.emit!({ kind: 'agent-event', id: ticket.id, event: e }) : undefined
  // Register the live session so a per-ticket/global Stop can cancel this turn in-flight; clear it when settled.
  hooks?.onSession(session)
  try {
    const result = await captureTurn(turnId, ticket.id, (emit) => session.runTurn(seed, turnId, emit, undefined, undefined), forward)
    // Persist a durable progress note so a later run/attempt resumes instead of restarting (act turns only —
    // a plan turn made no progress). Best-effort: a write failure never aborts the ticket.
    if (opts.mode !== 'plan' && result.summary) writeProgress(config.cwd, ticket.id, ticket.title, result)
    return result
  } finally {
    hooks?.onSession(null)
  }
}

/** Read a ticket's durable progress note (the gist of its last act turn), or null if none/unreadable. */
function readProgress(cwd: string, ticketId: number): string | null {
  try {
    const p = join(cwd, '.nordcode', 'progress', `ticket-${ticketId}.md`)
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  } catch {
    return null
  }
}

/** Persist a ticket's progress (summary + edited-file count) for resume. Best-effort; mirrors persistPlan. */
function writeProgress(cwd: string, ticketId: number, title: string, result: TicketTurnResult): void {
  try {
    const dir = join(cwd, '.nordcode', 'progress')
    mkdirSync(dir, { recursive: true })
    const body = `# Progress — #${ticketId} ${title}\n\nLast turn touched ${result.editedFiles} file(s).\n\n${result.text.trim() || result.summary}\n`
    writeFileSync(join(dir, `ticket-${ticketId}.md`), body)
  } catch {
    /* best-effort: resume is an optimization, never block the ticket on a failed write */
  }
}

/** Persist REVIEW-REJECTION feedback to a ticket's durable store (read by the seed as prior progress) so a ticket
 *  RE-QUEUED from a parallel batch carries the reviewer's changes into its sequential re-run — no feedback lost.
 *  Written to the MAIN raid cwd (the re-run's cwd), NOT the discarded worktree. Best-effort. */
export function writeRejectionFeedback(cwd: string, ticketId: number, title: string, feedback: string): void {
  try {
    const dir = join(cwd, '.nordcode', 'progress')
    mkdirSync(dir, { recursive: true })
    const body = `# Progress — #${ticketId} ${title}\n\nA PRIOR attempt was coded and then REVIEWED — the reviewer requested changes. Apply this feedback and finish:\n\n${feedback.trim() || '(no detail provided)'}\n`
    writeFileSync(join(dir, `ticket-${ticketId}.md`), body)
  } catch {
    /* best-effort */
  }
}

export function runTicketTurn(
  ticket: BoardTicket,
  config: LoopConfig,
  deps: RunnerDeps,
  revision?: { attempt: number; feedback: string },
  hooks?: TicketRunHooks,
  approvedPlan?: string,
  leadBrief?: string
): Promise<TicketTurnResult> {
  return runSession(ticket, config, deps, hooks, { revision, approvedPlan, leadBrief, mode: 'auto' })
}

/** The plan-gate PLAN turn: run the worker in read-only plan mode; the final assistant text IS the plan. */
export function runPlanTurn(ticket: BoardTicket, config: LoopConfig, deps: RunnerDeps, hooks?: TicketRunHooks): Promise<TicketTurnResult> {
  return runSession(ticket, config, deps, hooks, { mode: 'plan' })
}

/** Persist the approved plan as a durable, committed artifact alongside the worktree, so the run reads as a
 *  navigable timeline. Best-effort: a write failure is surfaced but never aborts the ticket. */
async function persistPlan(ticket: BoardTicket, config: LoopConfig, plan: string, deps: RunnerDeps): Promise<void> {
  try {
    const dir = join(config.cwd, '.nordcode', 'plans')
    mkdirSync(dir, { recursive: true })
    const header = `# Plan â€” #${ticket.id} ${ticket.title}\n\n`
    writeFileSync(join(dir, `ticket-${ticket.id}.md`), header + plan.trim() + '\n')
  } catch (e) {
    deps.emit?.({ kind: 'notice', text: `#${ticket.id} could not persist the plan: ${e instanceof Error ? e.message : String(e)}` })
  }
}

async function runCheck(command: string, cwd: string, signal?: AbortSignal): Promise<CheckOutcome> {
  // The runner's per-ticket signal cancels a long check on Stop; fall back to a never-aborted one when absent.
  const res = await runPowerShell({ command, cwd, timeoutMs: LIMITS.SHELL_TIMEOUT_MS, signal: signal ?? new AbortController().signal })
  const output = [res.stdout, res.stderr].filter(Boolean).join('\n').trim()
  return { passed: res.code === 0 && !res.timedOut, code: res.code, timedOut: res.timedOut, output: output || undefined }
}

const REVIEW_SYSTEM =
  "You are the TEAM LEAD reviewing your department's work for an autonomous coding loop. The ticket body lists " +
  'ENUMERATED acceptance criteria. Go through EACH criterion in turn and verify the DIFF actually implements it — ' +
  'in your feedback, briefly note which criteria are MET and which are NOT (by their specific wording). Set ' +
  'approved=true ONLY when EVERY criterion is satisfied by the diff; if even one is missing, partial, or stubbed, ' +
  'approved=false and your feedback must NAME the specific unmet criterion/criteria and exactly what to add. Do not ' +
  "reject for things the ticket's CHECK command already verifies at runtime, and do not invent requirements beyond " +
  'the ticket. Do not edit any files. Respond with the JSON verdict {"approved": boolean, "feedback": string}. THEN append a ' +
  '<memory>...</memory> block whenever this ticket surfaced ANY reusable craft for your team - a convention to ' +
  'follow, a decision and why, a trap to avoid, a command or check that works here. DEFAULT to capturing one or ' +
  'two concrete, non-obvious bullets each ticket (the team is unattended; this memory is how the next worker stays ' +
  "sharp). The block must hold your team's FULL updated memory, rewritten TIGHT - merge and refine the existing " +
  'memory, never just append; a handful of short bullets, summarize harder as it grows; never restate the code or ' +
  'spec. Omit the block only when there is genuinely nothing reusable to record.'

function buildReviewPrompt(ticket: BoardTicket, diff: string, teamMemory?: string): string {
  const lines = [`# Ticket #${ticket.id}: ${ticket.title}`, '', ticket.body?.trim() || '(no description)', '']
  if (teamMemory?.trim()) {
    lines.push("# Your team's current memory (curated craft — refine it; do not restate the code or spec)", teamMemory.trim(), '')
  }
  lines.push('# Diff produced by the worker', diff.trim() || '(no file changes)', '', 'Review the diff against the ticket CRITERION BY CRITERION. Reply with the JSON verdict, then an optional <memory> block per your instructions.')
  return lines.join('\n')
}

/** One-shot judging completion on the REVIEWER connection (no agent loop, no tools, no edits). A reviewer
 *  that is unreachable approves-with-a-note, so a broken reviewer can never deadlock the loop. */
export async function runReview(ticket: BoardTicket, config: LoopConfig, deps: RunnerDeps, signal?: AbortSignal): Promise<ReviewVerdict> {
  const conn = deps.settings.connections.find((c) => c.id === config.reviewerConnectionId)
  // Reviewer connection misconfigured/removed → can't judge; route to human review, never auto-approve.
  if (!conn) return { approved: false, unreachable: true, feedback: '(reviewer connection not found)' }
  const reviewerModel = config.reviewerModel?.trim() || conn.model
  // Pin the reviewer's LM Studio context too (the swap unloads the worker before this runs, so the reviewer
  // JIT-reloads at the default window otherwise). No-op when already loaded big enough; never throws.
  const reviewerMinCtx = reviewerCtx(conn.contextLimitTokens, deps.settings.contextLimitTokens)
  if (conn.kind === 'lmstudio' && typeof reviewerMinCtx === 'number' && reviewerMinCtx > 0) {
    await ensureModelLoaded(conn.baseURL, reviewerModel, reviewerMinCtx)
  }
  // Intent-to-add NEW files first so they appear in the diff: a scaffold ticket adds untracked files, which plain
  // `git diff` ignores — the reviewer would otherwise see "(no file changes)" and reject correct work. (Gitignored
  // paths like node_modules are excluded.) Best-effort; -N stages no content, and the worker's own commit supersedes.
  await runGit(config.cwd, ['add', '-A', '-N'])
  const diff = truncateMiddle((await runGit(config.cwd, ['diff'])).stdout, REVIEW_DIFF_CAP) // R2: bound the one-shot reviewer diff (head+tail) so a huge diff can't blow past the cliff
  // Team-lead memory (Phase 2): the lead reviews with its team's accumulated memory in context (and may emit an
  // updated memory in a <memory> block, applied by the flow). No banner/dept → no team memory.
  const dept = departmentOf(ticket.body)
  const teamMemory = dept ? readTeamMemory(config.cwd, dept) : ''
  const messages: ChatMessage[] = [
    { role: 'system', content: REVIEW_SYSTEM },
    { role: 'user', content: buildReviewPrompt(ticket, diff, teamMemory) }
  ]
  let text = ''
  try {
    const stream = await createConnectionClient(conn).chatStream({
      model: reviewerModel,
      messages,
      tools: [],
      temperature: conn.temperature ?? deps.settings.temperature,
      maxTokens: conn.maxTokens ?? deps.settings.maxTokens,
      signal: signal ?? new AbortController().signal
    })
    for await (const chunk of stream) {
      const d = chunk.choices?.[0]?.delta?.content
      if (d) text += d
    }
  } catch (e) {
    // A reviewer outage must NOT rubber-stamp the work as approved/done — surface it as unreachable so the
    // flow hands the ticket to human review instead.
    return { approved: false, unreachable: true, feedback: `(reviewer unavailable: ${e instanceof Error ? e.message : String(e)})` }
  }
  return parseVerdict(text)
}

const LEAD_BRIEF_SYSTEM =
  "You are the TEAM LEAD. Given a ticket and your team's memory, write the WORKER a TINY brief: ONLY the few " +
  'things from the memory that matter for THIS ticket — conventions to follow, traps to avoid, decisions to ' +
  'respect. 1–5 short bullets, no preamble, do not restate the ticket. If nothing in the memory is relevant to ' +
  'this ticket, reply with exactly "NONE".'

/**
 * Lead brief (team-leads Phase 3): the lead distills its team's memory down to the few things that matter for
 * THIS ticket, so the worker gets a thumbnail instead of carrying the whole memory or re-deriving the craft.
 * Runs on the reviewer/lead connection. Returns '' when there is no memory, no lead model, or it can't run —
 * best-effort, so a missing brief just means a slightly colder worker, never a blocked ticket.
 */
export async function runLeadBrief(ticket: BoardTicket, config: LoopConfig, deps: RunnerDeps, signal?: AbortSignal): Promise<string> {
  const dept = departmentOf(ticket.body)
  if (!dept) return ''
  const memory = readTeamMemory(config.cwd, dept)
  if (!memory.trim()) return '' // no accumulated memory → no brief → no turn (cost scales with value)
  const conn = deps.settings.connections.find((c) => c.id === config.reviewerConnectionId)
  if (!conn) return '' // the lead rides the reviewer slot; none configured → no brief
  const model = config.reviewerModel?.trim() || conn.model
  const minCtx = reviewerCtx(conn.contextLimitTokens, deps.settings.contextLimitTokens)
  if (conn.kind === 'lmstudio' && typeof minCtx === 'number' && minCtx > 0) {
    await ensureModelLoaded(conn.baseURL, model, minCtx)
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: LEAD_BRIEF_SYSTEM },
    {
      role: 'user',
      content: `# Ticket #${ticket.id}: ${ticket.title}\n${ticket.body?.trim() || '(no description)'}\n\n# Your team's memory\n${memory.trim()}\n\nWrite the worker's brief (1–5 bullets), or NONE.`
    }
  ]
  try {
    let text = ''
    const stream = await createConnectionClient(conn).chatStream({
      model,
      messages,
      tools: [],
      temperature: conn.temperature ?? deps.settings.temperature,
      maxTokens: 400,
      signal: signal ?? new AbortController().signal
    })
    for await (const chunk of stream) {
      const d = chunk.choices?.[0]?.delta?.content
      if (d) text += d
    }
    const t = text.trim()
    return /^none\b/i.test(t) ? '' : t
  } catch {
    return ''
  }
}

const LEAD_FIX_SYSTEM =
  "You are the TEAM LEAD. A ticket's check kept FAILING after the worker's attempts and is about to be parked. " +
  'Diagnose the ROOT cause from the failure detail and the DIFF, then give the worker a SHORT, concrete fix it can ' +
  'apply in ONE more attempt — name exact files/commands (e.g. "the check runs `pytest tests/test_x.py` but that ' +
  'file does not exist; create tests/test_x.py importing X and asserting Y"). 1-3 bullets, no preamble, no questions. ' +
  'If the ticket genuinely CANNOT be made to pass within its own scope — it needs work owned by another ticket, or its ' +
  'check is fundamentally wrong and you cannot guide a fix — reply with EXACTLY the single word ESCALATE. In particular, ' +
  'if the worker ESCALATED because it hit a SEPARATE big issue (a bug in another module, a missing/broken foundation) ' +
  'that deserves its OWN ticket, reply ESCALATE — the group manager will file that as a new ticket; do NOT try to cram ' +
  'that whole fix into this ticket.'

function buildLeadFixPrompt(ticket: BoardTicket, failure: { stage: 'check' | 'review' | 'escalation'; detail: string }, diff: string): string {
  return [
    `# Ticket #${ticket.id}: ${ticket.title}`,
    ticket.body?.trim() || '(no description)',
    ticket.check?.trim() ? `\n# Check command\n${ticket.check.trim()}` : '',
    `\n# Why it keeps failing (${failure.stage})\n${failure.detail.slice(0, 2000)}`,
    `\n# Diff produced so far\n${diff.trim().slice(0, 6000) || '(no file changes)'}`,
    '\nGive the worker its fix (1-3 bullets), or reply ESCALATE.'
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Department-lead rescue (escalation tier 1): a ticket is about to park; the lead diagnoses the failure + diff and
 * either hands the worker a concrete fix for one final attempt ({retry:true, brief}) or escalates to the group
 * manager ({retry:false}). Runs on the reviewer/lead connection. A missing/unreachable lead escalates — it never
 * fabricates a fix or silently passes.
 */
export async function runLeadFix(
  ticket: BoardTicket,
  config: LoopConfig,
  deps: RunnerDeps,
  failure: { stage: 'check' | 'review' | 'escalation'; detail: string },
  signal?: AbortSignal
): Promise<{ retry: boolean; brief?: string }> {
  const conn = deps.settings.connections.find((c) => c.id === config.reviewerConnectionId)
  if (!conn) return { retry: false } // no lead configured → escalate to the group manager
  const model = config.reviewerModel?.trim() || conn.model
  const minCtx = reviewerCtx(conn.contextLimitTokens, deps.settings.contextLimitTokens)
  if (conn.kind === 'lmstudio' && typeof minCtx === 'number' && minCtx > 0) {
    await ensureModelLoaded(conn.baseURL, model, minCtx)
  }
  const diff = (await runGit(config.cwd, ['diff'])).stdout
  const messages: ChatMessage[] = [
    { role: 'system', content: LEAD_FIX_SYSTEM },
    { role: 'user', content: buildLeadFixPrompt(ticket, failure, diff) }
  ]
  try {
    let text = ''
    const stream = await createConnectionClient(conn).chatStream({
      model,
      messages,
      tools: [],
      temperature: conn.temperature ?? deps.settings.temperature,
      maxTokens: 600,
      signal: signal ?? new AbortController().signal
    })
    for await (const chunk of stream) {
      const d = chunk.choices?.[0]?.delta?.content
      if (d) text += d
    }
    const t = text.trim()
    if (!t || /^escalate\b/i.test(t)) return { retry: false }
    return { retry: true, brief: t.slice(0, 800) }
  } catch {
    return { retry: false } // lead unreachable → escalate, never fabricate a fix
  }
}

/**
 * Full per-ticket flow: run the inner agent turn, evaluate the ticket's `check`, iterate (fresh session)
 * up to the cap, then return the terminal the outer loop applies. No check â†’ review (a reviewer evaluates).
 */
export async function runTicketWithCheck(
  ticket: BoardTicket,
  config: LoopConfig,
  deps: RunnerDeps,
  hooks?: TicketRunHooks,
  opts?: { codeOnly?: boolean }
): Promise<TicketOutcome> {
  // The loop itself lives in boardFlow (pure, testable); here we just inject the model-bound steps + the
  // cancellation hook so the runner can abort the in-flight turn (per-ticket / global Stop). `codeOnly` (the
  // parallel batch path) stops after code+check, leaving the review for the batch coordinator.
  return runTicketFlow(ticket, config, deps, { runTurn: runTicketTurn, runPlan: runPlanTurn, runCheck, runReview, runLeadBrief, runLeadFix, persistPlan }, hooks, opts)
}
