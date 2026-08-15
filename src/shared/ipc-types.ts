import type { AgentMode, ChatMessage, ComposerSessionState, ConnectionKind, MCPServerStatus, Session, SessionMeta, Settings, TodoItem, ToolPreview } from './domain-types'

/** Channel-name constants — the single source of truth for both ends of the bridge. */
export const IPC = {
  agentStartTurn: 'agent:startTurn',
  agentCancel: 'agent:cancel',
  agentDecide: 'agent:approvalDecision',
  agentSetMode: 'agent:setMode',
  agentClearApprovals: 'agent:clearApprovals',
  agentUndoTurn: 'agent:undoTurn',
  agentRewindPlan: 'agent:rewindPlan',
  agentRewindExecute: 'agent:rewindExecute',
  updateStatus: 'update:status',
  updateInstall: 'update:install',
  agentEvent: 'agent:event',
  sessionList: 'session:list',
  sessionLoad: 'session:load',
  sessionCreate: 'session:new',
  sessionRemove: 'session:delete',
  sessionSearch: 'session:search',
  sessionSetComposer: 'session:setComposer',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  mcpStatus: 'mcp:status',
  lmstudioProbe: 'lmstudio:probe',
  lmstudioModels: 'lmstudio:models',
  contextLimit: 'agent:contextLimit',
  clipboardWrite: 'clipboard:write',
  modelProfileDescribe: 'model:profileDescribe',
  agentSetEffort: 'agent:setEffort',
  voiceProbe: 'voice:probe',
  voiceTranscribe: 'voice:transcribe',
  voiceSpeak: 'voice:speak',
  voiceSetWake: 'voice:setWake',
  voiceWakeEvent: 'voice:wakeEvent',
  dialogPickDirectory: 'dialog:pickDirectory',
  dialogPickFiles: 'dialog:pickFiles',
  uiSetTitleBar: 'ui:setTitleBarOverlay',
  workspaceListFiles: 'workspace:listFiles',
  workspaceReadFile: 'workspace:readFile',
  workspaceSavePlan: 'workspace:savePlan',
  workspaceListPlans: 'workspace:listPlans',
  gitStatus: 'git:status',
  gitDiff: 'git:diff',
  gitCommit: 'git:commit',
  bgtaskList: 'bgtask:list',
  bgtaskStop: 'bgtask:stop',
  bgtaskOutput: 'bgtask:output',
  bgtaskEvent: 'bgtask:event',
  // Preview bridge: main asks the renderer to open/navigate the Preview <webview> (control),
  // the renderer reports the guest's webContents id back (register) so main-process tools can drive it.
  previewControl: 'preview:control',
  previewRegister: 'preview:register',
  previewClosed: 'preview:closed',
  loopStart: 'loop:start',
  loopPause: 'loop:pause',
  loopResume: 'loop:resume',
  loopStop: 'loop:stop',
  loopStatus: 'loop:status',
  loopEvent: 'loop:event',
  loopBoardList: 'loopBoard:list',
  loopBoardProjects: 'loopBoard:projects',
  loopBoardFolders: 'loopBoard:folders',
  loopBoardChange: 'loopBoard:change',
  loopDiff: 'loop:diff',
  loopBoardComment: 'loopBoard:comment',
  loopTicketAction: 'loop:ticket-action',
  loopPlanDecision: 'loop:plan-decision',
  loopOrchestrate: 'loop:orchestrate',
  hermesMessage: 'hermes:message',
  hermesHistory: 'hermes:history',
  hermesCancel: 'hermes:cancel',
  hermesEvent: 'hermes:event',
  hermesTeamMemoryGet: 'hermes:team-memory-get',
  hermesTeamMemorySet: 'hermes:team-memory-set'
} as const

export type ConnectionStatus = 'ok' | 'no-model' | 'unreachable' | 'auth' | 'checking'

export interface ProbeResult {
  status: ConnectionStatus
  models: string[]
  detail?: string
}

