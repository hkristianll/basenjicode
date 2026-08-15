import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  AgentMode,
  AllowList,
  ChatMessage,
  ToolCall,
  TodoItem,
  ImageConfig,
  ConnectionKind
} from '../../shared/domain-types'
import type { ApprovalDecision, BgTask, StopReason, ToolPreview } from '../../shared/ipc-types'
import { Workspace } from './workspace'
import { type LLMConnection, type ChatTool, isStreamingUnsupportedError } from './lmstudio'
import { ToolRegistry, ReadTracker, SnapshotRecorder, type ToolContext, type TodoController } from './registry'
import { SafetyController, type ApprovalFn } from './safety'
import { buildSystemPrompt, buildVolatileSystemPrompt } from './prompt'
import {
  trimHistory,
  repairTranscript,
  estimateTokens,
  estimateToolsTokens,
  calibrateScale,
  lastUserIndex,
  dedupeReads,
  countSendableComposition,
  type SendableComposition
} from './history'
import { extractTextToolCalls } from './textToolFallback'
import { remember } from './memory'
import { isPrematureStop, continuationNudge, isThinkingOnly, looksLikeTruncatedToolCall, truncatedToolCallNudge } from './completion'
import { renderProjectState, type ProjectFile } from './projectState'
import { recordLearnedFact, resolveProfile } from './modelProfiles'
import { truncateMiddle, argsAreEmpty, argPath, repairJsonArgs, repairArgsToSchema, sanitizeToolArgs } from './util'
import { ThinkFilter, stripThinkTags } from './thinkFilter'
import { isToolError } from '../../shared/toolStatus'
import { log } from '../logger'
import { bgTasks } from '../bgtasks'
import { recordTurn, type StopDetail } from './turnStats'
import { buildResumeMessages, isMidStreamDropError, MAX_STREAM_RESUMES, OverlapTrimmer } from './streamResume'
import type { Emit } from './events'

const STALL_MS = 90_000 // abort a stream if LM Studio produces nothing for this long
// Weak models routinely STOP mid-task (narrate a next step without doing it, leave todos undone, or get
// cut off). When a no-tool-call reply still looks unfinished, auto-nudge "keep going" up to this many
// times before actually ending the turn — so the user doesn't have to keep typing "continue". Hermes-parity:
// a local thinking model often needs several pushes back into action, so this is generous (was 1, which
// gave up after a single nudge — the prime "fumble"). Bounded by maxCompletions + the stuck/oscillation
// guards so it can't run away.
const MAX_AUTO_CONTINUE = 6
// Board soft-guard leash. When warnDontBail is off (the board), a tripped SOFT guard (oscillation/stuck/
// empty-args below the hard circuit-breaker) used to end the turn on its FIRST trip — so the same transient
// wobble a chat session shrugs off (it warns and keeps going) killed a board worker's turn, cascading into a
// clean-restart, a parked ticket, and eventually the run's max-failures stop. Give the board a small finite
// leash: warn-and-continue up to this many soft trips per turn so the model can break out on its own before
// the expensive full-session clean-restart, while a genuinely stuck turn still hard-stops quickly. Tunable
// per session via config.softGuardWarnBudget. Chat (warnDontBail) keeps its unbounded soft budget.
const DEFAULT_SOFT_GUARD_WARN_BUDGET = 2
export const TODO_STALE_MUTATION_THRESHOLD = 4
export const TODO_STALE_NUDGE_COOLDOWN_TURNS = 8
const TODO_MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'delete_file', 'move_file'])

function touchedBasenames(toolName: string, argsJson: string): string[] {
  try {
    const args = JSON.parse(argsJson) as { path?: unknown; from?: unknown; to?: unknown }
    const paths = toolName === 'move_file' ? [args.from, args.to] : [args.path]
    return paths
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.split(/[\\/]/).at(-1) ?? '')
      .filter(Boolean)
  } catch {
    return []
  }
}

function matchTokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => token.length >= 3))
}

export function inferTodoTransition(todos: readonly TodoItem[], basenames: readonly string[]): TodoItem | undefined {
  const fileTokens = new Set(basenames.flatMap((name) => [...matchTokens(name)]))
  if (!fileTokens.size) return undefined
  const open = [
    ...todos.filter((todo) => todo.status === 'in_progress'),
    ...todos.filter((todo) => todo.status === 'pending')
  ]
  return open.find((todo) => [...matchTokens(todo.content)].some((token) => fileTokens.has(token)))
}

/** Session-lifetime todo freshness cadence. The turn clock is monotonic across user turns, so a successful
 *  todo_write can reset the mutation counter without accidentally bypassing the anti-spam cooldown. */
export class TodoFreshnessTracker {
  private mutationsSinceUpdate = 0
  private turn = 0
  private lastNudgeTurn = Number.NEGATIVE_INFINITY
  private recentBasenames = new Set<string>()

  advanceTurn(): void {
    this.turn++
  }

  reset(): void {
    this.mutationsSinceUpdate = 0
    this.recentBasenames.clear()
  }

  note(toolName: string, ok: boolean, argsJson: string, todos: readonly TodoItem[]): string | null {
    if (!ok) return null
    if (toolName === 'todo_write') {
      this.reset()
      return null
    }
    if (!TODO_MUTATING_TOOLS.has(toolName) || todos.length === 0 || todos.every((todo) => todo.status === 'completed')) {
      return null
    }

    this.mutationsSinceUpdate++
    for (const name of touchedBasenames(toolName, argsJson)) this.recentBasenames.add(name)
    if (this.mutationsSinceUpdate < TODO_STALE_MUTATION_THRESHOLD) return null
    if (this.turn - this.lastNudgeTurn < TODO_STALE_NUDGE_COOLDOWN_TURNS) return null

    this.lastNudgeTurn = this.turn
    const inferred = inferTodoTransition(todos, [...this.recentBasenames])
    if (inferred) {
      return (
        `You have finished work related to '${inferred.content}' — call todo_write NOW marking it completed ` +
        `and setting the next item in_progress. Pass the FULL list.`
      )
    }
    return (
      `You have completed ${this.mutationsSinceUpdate} implementation changes since the visible task list was updated — ` +
      `call todo_write NOW with the FULL list, marking finished items completed and setting the next item in_progress.`
    )
  }
}

/** Soft-guard warn budget for a turn: how many times a non-hard stuck/oscillation guard may warn-and-continue
 *  before it ends the turn. Chat (warnDontBail) warns freely up to the hard circuit-breaker → Infinity. The
 *  board gets a small finite leash (default 2, or an explicit override), clamped non-negative so a bad config
 *  can only restore the old stop-on-first-trip behaviour, never go negative. Pure → unit-tested. */
export function guardWarnBudget(warnDontBail: boolean | undefined, softGuardWarnBudget: number | undefined): number {
  if (warnDontBail) return Infinity
  return Math.max(0, softGuardWarnBudget ?? DEFAULT_SOFT_GUARD_WARN_BUDGET)
}

/** Tool-schema tokens actually sent to the backend. Text tool-call mode keeps the registry locally for
 *  recovery, but omits native schemas from the request and therefore reserves no context for them. */
export function requestToolsTokens(tools: ChatTool[], preferTextToolCalls: boolean | undefined): number {
  return preferTextToolCalls ? 0 : estimateToolsTokens(tools)
}

/** Reduce live task state to the compact, running-only handles carried in projectState. URL discovery is
 *  deliberately lightweight: the recent output tail is already bounded, and the first visible HTTP(S) URL
 *  is enough to orient the model toward a dev server without introducing another log parser. */
export function backgroundHandles(
  tasks: readonly Pick<BgTask, 'id' | 'command' | 'status' | 'outputTail'>[]
): { id: string; command: string; url?: string }[] {
  return tasks
    .filter((task) => task.status === 'running')
    .map((task) => {
      const url = task.outputTail.match(/https?:\/\/[^\s\"'`<>]+/i)?.[0]
      return { id: task.id, command: task.command, ...(url ? { url } : {}) }
    })
}

/** Retain the most recent URL reported by a successful preview_open result. Non-preview calls and failed
 *  or non-loaded preview attempts leave the existing handle untouched. */
export function nextPreviewUrl(current: string, toolName: string, result: string): string {
  if (toolName !== 'preview_open' || isToolError(result)) return current
  return result.match(/^Preview loaded:\s*(https?:\/\/\S+)/m)?.[1] ?? current
}

// Replacing an early duplicate read breaks the model server's KV prefix cache from that message onward. Pay
// that cost only once the context is meaningfully full and the token savings outweigh cache stability.
const DEDUPE_CONTEXT_PRESSURE = 0.6

export function composeSendableMessages(opts: {
  stableSystemPrompt: string
  history: ChatMessage[]
  volatileSystemPrompt?: string
  transientTail?: ChatMessage[]
  contextLimitTokens: number
  maxTokens: number | null
  toolsTokens: number
  tokenScale?: number
}): { sendable: ChatMessage[]; est: number; composition: SendableComposition } {
  const sendable: ChatMessage[] = [{ role: 'system', content: opts.stableSystemPrompt }, ...opts.history]
  const tail: ChatMessage[] = [
    ...(opts.transientTail ?? []),
    ...(opts.volatileSystemPrompt ? [{ role: 'system' as const, content: opts.volatileSystemPrompt }] : [])
  ]
  const tailTokens = tail.length ? estimateTokens(tail) : 0
  const scale = opts.tokenScale ?? 1.4
  const estimatedPromptTokens = estimateTokens(sendable) * scale + tailTokens + opts.toolsTokens
  const dedupe =
    estimatedPromptTokens >= opts.contextLimitTokens * DEDUPE_CONTEXT_PRESSURE
      ? dedupeReads(sendable)
      : { stubbed: 0, savedChars: 0 }
  const reserve = (opts.maxTokens ?? 4096) + opts.toolsTokens + tailTokens
  const trimmedMsgs = trimHistory(sendable, opts.contextLimitTokens, reserve, scale)
  sendable.push(...tail)
  return {
    sendable,
    est: estimateTokens(sendable) + opts.toolsTokens,
    composition: countSendableComposition(sendable, {
      dedupeSavedChars: dedupe.savedChars,
      trimmedMsgs,
      toolsTokens: opts.toolsTokens
    })
  }
}
// Thinking-only replies (reasoning present, no visible answer, no tool call) get their own budget: prefill
// the model's own reasoning back and let it continue to the real step (Hermes conversation_loop.py:4471).
const MAX_THINKING_PREFILL = 2

/** Most tool calls a single turn may execute — batching is taught in the prompt, this bounds it. */
export const MAX_TOOL_BATCH = 6

/** 1b' thinking budgets — the effort dial enforced at the stream level, in reasoning CHARS
 *  (~4 chars/token). 'high'/unset = Infinity = zero machinery: the no-silent-change guarantee.
 *  Needed because prompt-level suppression (/no_think, chat_template_kwargs) is provably ignored
 *  by qwen3.8 (live probes 2026-08-15). */
export const THINKING_BUDGETS: Record<'off' | 'low' | 'medium' | 'high', number> = {
  off: 200,
  low: 2_000,
  medium: 8_000,
  high: Infinity
}

/** Split an emitted batch into the executed head (emission order preserved) and the deferred tail. */
export function splitToolBatch<T>(calls: T[], max = MAX_TOOL_BATCH): { execute: T[]; deferred: T[] } {
  if (calls.length <= max) return { execute: calls, deferred: [] }
  return { execute: calls.slice(0, max), deferred: calls.slice(max) }
}
// A weak model trying to one-shot a huge file can emit a <tool_call> that gets cut off before its closing
// tags (the model itself stops mid-string). It can't be parsed, so it looks like "no tool call." Rather than
// ending the turn, nudge it to re-issue smaller this many times before giving up.
const MAX_TRUNCATED_TOOLCALL_RETRIES = 2
// A stalled stream (no output for STALL_MS) is usually transient — the model is still loading, or the server
// hiccuped. Retry the completion this many times before ending the turn, instead of bailing on the first
// stall (Hermes keeps streaming with health-checks + retry rather than treating a stall as terminal).
const MAX_STALL_RETRIES = 2
// W7 (Hermes nudge_interval): every N tool rounds, transiently remind the model to persist durable facts via
// remember(), so memory grows DURING a long session, not only at compaction. Chat + autoMemory only.
const MEMORY_NUDGE_INTERVAL = 10
const MEMORY_NUDGE =
  'If you have learned any durable facts about this project that would help a future session (build/test ' +
  'commands, conventions, gotchas, where things live), call remember(fact) now — one concise fact per call. ' +
  'Skip this if nothing new is worth saving.'

export interface AgentConfig {
  model: string
  temperature: number
  maxTokens: number | null
  maxTurns: number
  contextLimitTokens: number
  /** Image-generation backend (generate_image tool). */
  images?: ImageConfig
  /** Voice mode: shape replies as a concise, spoken JARVIS-style assistant. */
  voicePersona?: boolean
  /** Active backend kind/label — drives connection-aware error messaging and prompt tweaks. */
  connectionKind?: ConnectionKind
  connectionLabel?: string
  /** Tell the model to emit tool calls as `<tool_call>` text (parsed by the text-fallback path) instead of
   *  native function-calls — bypasses LM Studio's native large-argument truncation. Default off. */
  preferTextToolCalls?: boolean
  /** Reasoning/thinking control for chatty thinking models — shapes the system prompt ('off' suppresses
   *  chain-of-thought so it can't starve the tool call). Unset = the model's default. */
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high'
  /** Persona: 'manager' = Brooke, the Hermes group manager (coordinates departments, never codes). Unset =
   *  the default coding-agent persona. */
  persona?: 'manager'
  /** The board project this session manages — set for Brooke so her tools + prompt are scoped to ONE project
   *  (each project is independently instanced). Unset for ordinary coding sessions. */
  hermesProject?: string
  /** Department of a single-ticket board worker — scopes its prompt to one ticket + its real toolset. */
  workerRole?: string
  /** Tier-1 memory: auto-capture durable facts at compaction and a lesson on a capability failure. Off for
   *  the board (ephemeral worktrees) and when the user disables it. */
  autoMemory?: boolean
  /** Hermes parity (W4): when a stuck/oscillation guard trips, WARN and let the model keep trying — up to a
   *  high hard circuit-breaker — instead of ending the turn. Mirrors Hermes hard_stop_enabled=false (it
   *  warns, never blocks, by default). Off/unset for the board, whose parking economics rely on an early
   *  stop so boardDecide can restart the ticket. */
  warnDontBail?: boolean
  /** Board soft-guard leash: how many times a non-hard stuck/oscillation guard may warn-and-continue before
   *  ending the turn. Only consulted when warnDontBail is off (the board); chat warns unbounded. Unset = the
   *  DEFAULT_SOFT_GUARD_WARN_BUDGET (2). Raise it to give a wobbly local worker more rope before a clean-restart. */
  softGuardWarnBudget?: number
  /** Hermes parity (W5): fraction of the context window at which to auto-compact. Hermes compresses at 0.5;
   *  chat uses ~0.55 so a long conversation stays coherent before the model degrades. Unset = 0.8 (the
   *  board's expectation — its genius-zone clamp is tuned so 0.8 fires near 64k; see boardInner.ts). */
  compactAtFraction?: number
  /** W3a: screen dangerous shell commands in AUTO mode (outside-workspace writes, download-execute,
   *  system mutation, credentials). Default 'screen'; 'off' restores verbatim full-auto. */
  shellScreening?: 'off' | 'screen'
  /** True for sessions with no human present (board/Hermes workers): a screened shell command is DENIED
   *  with guidance instead of raising an approval prompt nobody will answer. */
  headless?: boolean
}

/**
 * One conversation against LM Studio, rooted at a workspace. Holds the transcript, drives the
 * tool-calling loop, and pauses for approval. Only one turn runs at a time per session.
 */
export class AgentSession {
  readonly id: string
  private workspace: Workspace
  private client: LLMConnection
  private registry: ToolRegistry
  private safety: SafetyController
  config: AgentConfig
  // Config/client changes that arrived while a turn was running — applied when it ends.
  private pendingConfig?: AgentConfig
  private pendingClient?: LLMConnection
  // User messages sent mid-turn (steering) — folded into the transcript at the next loop iteration.
  private pendingSteer: { text: string; images?: string[] }[] = []
  private mode: AgentMode
  private messages: ChatMessage[]
  // Tier-1 memory: a capability-failure message from this turn ("Stopped: …"), captured as a lesson after
  // the turn settles. Null unless the turn ended stuck. Reset at the start of every turn.
  private lastTurnFailure: string | null = null

  private emit?: Emit
  private currentTurnId?: string
  private currentAbort: AbortController | null = null
  private busy = false
  private reads = new ReadTracker()
  private snapshots = new SnapshotRecorder()
  // Total model completions issued in the current turn — bounds the multiplied retry/nudge/compaction
  // paths (each calls streamCompletion) so a flaky model can't burn unbounded calls/wall-clock per turn.
  private completionsThisTurn = 0
  // W1a: mid-stream drops recovered by the resumable-stream path this turn (an instance field, unlike the
  // runTurn-local counters, because the recovery fires deep inside streamCompletion). For turns.jsonl.
  private streamResumesThisTurn = 0
  // W3c: output tokens across ALL completions this turn (retries/nudges included — accumulated where the
  // completion lands, so every caller path counts). Emitted cumulatively on the usage event; the board's
  // token cap sums prompt+completion per attempt from it. Approximate lower bound: an attempt that dies
  // mid-stream never delivers its usage chunk.
  private completionTokensThisTurn = 0
  // The stop chosen by done() for the current turn — read by the runTurn finally block (which has the
  // in-scope counters) to write one turns.jsonl record. Null until done() runs; reset each turn.
  private lastStop: { stopReason: StopReason; detail: StopDetail | string } | null = null
  // Each finished turn's snapshot, keyed by turnId, captured BEFORE the next turn can replace
  // `this.snapshots` — so the persistence layer (which runs after the turn resolves) reads the right
  // turn's undo data even if a new turn has since started.
  private completedSnapshots = new Map<string, { path: string; before: string | null }[]>()
  // Sticky reactive fallback (W6): set once a server rejects streaming, so the rest of this session uses the
  // non-streaming completion path instead of re-failing every call. Mirrors Hermes's _disable_streaming.
  private streamingUnsupported = false
  // chars/4 undershoots code/JSON tokens; calibrated up from each turn's real prompt_tokens.
  private tokenScale = 1.4
  // The model's real prompt size from the last completion — the accurate trigger for compaction.
  private lastPromptTokens = 0
  // A prompt-only /no_think switch is advisory for some local models. Warn once when a session proves the
  // active model is ignoring it, rather than repeating the same notice after every reasoning-heavy turn.
  private warnedReasoningSuppressionIgnored = false
  // Turns fully carried by text tool-call recovery this session — at 10, that's a capability fact
  // worth persisting to the model's profile (see modelProfiles.ts).
  private textRecoveryTurns = 0
  // 1b' thinking budgets: one notice per session; counter for telemetry/log.
  private warnedBudgetClose = false
  private budgetForceCloses = 0
  private pendingApprovals = new Map<string, (r: { decision: ApprovalDecision; note?: string }) => void>()
  // The agent's working task list (todo_write). In-memory per session; streamed to the UI as it changes.
  private todoItems: TodoItem[] = []
  private todoFreshness = new TodoFreshnessTracker()
  // projectState: the run's durable, structured state, pinned into the prompt each turn so trim/compaction
  // can't lose it. `touchedFiles` (path → action) is updated as file tools succeed; `taskGoal` is the latest
  // substantive user task. See projectState.ts.
  private touchedFiles = new Map<string, ProjectFile['action']>()
  private taskGoal = ''
  private lastPreviewUrl = ''
  private todoController: TodoController = {
    set: (items) => {
      this.todoItems = items
      this.todoFreshness.reset()
      this.emit?.({ type: 'todos', turnId: this.currentTurnId ?? '', todos: items })
    },
    get: () => this.todoItems
  }

  constructor(opts: {
    id: string
    workspaceRoot: string
    client: LLMConnection
    registry: ToolRegistry
    config: AgentConfig
    mode: AgentMode
    history: ChatMessage[]
    allowList?: AllowList
    tokenScale?: number
  }) {
    this.id = opts.id
    this.workspace = new Workspace(opts.workspaceRoot)
    this.client = opts.client
    this.registry = opts.registry
    this.config = opts.config
    this.mode = opts.mode
    this.messages = opts.history.slice()
    if (opts.tokenScale && opts.tokenScale > 0) this.tokenScale = opts.tokenScale
    const approvalFn: ApprovalFn = (req) =>
      new Promise<{ decision: ApprovalDecision; note?: string }>((resolve) => {
        this.pendingApprovals.set(req.callId, resolve)
        this.emit?.({ type: 'awaiting-approval', turnId: this.currentTurnId ?? '', callId: req.callId })
      })
    this.safety = new SafetyController(approvalFn, opts.mode, opts.allowList, {
      screenShell: (opts.config.shellScreening ?? 'screen') !== 'off',
      headless: opts.config.headless ?? false,
      workspaceRoot: opts.workspaceRoot
    })
  }

  getHistory(): ChatMessage[] {
    return this.messages
  }

  /** Is a turn currently running? (Used to route a new message to steering instead of a fresh turn.) */
  isBusy(): boolean {
    return this.busy
  }

  getCurrentTurnId(): string | undefined {
    return this.currentTurnId
  }

  /**
   * Steer the running turn: queue a user message that the loop folds into the live transcript at the
   * next iteration — and, if the turn was about to finish, keeps it going instead of ending. This is
   * how the user interjects ("actually, do X") without cancelling and losing the in-progress work.
   */
  enqueueSteer(text: string, images?: string[]): void {
    if (!text.trim() && !(images && images.length)) return
    this.pendingSteer.push({ text, images })
  }

  /** Fold any queued steer messages into the transcript. Returns true if something was injected. */
  private drainSteer(): boolean {
    if (!this.pendingSteer.length) return false
    const queued = this.pendingSteer
    this.pendingSteer = []
    for (const m of queued) {
      this.messages.push({
        role: 'user',
        content: m.text,
        ...(m.images && m.images.length ? { images: m.images } : {})
      })
    }
    return true
  }

  /** Items on the agent's own task list (todo_write) that aren't completed yet. */
  private pendingTodoCount(): number {
    return this.todoItems.filter((t) => t.status !== 'completed').length
  }

  private looksUnfinished(text: string, finishReason: string): boolean {
    return isPrematureStop(text, finishReason, this.pendingTodoCount())
  }

  private noteTodoRelevantTool(toolName: string, ok: boolean, argsJson: string): string | null {
    return this.todoFreshness.note(toolName, ok, argsJson, this.todoItems)
  }

  setMode(mode: AgentMode): void {
    this.mode = mode
    this.safety.setMode(mode)
  }

  getAllowList(): AllowList {
    return this.safety.getAllowList()
  }

  clearApprovals(): void {
    this.safety.clear()
  }

  setConfig(config: AgentConfig): void {
    // Never redirect an in-flight turn to a different model/limits — a settings change mid-stream would
    // otherwise send model-A's accumulated transcript to model B. Stash it and apply when the turn ends.
    if (this.busy) {
      this.pendingConfig = config
      return
    }
    this.config = config
  }

  /** Swap the backend client (e.g. after the active connection or its Base URL changes). */
  setClient(client: LLMConnection): void {
    if (this.busy) {
      this.pendingClient = client
      return
    }
    this.client = client
  }

  /** Apply any config/client change that arrived mid-turn, now that the turn has ended. */
  private applyPendingConfig(): void {
    if (this.pendingConfig) {
      this.config = this.pendingConfig
      this.pendingConfig = undefined
    }
    if (this.pendingClient) {
      this.client = this.pendingClient
      this.pendingClient = undefined
    }
  }

  resolveApproval(callId: string, decision: ApprovalDecision, note?: string): void {
    const resolve = this.pendingApprovals.get(callId)
    if (resolve) {
      this.pendingApprovals.delete(callId)
      resolve({ decision, note })
    }
  }

  cancel(): void {
    this.currentAbort?.abort()
    for (const resolve of this.pendingApprovals.values()) resolve({ decision: 'reject' })
    this.pendingApprovals.clear()
    this.pendingSteer = [] // drop un-applied steers so a cancelled turn's interjection doesn't leak forward
  }

  /** Run one user turn end-to-end, emitting streaming events. Resolves when the turn is done. */
  async runTurn(userText: string, turnId: string, emit: Emit, images?: string[], displayUserText?: string): Promise<void> {
    if (this.busy) {
      emit({
        type: 'turn-done',
        turnId,
        stopReason: 'error',
        error: 'This session is already processing a turn. Wait for it to finish or press Stop.'
      })
      return
    }
    this.busy = true
    this.lastTurnFailure = null
    this.lastStop = null
    this.snapshots = new SnapshotRecorder()
    this.completionsThisTurn = 0
    this.streamResumesThisTurn = 0
    this.completionTokensThisTurn = 0
    this.pendingSteer = [] // start clean — steers only apply within the turn that's now beginning
    this.emit = emit
    this.currentTurnId = turnId
    const abort = new AbortController()
    this.currentAbort = abort
    emit({ type: 'turn-started', turnId })

    // Per-turn counters the finally block reads for the turns.jsonl record. Declared in function scope
    // because a finally block can't see try-block locals; mutated as the turn runs below.
    let compactions = 0
    let nudgedRewrite = false // one-shot: steer to write_file after edits keep failing
    let nudgedEmptyArgs = false // one-shot: nudge once on an empty-arg non-edit tool call
    let autoContinues = 0 // times the unfinished-nudge fired (bounded by MAX_AUTO_CONTINUE)
    // Hermes-parity typed-recovery counters — each counts how many times that recovery FIRED this turn.
    let thinkingPrefills = 0 // thinking-only reply → prefilled reasoning + continued
    let emptyAfterToolNudges = 0 // empty reply right after a tool result → "process the results" nudge
    let trulyEmptyRetries = 0 // fully-empty reply → retried the completion
    let truncatedToolRetries = 0 // a cut-off (unclosed) text tool call → nudged to re-issue smaller
    let compactedThisRun = false // a compaction happened this turn-run — guards a false "done" right after it
    let postCompactNudges = 0 // forced "re-orient and continue" nudges after a compaction (one-shot)
    let warnContinues = 0 // a repeat/oscillation guard warned but the loop continued (set in W4)
    // Soft-guard leash: chat (warnDontBail) warns unbounded; the board gets a small finite budget so a
    // transient wobble doesn't kill the turn on its first trip. Resolved once per turn (config is stable).
    const softGuardBudget = guardWarnBudget(this.config.warnDontBail, this.config.softGuardWarnBudget)
    let stallRetries = 0 // a stalled stream was retried instead of ending the turn (set in W6)
    let lastFinishReason = '' // last model finish_reason this turn
    let lastTurn = 0 // tool rounds reached
    let totalToolCalls = 0 // total tool calls executed this turn

    try {
      if (!this.config.model) {
        return this.done(turnId, 'error', undefined, 'No model selected. Pick a model in the top bar.', 'no_model')
      }

      // Capture the active task for projectState — a substantive user message becomes "the goal" (survives
      // compaction). Short continuations ("continue", "yes") don't overwrite it.
      const ut = userText.trim()
      if (ut.length > 16 && !/^(continue|go on|go ahead|keep going|proceed|yes|y|ok|next)\.?$/i.test(ut)) {
        this.taskGoal = ut
      }

      this.messages.push({
        role: 'user',
        content: userText,
        // Stamp the turn id on the turn-START user message (steer/nudge user injections stay unstamped) —
        // this is what lets conversation rewind pair transcript positions with per-turn undo snapshots.
        turnId,
        ...(displayUserText !== undefined && displayUserText !== userText ? { displayContent: displayUserText } : {}),
        ...(images && images.length ? { images } : {})
      })
      const tools = this.registry.toOpenAITools()
      const requestTools = this.config.preferTextToolCalls ? undefined : tools
      // Native tool schemas aren't in the message text — count them only when they ride on the request so
      // the trim budget and scale calibration reflect the real prompt size.
      const toolsTokens = requestToolsTokens(tools, this.config.preferTextToolCalls)
      const memoryQuery = this.messages
        .filter((message) => message.role === 'user')
        .slice(-2)
        .map((message) => message.content ?? '')
        .join(' ')
      const stableSystemPrompt = buildSystemPrompt({
        workspaceRoot: this.workspace.root,
        planMode: this.mode === 'plan',
        persona: this.config.persona,
        hermesProject: this.config.hermesProject,
        workerRole: this.config.workerRole,
        voicePersona: this.config.voicePersona,
        preferTextToolCalls: this.config.preferTextToolCalls,
        reasoningEffort: this.config.reasoningEffort
      })
      // Signatures of recent consecutive failed tool calls — used to break a stuck retry loop.
      const recentFailures: string[] = []
      // Schema-validation failures are deterministic for an identical tool + args + error. Track them
      // separately from runtime failures so they get a strict 3/nudge/3 policy without tightening the
      // existing lenient handler/network-error ladder.
      let validationFailureSig: string | null = null
      let validationFailureCount = 0
      let validationFailureNudged = false
      // Recent SUCCESSFUL call signatures — catches a model looping on the same successful call forever
      // (the failure-only guard never trips on that).
      const recentOk: string[] = []
      // Prose snippets from each completion — catches semantic oscillation where the model alternates
      // between two responses (e.g. "Actually, I'll create X" / "Actually, I'll use Y") without the
      // tool-call signatures ever matching.
      const recentTexts: string[] = []
      // Global per-turn completion ceiling: maxTurns bounds tool ROUNDS, but compaction (×3), the
      // blank-completion nudge (×3) and connect retries (×3) each call streamCompletion and multiply.
      // Cap the total so a flaky model can't burn unbounded calls/wall-clock before any guard fires.
      const maxCompletions = this.config.maxTurns * 2 + 20

      for (let turn = 1; turn <= this.config.maxTurns; turn++) {
        this.todoFreshness.advanceTurn()
        if (abort.signal.aborted) return this.done(turnId, 'cancelled')
        if (this.completionsThisTurn > maxCompletions) {
          return this.done(
            turnId,
            'max_turns',
            `Stopped after ${this.completionsThisTurn} model calls in one turn (retry/nudge/compaction loops multiplied past the budget). Say "continue" to resume.`,
            'max_completions'
          )
        }

        // Fold in any message the user sent mid-turn (steering) before building the next request, so
        // an interjection during a tool round is seen on the very next model call.
        this.drainSteer()

        // Auto-compact (summarize) the conversation when it grows large, like Claude Code / Codex —
        // a small focused context keeps the model from losing the thread, looping, or going empty.
        if (compactions < 3 && this.shouldCompact()) {
          await this.compact(emit, turnId, abort.signal)
          compactions++
          compactedThisRun = true
          if (abort.signal.aborted) return this.done(turnId, 'cancelled')
        }

        // Build the payload, trimmed to the calibrated budget. Factored so we can re-trim and retry.
        const buildSendable = (transientTail: ChatMessage[] = []): { sendable: ChatMessage[]; est: number; composition: SendableComposition } => {
          const volatileSystemPrompt = buildVolatileSystemPrompt({
            workspaceRoot: this.workspace.root,
            persona: this.config.persona,
            memoryQuery,
            projectState: renderProjectState({
              goal: this.taskGoal,
              files: [...this.touchedFiles].map(([path, action]) => ({ path, action })),
              todos: this.todoItems,
              background: backgroundHandles(bgTasks.list()),
              previewUrl: this.lastPreviewUrl
            }),
            memoryNudge:
              this.config.autoMemory && turn > 1 && turn % MEMORY_NUDGE_INTERVAL === 0 ? MEMORY_NUDGE : undefined
          })
          return composeSendableMessages({
            stableSystemPrompt,
            history: this.messages,
            volatileSystemPrompt,
            transientTail,
            contextLimitTokens: this.config.contextLimitTokens,
            maxTokens: this.config.maxTokens,
            toolsTokens,
            tokenScale: this.tokenScale
          })
        }

        let built = buildSendable()
        let result: {
          text: string
          toolCalls: ToolCall[]
          finishReason: string
          usage?: { prompt_tokens: number; completion_tokens?: number }
          reasoning: string
        }
        try {
          result = await this.streamCompletion(built.sendable, requestTools, abort.signal)
          // Learn how far our estimate undershot the model's real tokenizer, so trims stay accurate.
          if (result.usage) this.applyScale(built.est, result.usage.prompt_tokens)
          // If the real prompt blew past our cap and the model returned nothing useful, the estimate
          // undershot. We've just recalibrated, so re-trim harder and retry the completion once.
          const overCap = result.usage != null && result.usage.prompt_tokens > this.config.contextLimitTokens
          const unproductive = result.toolCalls.length === 0 && !result.text.trim()
          if (overCap && unproductive) {
            const retry = buildSendable()
            if (retry.est < built.est) {
              built = retry
              result = await this.streamCompletion(built.sendable, requestTools, abort.signal)
              if (result.usage) this.applyScale(built.est, result.usage.prompt_tokens)
            }
          }
          // Blank turn (no content, no reasoning, no tool call): flaky local models sometimes emit an
          // empty completion mid-task. Nudge and retry a few times before giving up — a retry usually
          // recovers, so the agent keeps going instead of stalling with "empty response" partway through.
          const isBlank = (r: typeof result): boolean =>
            r.toolCalls.length === 0 && !r.text.trim() && !r.reasoning.trim()
          for (let attempt = 0; isBlank(result) && attempt < 3; attempt++) {
            // Hermes parity: if the blank reply landed right after a tool result, steer the model to
            // process those results (conversation_loop.py:4445) rather than the generic "continue".
            const lastWasTool = this.messages[this.messages.length - 1]?.role === 'tool'
            if (lastWasTool) emptyAfterToolNudges++
            else trulyEmptyRetries++
            const nudge: ChatMessage = {
              role: 'user',
              content: lastWasTool
                ? 'You executed tool calls but returned an empty response. Process the tool results above and continue with the task.'
                : 'Continue with the task. If everything is already complete, reply with a brief summary of what you changed.'
            }
            const nudged = buildSendable([nudge])
            const nudgedEst = nudged.est
            result = await this.streamCompletion(nudged.sendable, requestTools, abort.signal)
            if (result.usage) this.applyScale(nudgedEst, result.usage.prompt_tokens)
            built = nudged
          }
        } catch (e) {
          if ((e as Error)?.message === 'LMSTUDIO_STALL') {
            const label = this.config.connectionLabel || 'The model server'
            // Hermes parity (W6): a stall is usually transient (model still loading / momentary hang). Retry
            // a bounded number of times before giving up. No assistant message was pushed, so re-running the
            // turn is a clean retry; turn-- keeps a stall from consuming a tool-round budget.
            if (stallRetries < MAX_STALL_RETRIES) {
              stallRetries++
              emit({ type: 'notice', turnId, text: `${label} went quiet — retrying (${stallRetries}/${MAX_STALL_RETRIES})…` })
              turn--
              continue
            }
            return this.done(
              turnId,
              'error',
              undefined,
              `${label} stopped responding (no output for 90s, after ${MAX_STALL_RETRIES} retries). It may be loading the model — wait a moment and try again.`,
              'stall_retry_exhausted'
            )
          }
          if (isAbort(e)) return this.done(turnId, 'cancelled')
          return this.done(turnId, 'error', undefined, classifyError(e, this.config), 'conn_error')
        }

        if (
          !this.warnedReasoningSuppressionIgnored &&
          this.config.reasoningEffort === 'off' &&
          result.reasoning.length > 2000
        ) {
          this.warnedReasoningSuppressionIgnored = true
          // Capability fact, not just a notice: the model provably ignores prompt-level suppression —
          // persist it so future sessions resolve the right mechanism without re-discovering this.
          recordLearnedFact(this.config.model, 'noThinkIgnored')
          emit({
            type: 'notice',
            turnId,
            text: 'This model ignores the /no_think reasoning suppression — thinking is still on. Adjust reasoning control in Settings if this is unwanted.'
          })
        }

        if (result.usage) {
          this.lastPromptTokens = result.usage.prompt_tokens
          emit({
            type: 'usage',
            turnId,
            promptTokens: result.usage.prompt_tokens,
            // Cumulative output tokens this turn — "last usage wins" consumers get the turn's total.
            completionTokens: this.completionTokensThisTurn,
            contextLimit: this.config.contextLimitTokens
          })
        }
        log(
          'INFO',
          `turn=${turn} prompt_tokens=${result.usage?.prompt_tokens ?? '?'} estSent=${built.est} ` +
            `cap=${this.config.contextLimitTokens} scale=${this.tokenScale.toFixed(2)} finish=${result.finishReason} ` +
            `content=${result.text.length} reasoning=${result.reasoning.length} tools=${result.toolCalls.length} ` +
            `msgs=${this.messages.length} sendableMsgs=${built.composition.sendableMsgs} ` +
            `dedupeSavedChars=${built.composition.dedupeSavedChars} trimmedMsgs=${built.composition.trimmedMsgs} ` +
            `imageCount=${built.composition.imageCount} imageBytes=${built.composition.imageBytes} ` +
            `toolsTokens=${built.composition.toolsTokens}`
        )

        let { toolCalls } = result
        let recoveredRawBlocks: Record<string, string> = {}
        const { finishReason } = result
        lastFinishReason = finishReason
        lastTurn = turn
        let displayText = stripThinkTags(result.text)
        // Native tool calls can arrive empty — e.g. a thinking model (Qwen3) that emits the
        // <tool_call> block inside its reasoning, or a parser that drops the arguments. When the
        // native calls are missing or argument-less, recover them from the content, then the reasoning.
        const usableCalls = toolCalls.filter((c) => c.name.trim() && !argsAreEmpty(c.arguments))
        const nativeUnusable = toolCalls.length === 0 || usableCalls.length === 0
        if (nativeUnusable && tools.length > 0) {
          const fromText = extractTextToolCalls(result.text, this.registry)
          const recovered = fromText.calls.length ? fromText : extractTextToolCalls(result.reasoning, this.registry)
          if (recovered.calls.length) {
            log('INFO', `recovered ${recovered.calls.length} tool call(s) from ${fromText.calls.length ? 'content' : 'reasoning'} (native args empty)`)
            if (++this.textRecoveryTurns === 10) recordLearnedFact(this.config.model, 'textToolCalls')
            toolCalls = recovered.calls
            recoveredRawBlocks = recovered.rawBlocks
            if (fromText.calls.length) displayText = fromText.cleanedText
          } else if (toolCalls.length > 0) {
            log(
              'INFO',
              `empty-arg tool call ${toolCalls[0].name}: args=${JSON.stringify(toolCalls[0].arguments).slice(0, 100)} ` +
                `contentHasToolcall=${/<tool_call>/i.test(result.text)} reasoningHasToolcall=${/<tool_call>/i.test(result.reasoning)} ` +
                `contentLen=${result.text.length} reasoningLen=${result.reasoning.length}`
            )
          }
        } else if (usableCalls.length < toolCalls.length) {
          // Mixed batch: some calls are real, some are hollow. Recover the hollow ones from the text
          // if we can; otherwise drop them so one malformed call doesn't poison the good ones (today
          // the empty one fails schema validation and trips the stuck-loop guard for the whole turn).
          const fromText = extractTextToolCalls(result.text, this.registry)
          const recovered = fromText.calls.length ? fromText : extractTextToolCalls(result.reasoning, this.registry)
          if (recovered.calls.length >= toolCalls.length) {
            toolCalls = recovered.calls
            recoveredRawBlocks = recovered.rawBlocks
            if (fromText.calls.length) displayText = fromText.cleanedText
            log('INFO', `recovered ${recovered.calls.length} tool call(s) from text for a mixed batch`)
          } else {
            log('INFO', `dropped ${toolCalls.length - usableCalls.length} empty-arg call(s) from a mixed batch; kept ${usableCalls.length}`)
            toolCalls = usableCalls
          }
        }
        // Thinking-only recovery (Hermes conversation_loop.py:4471-4488): the model produced only
        // chain-of-thought — reasoning_content, or an inline <think>/<thinking>/<reasoning> block — with
        // no visible answer and no tool call. A local thinking model does this constantly mid-task. Rather
        // than ending the turn showing raw reasoning as if it were the answer, push the model's own thinking
        // back as an assistant turn and continue, so it carries on to the real step. Bounded by
        // MAX_THINKING_PREFILL. Board workers keep their existing path (this only adds continuations).
        const thinkingOnly = isThinkingOnly(displayText, result.text, result.reasoning, toolCalls.length)
        if (thinkingOnly && thinkingPrefills < MAX_THINKING_PREFILL) {
          thinkingPrefills++
          // Carry the thinking forward: prefer the raw content (holds the inline <think> block); otherwise
          // wrap the reasoning so the next request includes it and the model continues from where it was.
          const carried = result.text.trim() ? result.text : `<think>${result.reasoning.trim()}</think>`
          this.messages.push({ role: 'assistant', content: carried })
          emit({ type: 'notice', turnId, text: 'The model was still thinking — nudging it to produce the next step…' })
          continue
        }
        // Reasoning models (e.g. Qwen3) stream their chain-of-thought in `reasoning_content` and
        // sometimes finish a step with empty `content`. Fall back to the reasoning so a turn that
        // actually produced output isn't reported as an empty response.
        if (toolCalls.length === 0 && !displayText.trim() && result.reasoning.trim()) {
          displayText = truncateMiddle(stripThinkTags(result.reasoning).trim() || result.reasoning.trim(), 8000)
        }

        // W4 stuck-guard policy (Hermes parity). On the board (warnDontBail off) a guard STOPS immediately —
        // boardDecide relies on the early stop to park + restart the ticket. In chat it WARNS and lets the
        // model keep trying, only hard-stopping at a high circuit-breaker (Hermes hard_stop_enabled=false:
        // warn freely, block rarely). Returns true if the turn should end (caller must `return`).
        const guardStop = (hard: boolean, detail: StopDetail, stopMsg: string, warnMsg: string): boolean => {
          if (!hard && warnContinues < softGuardBudget) {
            warnContinues++
            emit({ type: 'notice', turnId, text: warnMsg })
            return false
          }
          this.done(turnId, 'error', undefined, stopMsg, hard ? 'circuit_breaker' : detail)
          return true
        }

        // Detect semantic oscillation: same prose snippet appearing 3+ times in 6 iterations means the
        // model is cycling between responses without progress (tool-call guard misses alternating pairs).
        const snippet = displayText.trim().slice(0, 80)
        if (snippet) {
          recentTexts.push(snippet)
          if (recentTexts.length > 6) recentTexts.shift()
          const reps = recentTexts.filter((s) => s === snippet).length
          if (reps >= 3) {
            if (
              guardStop(
                reps >= 5,
                'oscillation',
                'Stopped: the model is repeating the same response without making progress — it appears stuck between two approaches. Try giving more specific direction or switching models.',
                'The model is repeating itself — warning, but continuing to give it a chance to break out.'
              )
            )
              return
          }
        }

        emit({
          type: 'assistant-message-done',
          turnId,
          finalText: displayText !== result.text ? displayText : undefined
        })

        if (toolCalls.length === 0) {
          // A TEXT tool call that got cut off mid-emit (opened <tool_call>/<function> with no closing tags)
          // can't be parsed, so it arrives here as "no tool call." Don't end the turn — the model just
          // truncated (typically one-shotting a huge file). Drop the broken partial (don't keep 10k+ of
          // unclosed XML in context) and nudge it to re-issue SMALLER. NEVER execute the partial — a
          // half-written write_file would corrupt the file.
          if (looksLikeTruncatedToolCall(result.text) && truncatedToolRetries < MAX_TRUNCATED_TOOLCALL_RETRIES) {
            truncatedToolRetries++
            this.messages.push({ role: 'assistant', content: '(started a tool call here but it was cut off before completing)' })
            this.messages.push({ role: 'system', content: truncatedToolCallNudge() })
            emit({ type: 'notice', turnId, text: 'A tool call was cut off mid-write — nudging the agent to re-issue it in smaller pieces…' })
            continue
          }
          this.messages.push({ role: 'assistant', content: displayText })
          // The user steered while the turn was wrapping up — continue with their new message instead
          // of ending, and give it a fresh round budget (the maxCompletions ceiling still bounds total
          // work, so this can't run away). Keeps a late interjection from being silently dropped.
          if (this.drainSteer()) {
            turn = 0
            continue
          }
          // The model stopped without calling a tool — but weak models routinely stop MID-task: they
          // narrate a next step without doing it, leave todos undone, or get cut off at the token limit.
          // If it still looks unfinished, auto-nudge it to keep going instead of ending the turn (bounded
          // by MAX_AUTO_CONTINUE + the maxCompletions ceiling, so it can't loop forever).
          if (autoContinues < MAX_AUTO_CONTINUE && this.looksUnfinished(displayText, finishReason)) {
            autoContinues++
            this.messages.push({ role: 'system', content: continuationNudge(this.pendingTodoCount(), finishReason) })
            emit({ type: 'notice', turnId, text: 'That looked unfinished — nudging the agent to keep going…' })
            continue
          }
          // Post-compaction false-done guard: a compaction collapses the live history into a summary, and a
          // weak model often then declares "done" with work still remaining — it lost the thread to the
          // summary (the observed compaction → premature stop). Force ONE re-orient nudge before accepting a
          // no-tool stop that follows a compaction; if it still stops, that's a genuine finish.
          if (compactedThisRun && postCompactNudges < 1 && displayText.trim()) {
            postCompactNudges++
            this.messages.push({
              role: 'system',
              content:
                'You compacted the conversation earlier, so the detailed history above is now a summary. Re-read ' +
                'that summary and the original task: if the work is NOT actually finished, keep going by calling ' +
                'tools. Only stop if everything is genuinely complete.'
            })
            emit({ type: 'notice', turnId, text: 'Stopped right after a compaction — nudging it to re-orient and continue if work remains…' })
            continue
          }
          // Surface *why* it stopped — otherwise truncation / empty replies look like a silent halt.
          let notice: string | undefined
          let detail: StopDetail
          if (finishReason === 'length') {
            notice = 'The response was cut off at the output-token limit. Say "continue" to resume.'
            detail = 'truncated_text'
          } else if (looksLikeTruncatedToolCall(result.text)) {
            notice = 'A tool call kept getting cut off mid-write. Ask the agent to build large files as a small skeleton plus smaller edits, not one big write.'
            detail = 'truncated_toolcall'
          } else if (!displayText.trim()) {
            notice = 'The model returned an empty response (it may not support tool calling well, or the context is full).'
            detail = 'empty_response'
          } else {
            // A genuine no-tool-call finish. If the unfinished-nudge had to fire to reach here, the model
            // quit mid-task and only stopped because the nudge budget ran out — the prime "fumble" signature.
            detail = autoContinues > 0 ? 'done_after_nudge' : 'done_clean'
          }
          return this.done(turnId, 'completed', notice, undefined, detail)
        }

        // Hermes parity (message_sanitization.py:185): normalise every tool call's arguments to wire-valid
        // JSON before we store or execute them, so a weak model's control-chars / trailing commas / stray
        // closers don't poison execution or the re-sent transcript. SKIP for a length-truncated batch —
        // those are refused just below, and closing a truncated arg would forge a plausible-but-wrong object.
        const exactArgsByCall = new Map(toolCalls.map((call) => [call.id, call.arguments]))
        if (finishReason !== 'length') {
          for (const call of toolCalls) call.arguments = sanitizeToolArgs(call.arguments)
        }

        this.messages.push({ role: 'assistant', content: displayText || null, toolCalls })

        // The response hit the output-token limit MID tool-call: the arguments are very likely
        // truncated, and repairJsonArgs would happily close them into a plausible-but-wrong object —
        // then write_file/edit_file would persist a corrupted file. Never execute a length-cut batch.
        // Reply to each call id (keeps the transcript well-formed for the next request) and stop.
        if (finishReason === 'length') {
          for (const call of toolCalls) {
            this.messages.push({
              role: 'tool',
              toolCallId: call.id,
              content:
                'ERROR: the response was cut off at the output-token limit before the tool arguments were complete. Re-issue with complete arguments, or split the work into smaller steps.'
            })
          }
          return this.done(turnId, 'completed', 'The response was cut off mid tool-call. Say "continue" to resume.', undefined, 'truncated_midtool')
        }

        // Batch cap: execute at most MAX_TOOL_BATCH calls per turn, in emission order. Excess
        // calls get a teaching reply (never silent dropping) so the model re-issues them next turn.
        {
          const batch = splitToolBatch(toolCalls)
          for (const call of batch.deferred) {
            this.messages.push({
              role: 'tool',
              toolCallId: call.id,
              content: `ERROR: batch of ${toolCalls.length} calls truncated to ${MAX_TOOL_BATCH} — this call was NOT executed. Re-issue it next turn.`
            })
          }
          toolCalls = batch.execute
        }
        totalToolCalls += toolCalls.length
        for (const call of toolCalls) {
          if (abort.signal.aborted) return this.done(turnId, 'cancelled')
          let toolImages: string[] | undefined
          let toolImagesToModel = false
          let toolPreview: ToolPreview | undefined
          const toolResult = await this.executeOne(
            call,
            abort.signal,
            (urls, opts) => {
              toolImages = urls
              if (opts?.toModel) toolImagesToModel = true
            },
            (p) => (toolPreview = p),
            recoveredRawBlocks[call.id]
          )
          // W5b reload fidelity: persist the card's preview (diff/command) and its images on the tool
          // message so a reloaded session renders the same cards. Images are capped so a batch of large
          // data URLs can't balloon the session file — beyond the cap the live view still shows them,
          // they just don't survive a reload.
          const persistedImages = capImagesForPersist(toolImages)
          this.messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: toolResult,
            ...(toolPreview ? { preview: toolPreview } : {}),
            ...(persistedImages ? { images: persistedImages } : {})
          })
          // A tool that captured a view FOR THE MODEL (preview_screenshot) feeds it back as a follow-up user message,
          // because tool-role messages can't carry images — this is what lets a vision model actually SEE and judge the
          // rendered app. UI-only attaches (generate_image, toModel=false) stay user-facing and skip this.
          if (toolImagesToModel && toolImages?.length) {
            this.messages.push({ role: 'user', content: '(Screenshot of the running app, attached for your visual review.)', images: toolImages })
          }
          // Stop pressed during/after the call: keep the transcript well-formed (reply recorded above)
          // but don't flash a red failed-tool card — just end the turn as cancelled.
          if (abort.signal.aborted) return this.done(turnId, 'cancelled')
          // Match our own status prefixes exactly ("ERROR: " etc.) so a tool whose legitimate output
          // merely begins with the word ERROR (e.g. captured program logs) isn't flagged as a failure.
          const ok = !isToolError(toolResult)
          emit({ type: 'tool-result', turnId, callId: call.id, ok, result: toolResult, images: toolImages })
          const todoReminder = this.noteTodoRelevantTool(call.name, ok, call.arguments)
          if (todoReminder) this.messages.push({ role: 'system', content: todoReminder })

          const validationFailure = toolResult.startsWith('ERROR: invalid arguments')
          if (validationFailure) {
            recentFailures.length = 0
            const sig = JSON.stringify([call.name, exactArgsByCall.get(call.id) ?? call.arguments, toolResult])
            if (sig !== validationFailureSig) {
              validationFailureSig = sig
              validationFailureCount = 0
              validationFailureNudged = false
            }
            validationFailureCount++
            if (validationFailureCount >= 3) {
              if (!this.config.warnDontBail || validationFailureNudged) {
                if (guardStop(true, 'stuck_repeat_fail', validationFailureStop(call.name), '')) return
              } else {
                validationFailureCount = 0
                validationFailureNudged = true
                const schema = this.registry.get(call.name)?.schema
                const shape = schema ? validationCallHint(call.name, schema) : toolResult
                this.messages.push({ role: 'system', content: validationFailureNudge(call.name, shape) })
                emit({
                  type: 'notice',
                  turnId,
                  text: `${call.name} repeated the same validation failure 3 times — forcing a corrected call shape.`
                })
              }
            }
            continue
          }

          // Any success, changed attempt, or runtime/handler failure breaks a consecutive validation sequence.
          validationFailureSig = null
          validationFailureCount = 0
          validationFailureNudged = false

          // Break a stuck retry loop: a weak model can keep emitting the same broken call (e.g.
          // edit_file with empty arguments) indefinitely. Stop early with guidance instead of
          // burning every turn making no progress.
          if (ok) {
            recentFailures.length = 0
            // Progress check: the same successful call with IDENTICAL args makes no progress. Break at 3 (not 4) so a
            // looping worker wastes less time before the board's R9 clean-restart recovers it — identical args 3× is a loop.
            const okSig = `${call.name}:${call.arguments}`
            recentOk.push(okSig)
            if (recentOk.length > 6) recentOk.shift()
            const dup = recentOk.filter((s) => s === okSig).length
            if (dup >= 3) {
              // Hermes idempotent_no_progress: warn at 3, hard circuit-breaker at 5.
              if (
                guardStop(
                  dup >= 5,
                  'loop_identical_ok',
                  `Stopped: the model called ${call.name} with identical arguments repeatedly with no new progress — it appears to be looping. Rephrase the request or try a different approach.`,
                  `${call.name} repeated with identical arguments — warning, continuing.`
                )
              )
                return
            }
          } else if (!toolResult.startsWith('CANCELLED')) {
            // Key the signature on the model's INTENT (tool + target path), not the exact argument
            // string — a weak model retries the same broken edit with slightly different formatting
            // each time, so an exact-text key never trips. Same tool + same file = the same attempt.
            const target = argPath(call.arguments)
            const sig = `${call.name}:${target ?? (call.arguments || '').trim().slice(0, 80)}`
            recentFailures.push(sig)
            const sameCall = recentFailures.filter((s) => s === sig).length

            // Recovery: if edit_file/multi_edit fails, steer the model to rewrite the whole file with
            // write_file — no exact snippet to match. Empty/malformed args (no path at all) are an
            // unambiguous "this model can't format the tool" signal, so act on the FIRST one; otherwise
            // wait for a second edit failure. If it ignores the steer and emits another empty edit, stop.
            const isEdit = call.name === 'edit_file' || call.name === 'multi_edit'
            const emptyEdit = isEdit && argPath(call.arguments) === null
            const editFails = recentFailures.filter((s) => /^(edit_file|multi_edit):/.test(s)).length
            if (isEdit && !nudgedRewrite && (emptyEdit || editFails >= 2)) {
              nudgedRewrite = true
              this.messages.push({ role: 'system', content: rewriteNudge(argPath(call.arguments)) })
              emit({
                type: 'notice',
                turnId,
                text: `${call.name} is failing — asking the model to rewrite the whole file with write_file instead.`
              })
            } else if (emptyEdit && nudgedRewrite) {
              // Already steered to write_file, yet another empty edit — it won't recover. In chat, warn and
              // let the model keep trying (the high stuck_repeat_fail circuit-breaker below bounds it); on
              // the board, stop now.
              if (guardStop(false, 'stuck_edit', stuckNotice(call.name), `${call.name} still failing after the write_file steer — warning, continuing.`)) return
            }

            // Empty-argument calls on a non-edit tool (e.g. write_file with no path/content): nudge once
            // with the exact required fields, then stop fast with model-capability guidance. This model
            // can fail to emit large tool-call arguments at all (LM Studio cuts the call off), so there's
            // nothing to recover — looping just wastes turns.
            const emptyArgs = argsAreEmpty(call.arguments)
            if (emptyArgs && !isEdit) {
              if (!nudgedEmptyArgs) {
                nudgedEmptyArgs = true
                this.messages.push({ role: 'system', content: emptyArgsNudge(call.name) })
                emit({
                  type: 'notice',
                  turnId,
                  text: `${call.name} was called with no arguments — asking the model to re-issue it with every field filled.`
                })
              } else {
                // In chat, warn and keep trying (bounded by the circuit-breaker below); on the board, stop.
                if (guardStop(false, 'stuck_empty_args', emptyArgsStop(call.name), `${call.name} keeps arriving with empty arguments — warning, continuing.`)) return
              }
            }

            // Repeated failures. Warn at the low threshold (same intent 3× or 8 distinct fails); hard
            // circuit-breaker at the high one (same intent 8× or 12 distinct fails — Hermes-style ceiling).
            if (sameCall >= 3 || recentFailures.length >= 8) {
              if (guardStop(sameCall >= 8 || recentFailures.length >= 12, 'stuck_repeat_fail', stuckNotice(call.name), `${call.name} keeps failing — warning, continuing to let it recover.`)) return
            }
          }
        }
      }
      return this.done(
        turnId,
        'max_turns',
        `Reached the step limit (${this.config.maxTurns} tool rounds) before finishing. Say "continue" to keep going, or raise "Max turns" in Settings.`
      )
    } finally {
      // One turns.jsonl line per finished turn — the raw signal for "fumbles and stops". done() recorded
      // the chosen stop on this.lastStop; the counters below are runTurn-locals, in scope only here. Guard
      // on lastStop so an uncaught throw (done() never ran) doesn't write a bogus record.
      if (this.lastStop) {
        recordTurn({
          turnId,
          stopReason: this.lastStop.stopReason,
          detail: this.lastStop.detail,
          finishReason: lastFinishReason,
          turns: lastTurn,
          completions: this.completionsThisTurn,
          autoContinues,
          nudgedRewrite,
          nudgedEmptyArgs,
          compactions,
          toolCalls: totalToolCalls,
          editedFiles: this.snapshots.count,
          thinkingPrefills,
          emptyAfterToolNudges,
          trulyEmptyRetries,
          truncatedToolRetries,
          postCompactNudges,
          warnContinues,
          stallRetries,
          streamResumes: this.streamResumesThisTurn,
          model: this.config.model,
          // Board per-ticket worker sessions are id'd `loop-<ticket>-<turnId>` (boardInner.ts); everything else
          // (chat, Brooke) is not a Mission worker turn. This is the discriminator the stop-reason histogram
          // filters on to isolate Mission struggle from interactive chat.
          board: this.id.startsWith('loop-')
        })
      }
      // Keep the persisted transcript well-formed no matter how the turn ended.
      this.messages = repairTranscript(this.messages)
      // Stash this turn's snapshot under its id BEFORE busy clears / a new turn can replace
      // this.snapshots, so the undo data can't be wiped before the persistence layer reads it.
      this.completedSnapshots.set(turnId, this.snapshots.list())
      this.busy = false
      // A connection/model switch that landed mid-turn was deferred — apply it now for the next turn.
      this.applyPendingConfig()
      this.cleanupTurn()
      // Tier-1 reflection: a capability failure this turn → distill one lesson into project memory.
      // Fire-and-forget + self-contained (no turn state), so it never blocks or races the next turn.
      if (this.lastTurnFailure) {
        const problem = this.lastTurnFailure
        this.lastTurnFailure = null
        void this.reflectOnFailure(problem)
      }
    }
  }

  private done(turnId: string, stopReason: StopReason, notice?: string, error?: string, detail?: StopDetail): void {
    // Record the fine sub-reason for the finally block's turns.jsonl line. Fall back to the coarse
    // bucket when a call site hasn't been annotated (true today only for cancelled/max_turns exits,
    // whose bucket already IS the right detail).
    this.lastStop = { stopReason, detail: detail ?? stopReason }
    // A capability-failure stop (every such message is prefixed "Stopped: …") is worth a Tier-1 lesson —
    // unlike a transient/config error ("Can't reach …", "rate-limited …") which isn't a recurring mistake.
    if (this.config.autoMemory && stopReason === 'error' && error?.startsWith('Stopped:')) {
      this.lastTurnFailure = error
    }
    this.emit?.({ type: 'turn-done', turnId, stopReason, notice, error, editedFiles: this.snapshots.count })
  }

  /** W5c rewind: truncate the in-memory transcript to the first `keepCount` messages. Refused while a
   *  turn is running (the loop owns this.messages mid-turn). Persisting the truncation is the caller's job. */
  rewindHistory(keepCount: number): boolean {
    if (this.busy) return false
    this.messages = this.messages.slice(0, Math.max(0, keepCount))
    return true
  }

  getSnapshot(): { path: string; before: string | null }[] {
    return this.snapshots.list()
  }

  /** The snapshot recorded for a SPECIFIC finished turn — stable even if a newer turn has since started
   *  and replaced the live recorder. Consumed once (removed after) so the map can't grow unbounded. */
  getSnapshotForTurn(turnId: string): { path: string; before: string | null }[] {
    const snap = this.completedSnapshots.get(turnId)
    this.completedSnapshots.delete(turnId)
    return snap ?? this.snapshots.list()
  }

  getTokenScale(): number {
    return this.tokenScale
  }

  /** Recalibrate the estimate→real token scale, and surface when the estimate undershoots past the
   *  4x cap (calibrateScale clamps there) so a silent context overflow becomes a visible log line. */
  private applyScale(est: number, realTokens: number): void {
    const observed = (realTokens / Math.max(1, est)) * 1.1
    this.tokenScale = calibrateScale(this.tokenScale, est, realTokens)
    if (observed > 4) {
      log(
        'INFO',
        `WARN token estimate undershooting: observed scale ${observed.toFixed(2)} exceeds the 4x cap ` +
          `(est ${est}, real ${realTokens}); context may overflow — consider lowering contextLimitTokens.`
      )
    }
  }

  /** Should we summarize the conversation to reclaim context? True once it passes ~80% of the cap. */
  private shouldCompact(): boolean {
    if (lastUserIndex(this.messages) < 4) return false
    // Compact at a fraction of the cap (Hermes parity: chat ~0.55, board 0.8). Prefer the model's real
    // reported prompt size; fall back to the calibrated estimate when there's no usage yet.
    const frac = this.config.compactAtFraction ?? 0.8
    if (this.lastPromptTokens > 0) {
      return this.lastPromptTokens > this.config.contextLimitTokens * frac
    }
    // No usage yet (e.g. a freshly loaded huge session): fall back to the calibrated estimate.
    const budget = this.config.contextLimitTokens - (this.config.maxTokens ?? 4096) - 2000
    return budget > 0 && estimateTokens(this.messages) * this.tokenScale > budget * frac
  }

  /** Replace the older transcript with an LLM-written summary, keeping the current turn intact. */
  private async compact(emit: Emit, turnId: string, signal: AbortSignal): Promise<void> {
    const lui = lastUserIndex(this.messages)
    if (lui < 4) return
    const toSummarize = this.messages.slice(0, lui)
    const keptTail = this.messages.slice(lui)
    emit({ type: 'notice', turnId, text: 'Context is filling up — compacting the conversation…' })
    let summary = ''
    try {
      summary = await this.summarize(toSummarize, signal)
    } catch {
      summary = ''
    }
    if (signal.aborted) return // cancelled — leave history; trimming still applies
    if (!summary.trim()) {
      // Close out the "compacting…" notice so it doesn't hang there implying work still in progress.
      emit({ type: 'notice', turnId, text: "Couldn't compact the conversation — continuing with trimming instead." })
      return
    }
    this.messages = [
      {
        role: 'user',
        content: `Summary of the earlier conversation (auto-compacted to save context):\n\n${summary.trim()}`
      },
      { role: 'assistant', content: 'Understood — I have the context above and will continue from here.' },
      ...keptTail
    ]
    this.lastPromptTokens = 0 // reset so we don't immediately re-trigger on the now-stale figure
    emit({ type: 'notice', turnId, text: 'Compacted the conversation to free up context.' })
    // Tier-1: salvage durable facts from the summary before the old transcript is gone (fire-and-forget).
    if (this.config.autoMemory) void this.captureDurableMemories(summary)
  }

  /**
   * Summarize a transcript for compaction. If it fits one pass, do that; otherwise summarize it in
   * budget-sized segments and fold the partials together — so the OLDEST context is actually compacted
   * instead of being silently dropped by trimHistory (which would lose it entirely when the whole
   * transcript already approaches the context cap, the exact pressure compaction exists to relieve).
   */
  private async summarize(messages: ChatMessage[], signal: AbortSignal): Promise<string> {
    const budget = this.config.contextLimitTokens - (this.config.maxTokens ?? 4096) - 4000
    const fitsOnePass = budget <= 0 || estimateTokens(messages) * this.tokenScale < budget
    if (fitsOnePass || messages.length <= 4) {
      const once = await this.summarizeOnce(messages, signal)
      // Success, can't split further, or cancelled → take what we got. An EMPTY result despite fitting means
      // the model choked on the size (weak/thinking models go empty on big inputs) — retry in smaller
      // segments below, which each summarize far more reliably.
      if (once.trim() || messages.length <= 4 || signal.aborted) return once
    }
    const segments = this.budgetSegments(messages, budget)
    const partials: string[] = []
    for (const seg of segments) {
      if (signal.aborted) break
      const s = await this.summarizeOnce(seg, signal)
      if (s.trim()) partials.push(s.trim())
    }
    if (!partials.length) return ''
    if (partials.length === 1) return partials[0]
    // Fold the per-segment summaries into one coherent summary (small input, single pass).
    const folded = partials.map((p, i) => `Segment ${i + 1}:\n${p}`).join('\n\n')
    return this.summarizeOnce(
      [{ role: 'user', content: `Summaries of consecutive earlier segments of this conversation:\n\n${folded}` }],
      signal
    )
  }

  /** Split a transcript into segments that each roughly fit the budget, broken ONLY at user-message
   *  boundaries so a tool_calls message is never separated from its replies (which would 400 a request). */
  private segmentByBudget(messages: ChatMessage[], budget: number): ChatMessage[][] {
    const segs: ChatMessage[][] = []
    let cur: ChatMessage[] = []
    for (const m of messages) {
      if (m.role === 'user' && cur.length && estimateTokens(cur) * this.tokenScale > budget * 0.8) {
        segs.push(cur)
        cur = []
      }
      cur.push(m)
    }
    if (cur.length) segs.push(cur)
    return segs
  }

  /** Segments for piecewise summarization. Uses the token budget when positive; when it's non-positive (a
   *  small context window) or the transcript is one un-splittable turn at user boundaries, halves by message
   *  index so each piece is genuinely smaller. summarizeOnce repairs each segment, so a mid-round split is safe. */
  private budgetSegments(messages: ChatMessage[], budget: number): ChatMessage[][] {
    const target = budget > 0 ? budget : Math.max(2000, Math.floor((estimateTokens(messages) * this.tokenScale) / 3))
    const segs = this.segmentByBudget(messages, target)
    if (segs.length <= 1 && messages.length > 4) {
      const mid = Math.floor(messages.length / 2)
      return [messages.slice(0, mid), messages.slice(mid)]
    }
    return segs
  }

  /** One silent completion that summarizes the given transcript (no tools, no UI streaming). */
  private async summarizeOnce(messages: ChatMessage[], signal: AbortSignal): Promise<string> {
    const payload: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You compact long coding agent conversations into a summary so the work can continue without the original messages. ' +
          'Output ONLY the summary text — no preamble, and no chain-of-thought or <think> reasoning (it would consume the ' +
          'output budget the summary itself needs). /no_think'
      },
      ...repairTranscript(messages),
      {
        role: 'user',
        content:
          "Summarize the conversation so far so the task can continue without the earlier messages. Include: the user's goal, what has been done (files read and edited, commands run, key decisions and findings), the current state, and what remains. Be specific — name files, functions, and exact changes. Output only the summary."
      }
    ]
    trimHistory(payload, this.config.contextLimitTokens, this.config.maxTokens ?? 4096, this.tokenScale)
    const savedEmit = this.emit
    this.emit = undefined // summarize silently — don't stream the summary into the chat
    try {
      const result = await this.streamCompletion(payload, [], signal)
      return result.text.trim() || result.reasoning.trim()
    } finally {
      this.emit = savedEmit
    }
  }

  /** A self-contained silent completion for background captures (Tier-1 memory): builds its own request and
   *  touches none of the turn's emit/messages state, so it is safe to fire-and-forget alongside a new turn. */
  private async silentComplete(messages: ChatMessage[]): Promise<string> {
    trimHistory(messages, this.config.contextLimitTokens, this.config.maxTokens ?? 4096, this.tokenScale)
    let text = ''
    const stream = await this.client.chatStream({
      model: this.config.model,
      messages,
      tools: [],
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      signal: new AbortController().signal
    })
    for await (const chunk of stream) {
      const d = chunk.choices?.[0]?.delta?.content
      if (d) text += d
    }
    return text.trim()
  }

  /** Tier-1: pull up to 2 durable facts out of a compaction summary and save them (tagged [auto]). */
  private async captureDurableMemories(summary: string): Promise<void> {
    try {
      const out = await this.silentComplete([
        {
          role: 'system',
          content:
            'From a coding session summary, extract durable facts worth recalling in FUTURE sessions: a decision and why, a gotcha/workaround, where something important lives, or a user preference. Output up to 2 lines, ONE concise fact each, no numbering and no reasoning. If nothing is durable, output exactly: none. /no_think'
        },
        { role: 'user', content: summary }
      ])
      if (!out || /^none\b/i.test(out)) return
      const facts = out
        .split('\n')
        .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
        .filter(Boolean)
        .slice(0, 2)
      for (const f of facts) remember(this.workspace.root, `[auto] ${f}`.slice(0, 200))
    } catch {
      /* best-effort — memory capture must never affect the turn */
    }
  }

  /** Tier-1: after a capability failure, distill one actionable lesson into memory (tagged [lesson]). */
  private async reflectOnFailure(problem: string): Promise<void> {
    try {
      const goal = [...this.messages].reverse().find((m) => m.role === 'user')?.content?.trim() || '(unknown task)'
      const out = await this.silentComplete([
        {
          role: 'system',
          content:
            'A coding task just failed. In ONE short line, state the lesson to apply next time so it does not recur — specific and actionable. No reasoning, no preamble. /no_think'
        },
        { role: 'user', content: `Task: ${goal.slice(0, 400)}\nWhat went wrong: ${problem.slice(0, 400)}` }
      ])
      const lesson = out
        .split('\n')
        .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
        .find(Boolean)
      if (lesson) remember(this.workspace.root, `[lesson] ${lesson}`.slice(0, 200))
    } catch {
      /* best-effort */
    }
  }

  /** Generate a short (≤6-word) chat title from the first exchange. Self-contained: it builds its own
   *  tiny payload and never touches the turn's emit/messages/busy state, so it's safe to run after a
   *  turn finishes (even concurrently with the next one). Returns '' on any failure. */
  async generateTitle(): Promise<string> {
    if (!this.config.model) return ''
    const firstUser = this.messages.find((m) => m.role === 'user')?.content?.trim()
    if (!firstUser) return ''
    const firstAssistant = this.messages.find((m) => m.role === 'assistant' && m.content)?.content?.trim() ?? ''
    const payload: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You write concise chat titles. Reply with ONLY the title — at most 6 words, Title Case, no quotes, no trailing punctuation, no preamble.'
      },
      {
        role: 'user',
        content: `Give a short title for this coding-assistant chat.\n\nUser: ${firstUser.slice(0, 1200)}\n\nAssistant: ${stripThinkTags(firstAssistant).slice(0, 800)}`
      }
    ]
    try {
      const stream = await this.client.chatStream({
        model: this.config.model,
        messages: payload,
        tools: [],
        temperature: 0.3,
        maxTokens: 24,
        signal: AbortSignal.timeout(20_000)
      })
      let text = ''
      for await (const chunk of stream) text += chunk.choices?.[0]?.delta?.content ?? ''
      return cleanTitle(text)
    } catch {
      return ''
    }
  }

  private cleanupTurn(): void {
    this.currentAbort = null
    this.emit = undefined
    this.currentTurnId = undefined
    this.pendingApprovals.clear()
  }

  /** Stream one completion, assembling text and tool-call deltas. */
  private async streamCompletion(
    messages: ChatMessage[],
    tools: ChatTool[] | undefined,
    signal: AbortSignal
  ): Promise<{
    text: string
    toolCalls: ToolCall[]
    finishReason: string
    usage?: { prompt_tokens: number; completion_tokens?: number }
    reasoning: string
  }> {
    const turnId = this.currentTurnId ?? ''
    this.completionsThisTurn++
    // W6: once a server has rejected streaming this session, skip straight to the non-streaming path.
    if (this.streamingUnsupported) return this.completeNonStreaming(messages, tools, signal)

    // W1a resumable streams: a transport drop AFTER deltas were emitted used to end the whole turn as
    // conn_error. Instead, re-request with the already-emitted partial prefilled back as the assistant's
    // own words and de-dup the regenerated overlap (OverlapTrimmer), bounded by MAX_STREAM_RESUMES per
    // completion. `committedText` is EXACTLY what the UI has seen — held-back trimmer/think-filter text is
    // discarded on a drop so the next attempt's trimmer de-dups against what the user actually saw.
    let committedText = ''
    let committedReasoning = ''
    let resumes = 0
    // 1b' thinking budget for this completion. Infinity (the default for 'high'/unset and for
    // non-thinking models) engages zero machinery. After one force-close the budget goes Infinite
    // so a turn is never closed twice.
    const profileThinking = resolveProfile(this.config.model).thinking
    let thinkingBudget = profileThinking === 'none' ? Infinity : THINKING_BUDGETS[this.config.reasoningEffort ?? 'high']
    let thinkPrefill = ''
    let budgetAborting = false
    const completionStartedAt = Date.now()
    let lastThinkingProgressAt = Number.NEGATIVE_INFINITY
    let lastThinkingProgressChars = 0
    const emitThinkingProgress = (chars: number, final = false): void => {
      if (chars <= 0) return
      const now = Date.now()
      if (!final) {
        if (chars <= 200) return
        if (now - lastThinkingProgressAt < 1000) return
      } else if (chars === lastThinkingProgressChars) {
        return
      }
      lastThinkingProgressAt = now
      lastThinkingProgressChars = chars
      this.emit?.({
        type: 'thinking-progress',
        turnId,
        chars,
        seconds: Math.max(0, Math.floor((now - completionStartedAt) / 1000))
      })
    }

    resume: for (;;) {
      const requestMessages = committedText
        ? buildResumeMessages(messages, committedText)
        : thinkPrefill
          ? buildResumeMessages(messages, thinkPrefill)
          : messages
      let finishReason = ''
      let usage: { prompt_tokens: number; completion_tokens?: number } | undefined
      let stalled = false

      // First-token watchdog: the connect + wait for the first chunk is the part a model swap hangs on
      // (LM Studio loads the model before responding). Without this it sits on the 600s SDK ceiling, not
      // STALL_MS. A local controller (combined with the turn signal) aborts the request after STALL_MS.
      const connectAbort = new AbortController()
      let connectTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        stalled = true
        connectAbort.abort()
      }, STALL_MS)
      let stream: Awaited<ReturnType<LLMConnection['chatStream']>>
      for (let attempt = 0; ; attempt++) {
        try {
          stream = await this.client.chatStream({
            model: this.config.model,
            messages: requestMessages,
            ...(tools === undefined ? {} : { tools }),
            temperature: this.config.temperature,
            maxTokens: this.config.maxTokens,
            preferTextToolCalls: this.config.preferTextToolCalls,
            signal: AbortSignal.any([signal, connectAbort.signal]),
            onNotice: (text) => this.emit?.({ type: 'notice', turnId, text })
          })
          break
        } catch (e) {
          if (stalled) {
            if (connectTimer) clearTimeout(connectTimer)
            throw new Error('LMSTUDIO_STALL')
          }
          if (signal.aborted) {
            if (connectTimer) clearTimeout(connectTimer)
            throw e
          }
          // No stream deltas have been emitted yet, so retrying the CONNECT can't double-emit. LM Studio
          // routinely 503s or drops the socket while (re)loading a model — a couple of quick retries turn
          // a hard turn-ending error into a transparent recovery instead of a red error in the chat.
          if (attempt < 2 && isTransientConnectError(e)) {
            log('INFO', `transient connect error (attempt ${attempt + 1}/3): ${(e as Error)?.message ?? e} — retrying`)
            await new Promise<void>((r) => setTimeout(r, 500 * (attempt + 1)))
            if (!stalled && !signal.aborted) continue
          }
          // W6 reactive fallback: the server rejected streaming itself — switch this session to the
          // non-streaming path (sticky) and serve this completion that way instead of failing. On a resume
          // attempt the request carries the prefill, so the continuation still lands after the partial.
          if (isStreamingUnsupportedError(e)) {
            if (connectTimer) clearTimeout(connectTimer)
            this.streamingUnsupported = true
            log('INFO', 'server rejected streaming — falling back to non-streaming completions for this session')
            const nf = await this.completeNonStreaming(requestMessages, tools, signal)
            return committedText
              ? { ...nf, text: committedText + nf.text, reasoning: committedReasoning + nf.reasoning }
              : nf
          }
          if (connectTimer) clearTimeout(connectTimer)
          if (stalled) throw new Error('LMSTUDIO_STALL')
          throw e
        }
      }

      let text = ''
      let reasoning = ''
      // Budget trigger: only while the model is PURELY thinking (no visible content yet) and not
      // mid-emission of a tool call inside the reasoning channel. Aborts our own stream; the
      // continuation block after the try re-issues with the think force-closed.
      const maybeCloseThinking = (): void => {
        if (!Number.isFinite(thinkingBudget) || budgetAborting) return
        if (text || committedText) return
        if (committedReasoning.length + reasoning.length <= thinkingBudget) return
        if (looksLikeTruncatedToolCall(reasoning)) return
        budgetAborting = true
        stream.controller.abort()
      }
      // Strips inline <think>…</think> chain-of-thought out of the visible content stream (cross-chunk safe).
      const thinkFilter = new ThinkFilter()
      // On a resumed attempt, de-dup the seam: models often restart their reply despite the continue steer.
      const trimmer = committedText ? new OverlapTrimmer(committedText) : null
      const acc = new Map<number, { id: string; name: string; args: string }>()

      // Per-chunk watchdog: abort if LM Studio goes silent mid-stream. Hand off from the connect timer.
      let timer: ReturnType<typeof setTimeout> | undefined
      const arm = (): void => {
        timer = setTimeout(() => {
          stalled = true
          stream.controller.abort()
        }, STALL_MS)
      }
      if (connectTimer) {
        clearTimeout(connectTimer)
        connectTimer = undefined
      }
      arm()

      try {
        for await (const chunk of stream) {
          if (timer) clearTimeout(timer)
          if (signal.aborted) {
            stream.controller.abort()
            break
          }
          if (chunk.usage?.prompt_tokens != null) usage = { prompt_tokens: chunk.usage.prompt_tokens, completion_tokens: chunk.usage.completion_tokens }
          const choice = chunk.choices?.[0]
          if (!choice) continue
          if (choice.finish_reason) finishReason = choice.finish_reason
          const delta = choice.delta
          if (delta?.content) {
            // Qwen3 et al. inline chain-of-thought as <think>…</think> in the CONTENT stream — route those
            // spans to `reasoning` (never the visible bubble); only clean visible text is emitted.
            const { visible, reasoning: r } = thinkFilter.push(delta.content)
            if (r) {
              reasoning += r
              emitThinkingProgress(committedReasoning.length + reasoning.length)
              maybeCloseThinking()
            }
            if (visible) {
              const safe = trimmer ? trimmer.push(visible) : visible
              if (safe) {
                text += safe
                this.emit?.({ type: 'assistant-delta', turnId, text: safe })
              }
            }
          }
          // Reasoning models also stream thinking in a separate field; keep it as a fallback.
          const rc = (delta as { reasoning_content?: string } | undefined)?.reasoning_content
          if (rc) {
            reasoning += rc
            emitThinkingProgress(committedReasoning.length + reasoning.length)
            maybeCloseThinking()
          }
          for (const tc of delta?.tool_calls ?? []) {
            const idx = tc.index ?? 0
            const slot = acc.get(idx) ?? { id: '', name: '', args: '' }
            if (tc.id) slot.id = tc.id
            if (tc.function?.name) slot.name = tc.function.name
            if (tc.function?.arguments) slot.args += tc.function.arguments
            acc.set(idx, slot)
            if (slot.id) {
              this.emit?.({
                type: 'tool-call-delta',
                turnId,
                callId: slot.id,
                name: slot.name || undefined,
                argsDelta: tc.function?.arguments ?? ''
              })
            }
          }
          arm()
        }
      } catch (e) {
        if (stalled) throw new Error('LMSTUDIO_STALL')
        // A budget force-close aborts our own stream — swallow that abort here; the continuation
        // block below the finally re-issues the request with the think block closed.
        if (!budgetAborting || signal.aborted) {
        // W1a: resume a transport drop — but only while NO native tool-call deltas are in flight (their
        // argument fragments can't be stitched across requests; TEXT tool calls ride the content stream and
        // resume fine, which is the dominant local path). Text held back by the trimmer/think-filter was
        // never emitted, so it is deliberately dropped: the resumed stream regenerates it and the next
        // trimmer de-dups against exactly what the user saw.
        if (!signal.aborted && acc.size === 0 && resumes < MAX_STREAM_RESUMES && isMidStreamDropError(e)) {
          resumes++
          this.streamResumesThisTurn++
          this.completionsThisTurn++
          committedText += text
          committedReasoning += reasoning
          log('INFO', `mid-stream drop after ${committedText.length} committed chars (${(e as Error)?.message ?? e}) — resuming (${resumes}/${MAX_STREAM_RESUMES})`)
          this.emit?.({ type: 'notice', turnId, text: `Connection dropped mid-response — resuming (${resumes}/${MAX_STREAM_RESUMES})…` })
          continue resume
        }
        throw e
        }
      } finally {
        if (timer) clearTimeout(timer)
      }

      // 1b' continuation: the think block hit its budget. Re-issue the SAME request with the
      // captured reasoning prefilled and force-closed so the model must continue into its answer.
      if (budgetAborting && !signal.aborted) {
        budgetAborting = false
        committedReasoning += reasoning + thinkFilter.flush().reasoning
        thinkPrefill = `<think>${committedReasoning}\n\nI have thought enough — concluding now.</think>`
        thinkingBudget = Infinity // at most one force-close per completion
        this.completionsThisTurn++
        this.budgetForceCloses++
        log('INFO', `thinking budget reached at ${committedReasoning.length} chars — force-closing the think block (close #${this.budgetForceCloses} this session)`)
        if (!this.warnedBudgetClose) {
          this.warnedBudgetClose = true
          this.emit?.({ type: 'notice', turnId, text: 'Thinking budget reached — concluded the thought and continued.' })
        }
        continue resume
      }

      // Flush any trailing partial tag held back across the final chunk boundary, then whatever the
      // overlap trimmer is still holding (a continuation shorter than its holdback settles here).
      const tail = thinkFilter.flush()
      if (tail.reasoning) {
        reasoning += tail.reasoning
        emitThinkingProgress(committedReasoning.length + reasoning.length)
      }
      if (tail.visible) {
        const safe = trimmer ? trimmer.push(tail.visible) : tail.visible
        if (safe) {
          text += safe
          this.emit?.({ type: 'assistant-delta', turnId, text: safe })
        }
      }
      const held = trimmer?.flush()
      if (held) {
        text += held
        this.emit?.({ type: 'assistant-delta', turnId, text: held })
      }

      const toolCalls: ToolCall[] = [...acc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, s]) => ({ id: s.id || `call_${randomUUID().slice(0, 8)}`, name: s.name, arguments: s.args || '{}' }))
      this.completionTokensThisTurn += usage?.completion_tokens ?? 0
      emitThinkingProgress(committedReasoning.length + reasoning.length, true)
      return {
        text: committedText + text,
        toolCalls,
        finishReason,
        usage,
        reasoning: committedReasoning + reasoning
      }
    }
  }

  /** Non-streaming completion (W6 reactive fallback): same result shape as {@link streamCompletion}, used
   *  when a server rejects streaming. A STALL_MS watchdog still bounds a model-load hang, surfacing the same
   *  LMSTUDIO_STALL the streaming path does so the turn-loop stall-retry applies uniformly. */
  private async completeNonStreaming(
    messages: ChatMessage[],
    tools: ChatTool[] | undefined,
    signal: AbortSignal
  ): Promise<{
    text: string
    toolCalls: ToolCall[]
    finishReason: string
    usage?: { prompt_tokens: number; completion_tokens?: number }
    reasoning: string
  }> {
    const turnId = this.currentTurnId ?? ''
    const connectAbort = new AbortController()
    let stalled = false
    const timer = setTimeout(() => {
      stalled = true
      connectAbort.abort()
    }, STALL_MS)
    let completion: Awaited<ReturnType<LLMConnection['chatComplete']>>
    try {
      completion = await this.client.chatComplete({
        model: this.config.model,
        messages,
        ...(tools === undefined ? {} : { tools }),
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        preferTextToolCalls: this.config.preferTextToolCalls,
        signal: AbortSignal.any([signal, connectAbort.signal]),
        onNotice: (text) => this.emit?.({ type: 'notice', turnId, text })
      })
    } catch (e) {
      if (stalled) throw new Error('LMSTUDIO_STALL')
      throw e
    } finally {
      clearTimeout(timer)
    }

    const choice = completion.choices?.[0]
    const msg = choice?.message
    let text = ''
    let reasoning = ''
    // Reuse the same <think>-stripping the streaming path uses, so the visible text is identical either way.
    const thinkFilter = new ThinkFilter()
    if (msg?.content) {
      const pushed = thinkFilter.push(msg.content)
      if (pushed.reasoning) reasoning += pushed.reasoning
      if (pushed.visible) text += pushed.visible
      const tail = thinkFilter.flush()
      if (tail.reasoning) reasoning += tail.reasoning
      if (tail.visible) text += tail.visible
      if (text) this.emit?.({ type: 'assistant-delta', turnId, text })
    }
    const rc = (msg as { reasoning_content?: string } | undefined)?.reasoning_content
    if (rc) reasoning += rc
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? [])
      .map((tc) => {
        const fn = (tc as { function?: { name?: string; arguments?: string } }).function
        return { id: tc.id || `call_${randomUUID().slice(0, 8)}`, name: fn?.name ?? '', arguments: fn?.arguments || '{}' }
      })
      .filter((c) => c.name.trim())
    const usage = completion.usage?.prompt_tokens != null ? { prompt_tokens: completion.usage.prompt_tokens, completion_tokens: completion.usage.completion_tokens } : undefined
    this.completionTokensThisTurn += usage?.completion_tokens ?? 0
    return { text, toolCalls, finishReason: choice?.finish_reason ?? 'stop', usage, reasoning }
  }

  /** Validate, propose, authorize, and run a single tool call. Always returns a string for the model. */
  /** Update projectState's file manifest after a successful file-mutating tool (so the agent always knows
   *  what exists, even after compaction). Best-effort, never throws. */
  private recordFileTouch(name: string, data: unknown, result: string): void {
    if (isToolError(result)) return
    const d = (data ?? {}) as { path?: string; to?: string; from?: string }
    if (name === 'delete_file') {
      if (d.path) this.touchedFiles.delete(d.path)
      return
    }
    if (name === 'move_file') {
      if (d.from) this.touchedFiles.delete(d.from)
      if (d.to) this.touchedFiles.set(d.to, 'moved')
      return
    }
    const action: ProjectFile['action'] | null = name === 'write_file' ? 'created' : name === 'edit_file' || name === 'multi_edit' ? 'edited' : null
    if (action && typeof d.path === 'string' && d.path.trim()) this.touchedFiles.set(d.path, action)
  }

  private async executeOne(
    call: ToolCall,
    signal: AbortSignal,
    onImages?: (urls: string[], opts?: { toModel?: boolean }) => void,
    onPreview?: (p: ToolPreview) => void,
    recoveredRawBlock?: string
  ): Promise<string> {
    const turnId = this.currentTurnId ?? ''
    const def = this.registry.get(call.name)
    if (!def) {
      this.emit?.({ type: 'tool-call-proposed', turnId, callId: call.id, name: call.name, args: call.arguments, risk: 'safe' })
      return `ERROR: unknown tool "${call.name}".`
    }
    const risk = def.mutating ? 'dangerous' : 'safe'

    let args: unknown
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {}
    } catch {
      // Weak local models often emit JSON that's syntactically broken from streaming (a dropped tail,
      // a trailing comma). Try to repair it before making the model burn a turn re-issuing the call.
      const repaired = repairJsonArgs(call.arguments)
      if (repaired) {
        log('INFO', `repaired malformed JSON args for ${def.name}`)
        args = repaired
      } else {
        this.emit?.({ type: 'tool-call-proposed', turnId, callId: call.id, name: def.name, args: call.arguments, risk })
        return `ERROR: arguments were not valid JSON. Re-issue the call with valid JSON.`
      }
    }

    let parsed = def.schema.safeParse(args)
    if (!parsed.success) {
      if (call.id.startsWith('text_') && recoveredRawBlock) {
        log('INFO', `recovered ${def.name} call failed schema validation; raw=${recoveredRawBlock.slice(0, 2000)}`)
      }
      const originalError = zodIssues(parsed.error)
      const repairedArgs = repairArgsToSchema(args, parsed.error)
      const retried = def.schema.safeParse(repairedArgs)
      if (!retried.success) {
        this.emit?.({ type: 'tool-call-proposed', turnId, callId: call.id, name: def.name, args, risk })
        return invalidArgumentsMessage(def.name, def.schema, originalError)
      }
      if (repairedArgs !== args) log('INFO', `repaired mistyped args for ${def.name}`)
      args = repairedArgs
      parsed = retried
    }

    const ctx: ToolContext = {
      workspace: this.workspace,
      signal,
      reads: this.reads,
      snapshots: this.snapshots,
      todos: this.todoController,
      hermesProject: this.config.hermesProject
    }
    let preview: ToolPreview | undefined
    if (def.preview) {
      try {
        preview = await def.preview(parsed.data, ctx)
      } catch {
        preview = undefined
      }
    }
    if (preview) onPreview?.(preview) // W5b: the caller persists it on the tool message for reload fidelity
    this.emit?.({ type: 'tool-call-proposed', turnId, callId: call.id, name: def.name, args: parsed.data, risk, preview })

    const gate = await this.safety.authorize(def, parsed.data, call.id)
    if (!gate.allowed) {
      // cancel() resolves a pending approval with 'reject', so a Stop during the approval prompt looks
      // identical to a real Reject. If the turn was aborted, report it as a cancel, not a denial.
      if (signal.aborted) return `CANCELLED: stopped by the user before this action ran.`
      return `DENIED: ${gate.reason}. Do not retry this exact action; adapt or ask the user.`
    }

    this.emit?.({ type: 'tool-call-running', turnId, callId: call.id })
    // Per-call abort: a timeout (or turn cancel) actually terminates the handler (e.g. kills the shell tree).
    const callAbort = new AbortController()
    const onTurnAbort = (): void => callAbort.abort()
    if (signal.aborted) callAbort.abort()
    else signal.addEventListener('abort', onTurnAbort, { once: true })
    const runCtx: ToolContext = {
      workspace: this.workspace,
      signal: callAbort.signal,
      reads: this.reads,
      snapshots: this.snapshots,
      todos: this.todoController,
      images: this.config.images,
      attachImages: onImages,
      hermesProject: this.config.hermesProject
    }
    const timeoutMs = def.timeoutMs ?? 30_000
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      callAbort.abort()
    }, timeoutMs)
    try {
      const out = await def.handler(parsed.data, runCtx)
      if (timedOut) return `ERROR: tool "${def.name}" timed out after ${timeoutMs}ms (process killed).`
      this.recordFileTouch(def.name, parsed.data, out) // keep projectState's file manifest current
      this.lastPreviewUrl = nextPreviewUrl(this.lastPreviewUrl, def.name, out)
      return truncateMiddle(out)
    } catch (e) {
      if (timedOut) return `ERROR: tool "${def.name}" timed out after ${timeoutMs}ms.`
      if (isAbort(e)) return `CANCELLED: tool aborted by the user.`
      return `ERROR: tool "${def.name}" failed — ${e instanceof Error ? e.message : String(e)}`
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onTurnAbort)
    }
  }
}