/** Health of the local voice sidecar (faster-whisper STT + Kokoro TTS). */
export interface VoiceProbeResult {
  ok: boolean
  detail?: string
  /** STT model id reported by the sidecar (when reachable). */
  stt?: string
  /** TTS voice id reported by the sidecar (when reachable). */
  tts?: string
}

/** Hands-free wake-word events streamed from the sidecar (main → renderer). */
export type WakeEvent =
  | { type: 'wake' }
  | { type: 'listening' }
  | { type: 'transcribing' }
  | { type: 'command'; text: string }
  | { type: 'idle' }
  | { type: 'error'; detail: string }

export type ToolRisk = 'safe' | 'dangerous'

// Moved to domain-types (tool messages persist it for reload fidelity, W5b); re-exported for back-compat.
export type { ToolPreview }

export type ApprovalDecision = 'approve' | 'reject' | 'always_tool' | 'always_exact'

export type StopReason = 'completed' | 'cancelled' | 'error' | 'max_turns'

/** A long-running background process started via the run_background tool. */
export interface BgTask {
  id: string
  command: string
  status: 'running' | 'exited' | 'killed'
  code: number | null
  startedAt: number
  /** Last slice of combined stdout/stderr. */
  outputTail: string
}

export interface PlanFile {
  name: string
  path: string
  updatedAt: number
}

/** A body-search match: a session whose message content contains the query, with a short snippet. */
export interface SessionSearchHit {
  id: string
  snippet: string
}

/** Main → renderer: open/navigate/focus the Preview panel's <webview>. */
export interface PreviewControl {
  action: 'open' | 'reload' | 'focus'
  url?: string
  /** Bumped on every control message so the renderer re-navigates even to the same URL. */
  nonce: number
}

/** Renderer → main: the live Preview <webview>'s guest id, so main-process tools can drive it. */
export interface PreviewRegister {
  webContentsId: number
  url: string
  title: string
  /** False for the early did-attach registration; true/omitted once DOM-ready can release preview_open. */
  ready?: boolean
}

export interface GitFile {
  path: string
  status: string
  staged: boolean
  /** Lines added/removed vs HEAD (undefined for untracked files). */
  added?: number
  deleted?: number
}
export interface GitStatus {
  isRepo: boolean
  branch: string
  files: GitFile[]
}

export type AgentEvent =
  | { type: 'turn-started'; turnId: string }
  | { type: 'assistant-delta'; turnId: string; text: string }
  | { type: 'thinking-progress'; turnId: string; chars: number; seconds: number }
  | { type: 'assistant-message-done'; turnId: string; finalText?: string }
  | { type: 'tool-call-delta'; turnId: string; callId: string; name?: string; argsDelta: string }
  | {
      type: 'tool-call-proposed'
      turnId: string
      callId: string
      name: string
      args: unknown
      risk: ToolRisk
      preview?: ToolPreview
    }
  | { type: 'awaiting-approval'; turnId: string; callId: string }
  | { type: 'tool-call-running'; turnId: string; callId: string }
  | { type: 'tool-result'; turnId: string; callId: string; ok: boolean; result: string; images?: string[] }
  | {
      type: 'usage'
      turnId: string
      promptTokens: number
      /** Cumulative OUTPUT tokens across the turn's completions (W3c) — for spend accounting; the context
       *  meter stays prompt-based. Absent from older servers that omit stream usage. */
      completionTokens?: number
      contextLimit: number
    }
  | { type: 'notice'; turnId: string; text: string }
  | { type: 'todos'; turnId: string; todos: TodoItem[] }
  | {
      type: 'turn-done'
      turnId: string
      stopReason: StopReason
      error?: string
      notice?: string
      editedFiles?: number
    }
  | { type: 'session-titled'; sessionId: string; title: string }

/* ----- Loop runner (autonomous board drain) — CANONICAL contract; consumers (T3/T4/T6/T7) must not redefine. ----- */

export interface LoopCaps {
  maxTickets: number
  maxTokens: number
  maxWallclockSec: number
  maxConsecutiveFailures: number
}