// ---- helpers ----

function isAbort(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? ''
  const msg = String((e as { message?: string })?.message ?? '')
  return name === 'AbortError' || name === 'APIUserAbortError' || /abort/i.test(msg)
}

/** W5b: cap the tool images persisted per message (~2 MB of data-URL text) so a batch of generated
 *  images can't balloon the session file. The live view is unaffected — oversized ones just don't
 *  survive a reload. */
const MAX_PERSISTED_IMAGE_CHARS = 2_000_000
function capImagesForPersist(images: string[] | undefined): string[] | undefined {
  if (!images?.length) return undefined
  const out: string[] = []
  let total = 0
  for (const url of images) {
    total += url.length
    if (total > MAX_PERSISTED_IMAGE_CHARS) break
    out.push(url)
  }
  return out.length ? out : undefined
}

function classifyError(e: unknown, opts?: { connectionKind?: ConnectionKind; connectionLabel?: string }): string {
  const code = (e as { code?: string })?.code
  const status = (e as { status?: number })?.status
  const msg = String((e as { message?: string })?.message ?? e)
  // Treat an unset kind as LM Studio (the historical default) so existing behaviour is preserved.
  const isLocal = opts?.connectionKind === undefined || opts.connectionKind === 'lmstudio'
  const label = opts?.connectionLabel || (isLocal ? 'LM Studio' : 'the model server')
  if (code === 'ECONNREFUSED' || /ECONNREFUSED|fetch failed|Connection error|ENOTFOUND|ECONNRESET/i.test(msg)) {
    return isLocal
      ? `Can't reach ${label}. Start it, enable its local server, and load a model, then try again.`
      : `Can't reach ${label}. Check this connection's Base URL and that the server is up.`
  }
  if (status === 401 || status === 403) {
    return `${label} rejected the request (${status}). Check the API key for this connection.`
  }
  if (status === 429) {
    return `${label} is rate-limited (429). Waiting before retry — slow down, or check this connection's plan/quota.`
  }
  if (status === 404 || /model.*not found|no model/i.test(msg)) {
    return isLocal
      ? `No model is loaded in ${label} (404). Load a model and try again.`
      : `${label}: model not found (404). Check the model id set on this connection.`
  }
  if (status === 400 && /context|token|length/i.test(msg)) {
    return "The conversation exceeded the model's context window."
  }
  if (status === 400) return `${label} rejected the request (400): ${msg}`
  if (status === 503) {
    return isLocal
      ? `The model is still loading in ${label}. Wait a moment and try again.`
      : `${label} is unavailable (503). Try again shortly.`
  }
  // The model PROCESS died (LM Studio reports "has crashed" + a raw OS exit code). Usually out of memory —
  // and not only VRAM: a large context window allocates a huge KV cache that spills into SYSTEM RAM (RAM
  // creeping up before the crash is the tell), so it can crash even with VRAM to spare. Give the cause.
  if (/has crashed|model (process )?crashed|exit code/i.test(msg)) {
    return isLocal
      ? `The model crashed in ${label} — usually out of memory. A large context window allocates a big KV cache that can exhaust VRAM OR spill into system RAM (watch for RAM creeping up just before the crash). Lower this connection's context window, enable KV-cache quantization / flash attention in LM Studio, or use a smaller model.`
      : `${label}: the model crashed. Lower the context window or try a different model.`
  }
  return `Error talking to ${label}: ${msg}`
}

/** Transient connect-phase failures worth a quick retry — model still loading (503) or a dropped
 *  socket. Deliberately excludes ECONNREFUSED ("LM Studio not running") so that stays a fast, clear
 *  error rather than being masked behind retry latency. */
function isTransientConnectError(e: unknown): boolean {
  const status = (e as { status?: number })?.status
  if (status === 503) return true
  if (status === 429) return true // rate-limited — a capped back-off retry is the right response
  const code = (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code
  if (code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'UND_ERR_SOCKET') return true
  const msg = String((e as { message?: string })?.message ?? '')
  return /ECONNRESET|socket hang up|other side closed|terminated/i.test(msg)
}

function zodIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
}

const VALIDATION_CALL_EXAMPLES: Record<string, string> = {
  todo_write:
    '<function=todo_write><parameter=todos>[{"content": "step", "status": "pending"}]</parameter></function>',
  multi_edit:
    '<function=multi_edit><parameter=path>file.ts</parameter><parameter=edits>[{"old_string": "old", "new_string": "new"}]</parameter></function>',
  kanban:
    '<function=kanban><parameter=action>add</parameter><parameter=title>next step</parameter><parameter=deps>[1]</parameter></function>'
}

function jsonSchemaType(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return 'value'
  const node = schema as { type?: unknown; anyOf?: unknown[]; enum?: unknown[] }
  if (typeof node.type === 'string') return node.type
  if (Array.isArray(node.type)) return node.type.join('|')
  if (Array.isArray(node.anyOf)) {
    const types = [...new Set(node.anyOf.map(jsonSchemaType).filter((type) => type !== 'value'))]
    if (types.length) return types.join('|')
  }
  if (node.enum?.length) return typeof node.enum[0]
  return 'value'
}