/** Renderer → main: the full superset `loop:start` carries (so executor selection works end-to-end). */
export interface LoopConfig {
  /** Working folder the runner operates in. */
  cwd: string
  /** Connection id (from Settings.connections) the executor sessions use. */
  connectionId: string
  /** Board project to drain. */
  project: string
  mode: 'auto'
  caps: LoopCaps
  /** Per-ticket terminal: 'auto' = check pass → done else review; 'review' = always gate. */
  terminal?: 'auto' | 'review'
  /** Inner-loop retries per ticket before parking (default 3). */
  maxAttemptsPerTicket?: number
  /** Create + checkout an isolated run branch before draining (default true). */
  branchPerRun?: boolean
  /** Reviewer model connection id; empty/undefined = no LLM review (check/human only). Worker is `connectionId`. */
  reviewerConnectionId?: string
  /** Specific model to run, overriding the connection's default — the "what model" on top of the connection's
   *  "where". Lets a worker model and a reviewer model run on the SAME backend. */
  workerModel?: string
  reviewerModel?: string
  /** Spin worker/reviewer up-and-down so only one is GPU-resident at a time (default true). */
  swapModels?: boolean
  /** Max IMPLEMENTATION tickets to drain CONCURRENTLY (each in its own git worktree). 1 = the sequential drain
   *  (default, unchanged). >1 codes that many independent impl tickets in parallel, then reviews them in a batch.
   *  Non-impl tickets (design/review/integration/scaffold) always run sequentially. */
  parallelism?: number
  /** Plan-gate: before a ticket's worker edits, run a read-only PLAN turn, surface it, and pause until the
   *  user approves/edits it. Opt-in (default false) so an unattended drain runs unchanged. */
  reviewPlans?: boolean
  /** When the drain runs dry of ready `todo` but `review` tickets remain, reopen them (review → todo) for
   *  another autonomous pass instead of finishing board-green. Each is reopened at most once per run. This is
   *  what lets Hermes re-engage stuck work — and fixes "can't start a run when only review tickets are left". */
  includeReview?: boolean
}

/** The user's verdict on a ticket's surfaced plan (renderer → main, resolves the plan-gate pause).
 *  'cancel' is raised internally when a Stop interrupts the wait — it lands the ticket in review like a reject. */
export interface PlanDecision {
  decision: 'approve' | 'reject' | 'cancel'
  /** The (possibly edited) plan text to seed the act turn with; absent → use the surfaced plan verbatim. */
  editedPlan?: string
}

export type LoopRunState = 'idle' | 'running' | 'paused' | 'stopped'

/** Fine-grained, per-ticket control the run header's coarse Start/Pause/Stop can't express:
 *  - pause: pause the whole run (sequential single-worktree drain) at the next ticket boundary.
 *  - stop:  abort THIS ticket's in-flight agent turn (the run continues to the next ticket); on a queued
 *           ticket it behaves like skip.
 *  - skip:  set a queued ticket aside (board → review) so this run won't claim it.
 *  - retry: re-queue a parked/finished ticket (board → todo) for an active drain to pick up again. */
export type TicketAction = 'pause' | 'stop' | 'skip' | 'retry'

/** Main → renderer: current runner state (returned by status + pushed via 'status'/'run-stats' events). */
export interface LoopStatus {
  state: LoopRunState
  project?: string
  currentTicket?: number
  claimed: number
  done: number
  review: number
  parked: number
  failed: number
  tokensUsed?: number
  startedAt?: number
  /** The active run's isolated git worktree (for the per-ticket diff), when a run is/was in flight. */
  worktree?: string
}

/** Main → renderer: streamed runner activity. Discriminated on `kind` (NOT `type`, to avoid colliding with
 *  AgentEvent). The 'agent-event' variant wraps the inner per-ticket stream for the activity feed. */
export type LoopStopReason = 'user' | 'board-green' | 'max-tickets' | 'max-tokens' | 'max-failures' | 'wall-clock' | 'error'

/** The orchestrator's OWN phase (P2/O2), distinct from the drain's LoopRunState — so the Hermes UI shows
 *  "replanning" / "improving" while a model call runs between drains, instead of the drain's stale "stopped". */
export type HermesUiState = 'planning' | 'draining' | 'replanning' | 'improving' | 'paused' | 'done'