function requiredParamsHint(schema: z.ZodType): string {
  try {
    const json = z.toJSONSchema(schema, { target: 'draft-7' }) as {
      required?: unknown
      properties?: Record<string, unknown>
    }
    const required = Array.isArray(json.required)
      ? json.required.filter((name): name is string => typeof name === 'string')
      : []
    if (required.length) {
      const params = required.map((name) => `${name} (${jsonSchemaType(json.properties?.[name])})`).join(', ')
      return `Required params: ${params}.`
    }
  } catch {
    // Some effect-heavy schemas cannot be represented as JSON Schema; retain a compact actionable fallback.
  }
  return 'Required params: use every non-optional field with its schema type.'
}

function validationCallHint(toolName: string, schema: z.ZodType): string {
  const example = VALIDATION_CALL_EXAMPLES[toolName]
  return example ? `Correct shape: ${example}` : requiredParamsHint(schema)
}

function invalidArgumentsMessage(toolName: string, schema: z.ZodType, issues: string): string {
  const rawHint = validationCallHint(toolName, schema)
  const hint = rawHint.length > 400 ? `${rawHint.slice(0, 399)}…` : rawHint
  const prefix = 'ERROR: invalid arguments — '
  const suffix = `. Fix and retry. ${hint}`
  const maxIssues = Math.max(0, 600 - prefix.length - suffix.length)
  const clippedIssues =
    maxIssues === 0 ? '' : issues.length > maxIssues ? `${issues.slice(0, Math.max(0, maxIssues - 1))}…` : issues
  return `${prefix}${clippedIssues}${suffix}`
}