export type LoopEvent =
  | { kind: 'status'; status: LoopStatus }
  | { kind: 'run-stats'; status: LoopStatus }
  | { kind: 'ticket-started'; id: number; title: string }
  | { kind: 'ticket-summary'; id: number; text: string }
  | { kind: 'check-result'; id: number; passed: boolean; output?: string }
  | { kind: 'plan-ready'; id: number; plan: string }
  | { kind: 'review-result'; id: number; approved: boolean; feedback: string; round: number }
  | { kind: 'ticket-done'; id: number; terminal: 'done' | 'review' | 'park' }
  | { kind: 'ticket-failed'; id: number; error: string }
  | { kind: 'paused' }
  | { kind: 'stopped'; reason: LoopStopReason }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'log'; text: string }
  | { kind: 'agent-event'; id: number; event: AgentEvent }
  // Hermes orchestrator events (P2/O1): typed phase + round signals so the Mission Control UI shows a live
  // run-state and a structured replan timeline instead of regex-matching free-text notices.
  | { kind: 'hermes-state'; state: HermesUiState }
  | { kind: 'hermes-round'; phase: 'decompose' | 'replan' | 'improve' | 'split'; round: number; added?: number; reopened?: number; tickets?: number; note?: string }

/* ----- Loop board data (native board view, loop-workspace P1) ----- */

export interface BoardTicketRow {
  id: number
  project: string
  title: string
  status: string
  priority?: number
  assignee?: string | null
  ready?: boolean
  blocked?: boolean
  check?: string | null
  /** Ticket body — carries the Hermes "**Department: …**" banner the graph reads for the team badge. */
  body?: string
  /** Ticket ids this one depends on — drives the Hermes plan-graph layout. */
  deps?: number[]
  /** Unmet deps (subset of deps not yet done/cancelled) — board-decorated. */
  blocked_by?: number[]
}
export interface BoardCounts {
  total: number
  ready: number
  blocked: number
  todo: number
  in_progress: number
  review: number
  done: number
  cancelled: number
}
export interface LoopBoardData {
  tickets: BoardTicketRow[]
  counts: BoardCounts
}

/** A raid's folder info for the rail. `cwd` = where the raid actually runs (override, else <root>/<name>);
 *  `group` = the rail's grouping key (the override repo if assigned, else the shared projects root — so unassigned
 *  raids cluster under one root group and assigned ones break out under their repo). */
export interface RaidFolderInfo {
  cwd: string
  group: string
}

/** What a conversation rewind would do — file restores + the text going back to the composer (W5c). */
export interface RewindPlanSummary {
  files: { path: string; action: 'restore' | 'delete' }[]
  /** Files refused because their snapshot looks binary (the utf8 pipeline can't restore them faithfully). */
  binarySkipped: string[]
  /** How many turns are being rewound. */
  turns: number
  composerText: string
}

export interface RewindExecuteResult {
  ok: boolean
  error?: string
  restored?: number
  failed?: number
  total?: number
  binarySkipped?: string[]
  composerText?: string
  /** The kept transcript after truncation — feed to deriveItems to reset the chat view. */
  messages?: ChatMessage[]
}

/** W4a self-update: what the Settings Update section shows. */
export interface UpdateStatus {
  /** False in dev (npm run dev) — the section hides itself. */
  packaged: boolean
  state?: 'unconfigured' | 'no-pending-build' | 'up-to-date' | 'pending' | 'pending-invalid'
  installedAt?: number
  pendingAt?: number
  /** Outcome of the LAST self-update attempt (from the helper's result file), if any. */
  lastResult?: { ok: boolean; rc?: number; at?: string } | null
}