function validationFailureNudge(toolName: string, shape: string): string {
  return (
    `STOP repeating the identical invalid ${toolName} call. Changing nothing will produce the same validation error. ` +
    `${shape} Re-issue the call once with that exact structure and corrected values.`
  )
}

function validationFailureStop(toolName: string): string {
  return (
    `Stopped: the model kept calling ${toolName} with identical invalid arguments. The schema-validation error ` +
    `is deterministic, so retrying the same call cannot succeed. Rephrase the request or try a different model.`
  )
}

function stuckNotice(toolName: string): string {
  return (
    `Stopped: the model kept calling ${toolName} the same way and it kept failing, with no progress. ` +
    `This usually means the model is struggling to format that tool's arguments (often emitting empty ones). ` +
    `Try a smaller or simpler change, rephrase the request, or load a stronger tool-calling model in LM Studio.`
  )
}

/** Mid-turn nudge when a tool arrives with no arguments — restate the required fields concretely. */
function emptyArgsNudge(toolName: string): string {
  // Empty native args mean the model server truncated the tool call (this model is weak at emitting large
  // native tool-call arguments). The fix is to re-issue the call as TEXT — ordinary content generation, which
  // ISN'T subject to that truncation — in the exact <tool_call> shape the text-fallback parser recovers
  // (extractTextToolCalls), so the recovered call runs before the empty-args path is even reached.
  const example =
    toolName === 'write_file'
      ? `<tool_call>{"name": "write_file", "arguments": {"path": "<file path>", "content": "<full file content>"}}</tool_call>`
      : `<tool_call>{"name": "${toolName}", "arguments": { ...every required field... }}</tool_call>`
  const tail =
    toolName === 'write_file'
      ? ' If the content is very large, write a small first piece this way, then add the rest with edit_file in small chunks.'
      : ''
  return (
    `Your last ${toolName} call came back with EMPTY arguments — the native tool-call channel truncated it. ` +
    `Re-issue the SAME call as TEXT in your reply, in EXACTLY this format (writing it as text avoids the ` +
    `truncation):\n${example}\nFill in every value.${tail}`
  )
}