/** The typed surface preload exposes to the renderer as `window.api`. */
export interface Api {
  agent: {
    startTurn(p: { sessionId: string; userText: string; images?: string[] }): Promise<{ turnId: string }>
    cancel(turnId: string): Promise<void>
    decide(p: { turnId: string; callId: string; decision: ApprovalDecision; note?: string }): Promise<void>
    setMode(p: { sessionId: string; mode: AgentMode }): Promise<void>
    /** Per-chat reasoning-effort override (composer dial); null restores the connection/profile default. */
    setEffort(p: { sessionId: string; effort: 'off' | 'low' | 'medium' | 'high' | null }): Promise<void>
    clearApprovals(sessionId: string): Promise<void>
    undoTurn(p: { sessionId: string; turnId: string }): Promise<{ restored: number; total: number; failed: number }>
    /** W5c rewind: what rewinding to this turn would do — shown in the confirm dialog. Null = not rewindable. */
    rewindPlan(p: { sessionId: string; turnId: string }): Promise<RewindPlanSummary | null>
    /** W5c rewind: restore the files, truncate the transcript, persist. Returns the kept messages so the
     *  renderer can reset its items without a session round-trip. */
    rewindExecute(p: { sessionId: string; turnId: string }): Promise<RewindExecuteResult>
    onEvent(cb: (e: AgentEvent) => void): () => void
  }
  sessions: {
    list(): Promise<SessionMeta[]>
    load(id: string): Promise<Session | null>
    create(cwd: string): Promise<SessionMeta>
    remove(id: string): Promise<void>
    search(query: string): Promise<SessionSearchHit[]>
    setComposer(p: { id: string; composer: ComposerSessionState }): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  update: {
    /** W4a: installed-vs-pending build comparison for the Settings Update section. */
    status(): Promise<UpdateStatus>
    /** Kick the detached install helper and quit; resolves {ok:false} with a reason instead of quitting
     *  when there is nothing valid to install. */
    install(): Promise<{ ok: boolean; error?: string }>
  }
  mcp: {
    /** Live connection status of each configured MCP server (for the Settings UI). */
    status(): Promise<MCPServerStatus[]>
  }
  clipboard: {
    /** Copy via the main process, which (unlike navigator.clipboard) needs no document focus. */
    write(text: string): Promise<boolean>
  }
  lmstudio: {
    /** Probe any OpenAI-compatible backend; defaults to the active connection when no args given. */
    probe(p?: { baseURL?: string; apiKey?: string; kind?: ConnectionKind }): Promise<ProbeResult>
    /** Full model list for a backend, for a picker — LM Studio includes UNLOADED installed models. */
    models(p?: { baseURL?: string; apiKey?: string; kind?: ConnectionKind }): Promise<string[]>
    /** One-line capability-profile summary for a model id (seeded + learned facts). */
    profileDescribe(model: string): Promise<string>
    /** The context window a turn will actually use: the setting trimmed to the model's real loaded length. */
    contextLimit(): Promise<number>
    /** Fires whenever that effective window changes (connection switch, settings save, model reload). */
    onContextLimit(cb: (limit: number) => void): () => void
  }
  voice: {
    /** Is the voice sidecar reachable? */
    probe(): Promise<VoiceProbeResult>
    /** Transcribe a 16 kHz mono WAV (push-to-talk capture) to text. */
    transcribe(p: { wav: ArrayBuffer }): Promise<{ text: string; error?: string }>
    /** Synthesize one chunk of speech; returns WAV bytes to play in the renderer. */
    speak(p: { text: string; voice?: string }): Promise<{ wav?: ArrayBuffer; error?: string }>
    /** Turn hands-free ("Hey Jarvis") listening on/off; main owns the sidecar subscription. */
    setWake(enabled: boolean): Promise<{ ok: boolean; error?: string }>
    /** Subscribe to wake-word events forwarded from the sidecar. */
    onWakeEvent(cb: (e: WakeEvent) => void): () => void
  }
  dialog: {
    pickDirectory(): Promise<string | null>
    pickFiles(p?: { sessionId?: string }): Promise<string[]>
  }
  workspace: {
    listFiles(p: { sessionId: string; query: string }): Promise<string[]>
    readFile(p: { sessionId: string; path: string }): Promise<string | null>
    savePlan(p: { sessionId: string; content: string; title?: string }): Promise<string | null>
    listPlans(p: { sessionId: string }): Promise<PlanFile[]>
  }
  bgtasks: {
    list(): Promise<BgTask[]>
    stop(id: string): Promise<void>
    output(id: string): Promise<string>
    onEvent(cb: (tasks: BgTask[]) => void): () => void
  }
  git: {
    status(sessionId: string): Promise<GitStatus>
    diff(p: { sessionId: string; path: string }): Promise<string>
    commit(p: { sessionId: string; message: string }): Promise<{ ok: boolean; error?: string }>
  }
  ui: {
    setTitleBarOverlay(p: { color: string; symbolColor: string }): Promise<void>
  }
  preview: {
    /** Subscribe to main's open/navigate/focus requests for the Preview panel. */
    onControl(cb: (c: PreviewControl) => void): () => void
    /** Report the live <webview>'s guest id (called on dom-ready). */
    register(p: PreviewRegister): void
    /** Report that the Preview <webview> went away (panel closed / unmounted). */
    closed(webContentsId: number): void
  }
  loop: {
    /** Hermes: decompose a big goal into board tickets, then drain + replan until done. Auto-runs the drain
     *  (includeReview on); progress streams as loop events. Returns once decomposition has kicked off. */
    orchestrate(p: { goal: string; config: LoopConfig }): Promise<{ ok: boolean; error?: string }>
    /** Start a board-draining run (inert stub in T2; BoardRunner lands in T3). */
    start(config: LoopConfig): Promise<{ ok: boolean; error?: string }>
    pause(): Promise<void>
    /** Resume a paused Hermes run — releases the orchestrator pause gate so the next drain starts (C1). */
    resume(): Promise<void>
    stop(): Promise<void>
    status(): Promise<LoopStatus>
    /** Uncommitted diff of the active run's worktree (empty when no run/worktree). */
    diff(): Promise<string>
    /** Fine per-ticket control (pause/stop/skip/retry) — see TicketAction. */
    ticketAction(p: { id: number; action: TicketAction }): Promise<{ ok: boolean; error?: string }>
    /** Resolve a plan-gate pause: approve (optionally with an edited plan) or reject the surfaced plan.
     *  Resolves { ok:false } if no gate for that id is currently awaiting (e.g. a stale/duplicate click). */
    planDecision(p: { id: number; decision: 'approve' | 'reject'; editedPlan?: string }): Promise<{ ok: boolean }>
    onEvent(cb: (e: LoopEvent) => void): () => void
  }
  hermes: {
    /** Send a message to Brooke (the group manager) for a project; her reply streams as hermes events.
     *  Returns the turn id. The manager session is created on first message (manager persona + control tools). */
    message(p: { project: string; text: string }): Promise<{ turnId: string }>
    /** Brooke's conversation so far for a project (role/content), to rehydrate the chat on open. */
    history(project: string): Promise<{ role: string; content: string }[]>
    /** Cancel Brooke's in-flight reply. */
    cancel(): Promise<void>
    /** Subscribe to Brooke's streamed turn events (assistant deltas, tool calls/results, turn-done). */
    onEvent(cb: (e: AgentEvent) => void): () => void
    /** Read a team's lead memory for a project (team-leads Phase 4 — the per-dept memory viewer). */
    teamMemory(p: { project: string; dept: string }): Promise<string>
    /** Overwrite a team's lead memory (the editor's Save). */
    setTeamMemory(p: { project: string; dept: string; content: string }): Promise<{ ok: boolean }>
  }
  loopBoard: {
    /** Per-project board snapshot (tickets + counts); fetched in main to dodge the board's origin guard. */
    list(project: string): Promise<LoopBoardData>
    /** Distinct board project names (for the loops rail). */
    projects(): Promise<string[]>
    /** Per-raid folder info (raid name → {cwd, group}) — drives the rail's repo grouping. `cwd` is where the raid
     *  actually runs; `group` is the grouping key: an explicit raidFolders override, else the shared projects root. */
    folders(names: string[]): Promise<Record<string, RaidFolderInfo>>
    /** Post a comment on a ticket (the per-ticket reply box). */
    comment(id: number, text: string): Promise<void>
    /** Subscribe to board-changed pings — re-fetch on fire. Returns an unsubscribe. */
    onChange(cb: () => void): () => void
  }
}