/** Terminal message after a non-edit tool keeps coming back with empty arguments. */
function emptyArgsStop(toolName: string): string {
  return (
    `Stopped: the model kept calling ${toolName} with empty arguments, so nothing could be written. ` +
    `This usually means the loaded model is weak at tool calling (it can't emit large tool-call arguments — ` +
    `LM Studio cuts the call off). Best fix: turn on "Text tool-call mode" for this connection (Settings → ` +
    `Connections) so it emits calls as text instead. Or load a stronger tool-calling model (e.g. Qwen3-Coder), ` +
    `or ask for a smaller change. To create a picture, use generate_image (configure a backend in Settings → Image generation).`
  )
}

/** Mid-turn instruction injected after edits keep failing, steering the model to a full rewrite. */
function rewriteNudge(path: string | null): string {
  return (
    `Editing keeps failing${path ? ` on ${path}` : ''}. Do NOT call edit_file or multi_edit again for this file. ` +
    `Instead: read_file it if you don't already have its current content, then call write_file with the path and the ` +
    `COMPLETE updated file content — write_file replaces the whole file, so there is no exact snippet to match.`
  )
}

/** Normalize a model-emitted title: strip think tags, quotes/markdown, collapse whitespace, cap to
 *  ~6 words / 56 chars so a chatty model can't produce a sentence. */
function cleanTitle(raw: string): string {
  let t = stripThinkTags(raw).replace(/\s+/g, ' ').trim()
  t = t.replace(/^["'`#*\-\s]+/, '').replace(/["'`.,:;\s]+$/, '')
  const words = t.split(' ').filter(Boolean)
  if (words.length > 7) t = words.slice(0, 7).join(' ')
  return t.slice(0, 56)
}
