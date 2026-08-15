import { ipcMain, BrowserWindow, dialog, app } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { IPC, type AgentEvent, type ApprovalDecision, type ProbeResult, type PreviewRegister, type LoopConfig, type LoopEvent, type TicketAction, type BoardTicketRow, type RaidFolderInfo, type RewindPlanSummary, type RewindExecuteResult, type UpdateStatus } from '../shared/ipc-types'
import type { AgentMode, ComposerSessionState, Settings, ChatMessage } from '../shared/domain-types'
import { activeConnection, type Connection } from '../shared/domain-types'
import { loadSettings, updateSettings } from './store/settings'
import { listSessions, createSession, loadSession, deleteSession, saveTranscript, saveSession, saveComposerState, searchSessions } from './store/sessions'
import { probeConnection, listModels, fetchModelContextLengths } from './lmstudio/probe'
import { ensureModelLoaded } from './lmstudio/loadModel'
import { createConnectionClient, type LLMConnection } from './agent/lmstudio'
import { setManagerMemoryDir } from './agent/managerMemory'
import { initModelProfiles, resolveConnectionDefaults, describeProfile } from './agent/modelProfiles'
import { setSoulDir } from './agent/soul'
import { buildRegistry, buildManagerRegistry, imageGenConfigured } from './agent/tools'
import { MCPManager } from './agent/mcp/manager'
import { boardRunner } from './agent/boardRunner'
import { runTicketWithCheck, runReview, writeRejectionFeedback, BOARD_DRIVING_TOOLS } from './agent/boardInner'
import { runHermes, runCritic, applyReplanDiff, withRoleBanner, hermesRunConfig, type StuckTicket } from './agent/specOrchestrator'
import { normalizeRole, departmentOf } from './agent/specPlan'
import { canonicalizeProject, resolveRaidCwd } from './loop-safety'
import { validateCheck, rewriteCheck } from './agent/checkLint'
import { setHermesController, type HermesController } from './agent/hermesControl'
import { createPauseGate } from './agent/pauseGate'
import { createSingleFlight } from './agent/singleFlight'
import { readRunRecord, writeRunRecord, patchRunRecord } from './agent/hermesRun'
import { planBoardDedupe } from './agent/boardDedupe'
import { estimateHistoryTokens, managerResetSeed } from './agent/managerReset'
import { ensureBoardRunning, ensureBoardThenResyncMcp, waitForBoardReady } from './boardAutostart'
import { freeOtherRoleModels } from './agent/modelSwap'
import { readTeamMemory, writeTeamMemory } from './agent/teamMemory'
import { fetchBoard, fetchProjects, subscribeBoardChanges, postComment, addTicket, addDependency, setStatus, fetchTickets, getSpec, updateTicket } from './loopBoard'
import { AgentSession, type AgentConfig } from './agent/loop'
import { Workspace } from './agent/workspace'
import { bgTasks } from './bgtasks'
import { saveSnapshot, loadSnapshot, deleteSnapshot } from './store/snapshots'
import { planRewind } from './rewind'
import { compareBuilds, launchUpdateHelper, parseUpdateResult, statBuild } from './selfUpdate'
import { runGit } from './git'
import { buildGitFiles } from './git-util'
import { fileStamp } from './time-util'
import { previewService } from './preview'
import { probeVoice, transcribe as voiceTranscribe, speak as voiceSpeak, setWake as voiceSetWake, subscribeWake } from './voice'
import type { WakeEvent } from '../shared/ipc-types'
import { VOICE_FEATURE_ENABLED } from '../shared/features'
import { createTurnTranscriptSaver, isTranscriptCheckpointEvent } from './turnTranscriptSaver'

let settings: Settings
let client: LLMConnection
// B3 feature flag: image/video tools only exist when generation is plausibly usable on this
// machine (fresh public installs get a registry without them; Settings changes apply next launch).
const registry = buildRegistry({ imageGen: imageGenConfigured(loadSettings().image) })
const mcp = new MCPManager()
let mcpToolNames: string[] = []
const sessions = new Map<string, AgentSession>()

/**
 * Connect the configured external MCP servers and swap their discovered tools into the shared registry.
 * Fire-and-forget so a slow/down server never blocks startup or a settings save — the tools simply appear
 * on the next turn once the server finishes connecting. Re-run whenever `settings.mcpServers` changes.
 *
 * Serialized via `mcpSyncOp` (the same pattern `wakeOp` uses below): two overlapping runs would otherwise
 * interleave their unregister/register/`mcpToolNames` bookkeeping around the `await` and leave the registry
 * holding a stale tool set or orphaned tools.
 */
let mcpSyncOp: Promise<void> = Promise.resolve()
function syncMcpTools(): Promise<void> {
  mcpSyncOp = mcpSyncOp.then(async () => {
    try {
      await mcp.sync(settings.mcpServers)
      for (const name of mcpToolNames) registry.unregister(name)
      const names: string[] = []
      for (const t of mcp.tools()) {
        if (registry.get(t.name)) continue // never let an external tool shadow a built-in (or a same-round dup)
        registry.register(t)
        names.push(t.name)
      }
      mcpToolNames = names
    } catch {
      /* a failed MCP sync must never break the rest of the app */
    }
  })
  return mcpSyncOp
}
// W1b: a successful MCP auto-reconnect changes the live tool set — re-sync the registry so the restored
// server's tools reappear without a settings save. (sync() is idempotent for healthy servers.)
mcp.onToolsChanged = () => void syncMcpTools()
const turnToSession = new Map<string, string>()
const turnTranscriptSaver = createTurnTranscriptSaver((sessionId) => sessions.get(sessionId))
// Real loaded context lengths, keyed by model id (LM Studio only). Reset on a connection switch so a
// stale entry from one backend can't trim a different backend that happens to serve the same model id.
let modelContextLengths: Record<string, number> = {}
let lastActiveConnId = ''
// Models we've already warned about loading smaller than the configured window — so the cap hint shows once
// per model per session, not on every turn. Reset on a connection switch (alongside modelContextLengths).
const cappedNotified = new Set<string>()

async function refreshContextLengths(): Promise<void> {
  const conn = activeConnection(settings)
  // LM Studio's native /api/v0/models reports real loaded context lengths; other backends don't expose it.
  if (conn.kind !== 'lmstudio') return
  const m = await fetchModelContextLengths(conn.baseURL)
  // Only replace on a non-empty read so a transient fetch failure (or every model briefly unloaded)
  // can't wipe a good cache and make us fall back to the raw setting mid-session.
  if (Object.keys(m).length) modelContextLengths = m
}

/**
 * Pin the active model to the configured context window before a turn runs. LM Studio JIT-respawns an
 * unloaded model (TTL expiry, generate_video's `lms unload --all`, manual reload) at its DEFAULT
 * context — silently dropping a large window. ensureModelLoaded reloads it at `contextLimitTokens`
 * when needed (no-op when already loaded big enough) so the setting survives the respawn. Best-effort.
 */
async function ensureModelForTurn(turnId: string): Promise<void> {
  const conn = activeConnection(settings)
  // The `lms` context-pin only applies to LM Studio; remote/other backends manage their own loading.
  if (conn.kind !== 'lmstudio' || !conn.model) return
  const ctxLimit = conn.contextLimitTokens ?? settings.contextLimitTokens
  try {
    const res = await ensureModelLoaded(
      conn.baseURL,
      conn.model,
      ctxLimit,
      (ctx) =>
        emit({
          type: 'notice',
          turnId,
          text: `Loading ${conn.model} at ${ctx.toLocaleString()}-token context (it was unloaded or respawned smaller)…`
        })
    )
    // Seed the cache so this turn's config/meter reflect the real loaded length even if the refresh races —
    // also on a no-reload turn (the model was already loaded smaller), so configFromSettings trims correctly.
    if (res.ctx) modelContextLengths = { ...modelContextLengths, [conn.model]: res.ctx }
    // The model maxed out below the configured window — tell the user ONCE so they can lower the setting.
    if (res.cappedTo && !cappedNotified.has(conn.model)) {
      cappedNotified.add(conn.model)
      emit({
        type: 'notice',
        turnId,
        text:
          `${conn.model} loaded at ${res.cappedTo.toLocaleString()} tokens — your ${ctxLimit.toLocaleString()}-token ` +
          `context setting exceeds what fits on this GPU. Using ${res.cappedTo.toLocaleString()}. Lower this ` +
          `connection's context (Settings → Connections) for faster, more reliable tool calls.`
      })
    }
  } catch {
    /* best-effort — fall back to LM Studio's own JIT load, exactly as before */
  }
}

function emit(e: AgentEvent): void {
  if (isTranscriptCheckpointEvent(e)) {
    const sessionId = turnToSession.get(e.turnId)
    if (sessionId) turnTranscriptSaver.turnDone(sessionId)
  }
  // A turn can finish (or bg-task output can arrive) just as the window closes — sending to a
  // destroyed webContents throws "Object has been destroyed". Guard so it's a no-op instead.
  const wc = BrowserWindow.getAllWindows()[0]?.webContents
  if (wc && !wc.isDestroyed()) wc.send(IPC.agentEvent, e)
}

// ---- Hands-free wake word: own the sidecar SSE subscription, forward events to the renderer ----
let wakeStop: (() => void) | null = null
let wakeEnabled = false
// Serialize start/stop so a rapid disable→enable (the renderer effect's cleanup + re-run on settings
// load) can't race at the sidecar — otherwise /wake/stop may land after /wake/start and leave it off.
let wakeOp: Promise<unknown> = Promise.resolve()

function emitWake(e: WakeEvent): void {
  const wc = BrowserWindow.getAllWindows()[0]?.webContents
  if (wc && !wc.isDestroyed()) wc.send(IPC.voiceWakeEvent, e)
}

function startWakeSub(): void {
  if (wakeStop) return
  wakeStop = subscribeWake(settings.voice.sidecarURL, emitWake, () => {
    // Stream ended (sidecar restart / drop). Re-subscribe AND re-arm /wake/start after a short backoff:
    // a restarted sidecar forgot it was listening, so without re-arming, hands-free goes silently dead.
    wakeStop = null
    if (wakeEnabled) setTimeout(() => void (wakeEnabled && setWakeEnabled(true)), 2000)
  })
}

function stopWakeSub(): void {
  wakeStop?.()
  wakeStop = null
}

function setWakeEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const run = wakeOp.then(async () => {
    wakeEnabled = enabled
    if (enabled) {
      startWakeSub() // subscribe first so we don't miss the first detection
      return voiceSetWake(settings.voice.sidecarURL, true)
    }
    stopWakeSub()
    return voiceSetWake(settings.voice.sidecarURL, false)
  })
  wakeOp = run.catch(() => undefined) // keep the chain alive even if one op rejects
  return run
}

function rebuildClient(): void {
  client = createConnectionClient(activeConnection(settings))
}

// Hermes-parity context ceiling for a local weak model: it reasons near-Opus under ~80k tokens, then
// hallucinates/loops, so keep chat inside the same "genius zone" the board worker uses (boardInner.ts
// A local, weak, OpenAI-compatible model — the Hermes case. These connections get the Hermes-parity
// defaults below (text tool-calls to dodge native large-arg truncation, /no_think to free output budget).
// Cloud connections (openai/anthropic/gemini) have robust native function calling, so they're left as
// configured. NOTE: unlike the board (which clamps context to an 80k "genius zone" because it runs
// autonomously), chat must honour the user's chosen context window — they set it deliberately.
function isLocalWeakModel(conn: Connection): boolean {
  if (conn.kind === 'lmstudio' || conn.kind === 'ollama') return true
  if (conn.kind === 'openai-compat') {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(conn.baseURL)
  }
  return false
}

function configFromSettings(): AgentConfig {
  const conn = activeConnection(settings)
  // A connection's per-connection override wins; otherwise inherit the global Settings default.
  const temperature = conn.temperature ?? settings.temperature
  const maxTokens = conn.maxTokens ?? settings.maxTokens
  const ctxLimit = conn.contextLimitTokens ?? settings.contextLimitTokens
  const real = modelContextLengths[conn.model]
  // Trim against the model's actual loaded context length when LM Studio reports it.
  const trimmed = real ? Math.min(ctxLimit, real) : ctxLimit
  const local = isLocalWeakModel(conn)
  return {
    model: conn.model,
    temperature,
    maxTokens,
    maxTurns: settings.maxTurns,
    // Honour the user's configured context window (trimmed only to the model's real loaded length when LM
    // Studio reports it). No genius-zone clamp here — that's a board-only autonomous optimization.
    contextLimitTokens: trimmed,
    images: settings.image,
    // Voice on → the agent speaks back, so shape replies as a concise spoken assistant.
    voicePersona: VOICE_FEATURE_ENABLED && settings.voice.enabled,
    connectionKind: conn.kind,
    connectionLabel: conn.label,
    // Per-MODEL capability profile decides the local defaults (seeded + learned facts) so a model
    // swap can't inherit stale mechanics; an explicit per-connection value still wins, and
    // non-local connections keep undefined defaults exactly as before.
    preferTextToolCalls: conn.preferTextToolCalls ?? resolveConnectionDefaults(conn.model, local).preferTextToolCalls,
    reasoningEffort: conn.reasoningEffort ?? resolveConnectionDefaults(conn.model, local).reasoningEffort,
    autoMemory: settings.autoMemory !== false, // default on; the board leaves it off (ephemeral worktree)
    // Hermes parity: an interactive chat should persist, not bail. Stuck/oscillation guards warn and let
    // the model keep trying up to a high circuit-breaker. The board leaves this off (it parks + restarts).
    warnDontBail: true,
    // Hermes parity: compact earlier (≈0.55, Hermes uses 0.5) so a long chat stays coherent before the
    // model degrades. The board keeps the default 0.8 (its context clamp is tuned around that).
    compactAtFraction: 0.55,
    // W3a: dangerous shell commands in auto mode drop to an approval prompt (chat has a human present).
    shellScreening: settings.shellScreening ?? 'screen',
    headless: false
  }
}

function getOrCreateSession(sessionId: string): AgentSession | null {
  const existing = sessions.get(sessionId)
  if (existing) {
    existing.setConfig(configFromSettings())
    return existing
  }
  const persisted = loadSession(sessionId)
  if (!persisted) return null
  const session = new AgentSession({
    id: persisted.id,
    workspaceRoot: persisted.cwd,
    client,
    registry,
    config: configFromSettings(),
    mode: persisted.mode,
    history: persisted.messages,
    allowList: persisted.allowList,
    tokenScale: persisted.tokenScale
  })
  sessions.set(sessionId, session)
  return session
}

/** A project's on-disk work folder, ALWAYS derived from the PERSISTED projects root (read fresh, not a possibly-stale
 *  in-memory copy or a controller cwd frozen at getOrCreateBrooke time) joined with the canonical project folder. This
 *  is the SINGLE source of truth for where a project's code lives — so a NEW project can never nest inside a PREVIOUS
 *  project's folder (a real divergence we hit: a new project's code landed under <old project>/<new project> because the
 *  run inherited a stale root). The base is the UNIFIED working folder (lastCwd), so it always matches the UI. */
/** Resolve a raid's work folder from the LIVE in-memory settings WITHOUT creating it — the read-only form used by the
 *  rail's folder grouping. A per-raid override (settings.raidFolders) wins; otherwise <lastCwd | hermesProjectsRoot>/
 *  <project> (the top-bar folder picker is the projects root). process.cwd() only when nothing at all is configured. */
function rawWorkFolder(project: string): string {
  return (
    resolveRaidCwd(project, {
      raidFolders: settings.raidFolders,
      lastCwd: settings.lastCwd,
      hermesProjectsRoot: settings.hermesProjectsRoot
    }) || process.cwd()
  )
}
/** Whether ANY work-folder location is configured for this raid (override OR a projects root) — i.e. whether the run
 *  cwd should be PINNED to the derived folder rather than left at the caller's picked cwd. */
function hasWorkFolderConfig(project: string): boolean {
  return !!(
    (settings.lastCwd ?? '').trim() ||
    (settings.hermesProjectsRoot ?? '').trim() ||
    settings.raidFolders?.[project] ||
    settings.raidFolders?.[canonicalizeProject(project)]
  )
}

function projectWorkFolder(project: string): string {
  // The SAME resolution as rawWorkFolder, but creates the folder — use this on the run/write paths. Uses the LIVE
  // in-memory settings (the SAME source the renderer reads via settingsGet) so the work folder always matches what
  // the user sees; a fresh loadSettings() disk read was observed to diverge and send work to a stale folder.
  const c = rawWorkFolder(project)
  try {
    fs.mkdirSync(c, { recursive: true })
  } catch {
    /* surfaced when a tool actually writes there */
  }
  return c
}

export function registerIpc(): void {
  settings = loadSettings()
  rebuildClient()
  setManagerMemoryDir(app.getPath('userData')) // Brooke's durable cross-project memory lives in userData
  setSoulDir(app.getPath('userData')) // the chat agent's editable SOUL.md identity lives in userData too
  initModelProfiles(app.getPath('userData')) // per-model capability facts (learned overlay) live beside them
  lastActiveConnId = activeConnection(settings).id
  // Aborts the active Hermes orchestration (decompose → drain → replan cycle) on Stop; null when none running.
  let hermesAbort: AbortController | null = null
  let hermesContinuous = false // "keep working until stopped" mode (Brooke's keep_working lever); read live by the runHermes seam
  // Pause gate (C1): the orchestrator awaits this between rounds, so a pause genuinely HOLDS the whole cycle
  // instead of being un-paused by the next round's drain.start(). One live instance shared by every Hermes
  // run; the pause/resume controls (Brooke's tools + the header button) drive it.
  const hermesPause = createPauseGate()
  // Single-flight guard (O4): ONE Hermes run at a time — a second start refuses instead of silently aborting the
  // first (true per-project concurrency would just thrash the single local GPU's model-swap). See singleFlight.ts.
  const hermesFlight = createSingleFlight()
  void refreshContextLengths()
  void syncMcpTools()
  // The ticket board now runs IN-PROCESS (no external folder/app). DB lives in userData; the web UI is shipped
  // as an extra resource. If a standalone board is already answering on :8930 we defer to it.
  const boardPaths = (): { dbPath: string; publicDir: string } => ({
    dbPath: path.join(app.getPath('userData'), 'board.db'),
    publicDir: app.isPackaged ? path.join(process.resourcesPath, 'board-public') : path.join(app.getAppPath(), 'resources', 'board-public')
  })
  // One-time migration: bring an existing standalone board.db (the user's old ticket-board folder) into userData
  // so they keep their tickets/raids. Best-effort; a fresh DB is created otherwise.
  const migrateLegacyBoardDb = (log?: (m: string) => void): void => {
    try {
      const { dbPath } = boardPaths()
      if (fs.existsSync(dbPath)) return
      const legacyDir = settings.ticketBoardPath?.trim()
      if (!legacyDir) return
      for (const suffix of ['', '-wal', '-shm']) {
        const src = path.join(legacyDir, `board.db${suffix}`)
        if (fs.existsSync(src)) fs.copyFileSync(src, `${dbPath}${suffix}`)
      }
      if (fs.existsSync(dbPath)) log?.(`Migrated existing board data from ${legacyDir} into NordCode.`)
    } catch {
      /* best-effort */
    }
  }
  migrateLegacyBoardDb((text) => boardRunner.emit({ kind: 'notice', text }))
  // Start the board, then re-sync MCP: the syncMcpTools() above races the board's port bind on a cold
  // launch and loses ("MCP: 'board' failed to connect", one per launch) — and since a re-sync otherwise
  // only happens on a settings save, chat would run the whole session without the board__* tools. Other
  // MCP servers are NOT held back: the early sync already connected them; this second pass only
  // reconnects servers still in an error state (MCPManager.sync leaves healthy ones untouched).
  void ensureBoardThenResyncMcp({
    ensure: () => ensureBoardRunning(boardPaths(), (text) => boardRunner.emit({ kind: 'notice', text })),
    waitReady: waitForBoardReady,
    resync: () => void syncMcpTools()
  })
  app.on('before-quit', () => void mcp.dispose())

  bgTasks.onUpdate(() => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(IPC.bgtaskEvent, bgTasks.list())
  })

  ipcMain.handle(IPC.mcpStatus, () => mcp.statuses())

  // Loop runner (T3): the BoardRunner singleton drains the board.
  ipcMain.handle(IPC.loopStart, (_e, config: LoopConfig) => {
    // Validate the workspace exists up front, so a stale folder gives a clear message (not a confusing git error).
    let dirOk = false
    try {
      dirOk = fs.statSync(config.cwd).isDirectory()
    } catch {
      dirOk = false
    }
    if (!dirOk) {
      const error = `The selected folder does not exist: ${config.cwd}`
      boardRunner.emit({ kind: 'error', message: error })
      return { ok: false, error }
    }
    return boardRunner.start(config)
  })
  ipcMain.handle(IPC.loopPause, () => {
    hermesPause.pause() // hold the orchestrator cycle (C1); boardRunner.pause halts the in-flight drain too
    return boardRunner.pause()
  })
  ipcMain.handle(IPC.loopResume, () => {
    hermesPause.resume() // release the gate; runHermes resumes and starts the next drain itself
  })
  ipcMain.handle(IPC.loopStop, () => {
    hermesContinuous = false // a Stop ends "keep working" mode
    hermesAbort?.abort() // a Hermes run owns the drain across rounds — stop the cycle, not just this drain
    hermesPause.resume() // clear any pause so a stopped run never strands the gate paused for the next run
    hermesFlight.clear() // free the single-flight slot so a new run can start right after a stop (O4)
    return boardRunner.stop()
  })
  ipcMain.handle(IPC.loopStatus, () => boardRunner.status())
  // T4/T5: real per-ticket execution — a fresh AgentSession per ticket (auto-approve), then run the ticket's
  // `check` and decide done/review/iterate/park. Inner agent + check events stream to the Loop feed.
  // A per-ticket worker gets the tools MINUS the board-driving ones: the orchestrator owns ticket flow, so a
  // worker that could `claim_next`/`update done` would drain the whole board itself in one session and bypass
  // the gates + replan loop. Filtered per ticket so it reflects the live MCP tool set (board MCP excluded too).
  boardRunner.runTicket = (ticket, config, hooks, opts) =>
    runTicketWithCheck(ticket, config, { settings, registry: registry.without(BOARD_DRIVING_TOOLS), emit: (e) => boardRunner.emit(e) }, hooks, opts)
  // Parallel-batch seams: review a coded worktree (separate from inline review) + persist rejection feedback so a
  // re-queued batch ticket carries it into its sequential re-run.
  boardRunner.reviewTicket = (ticket, config) =>
    runReview(ticket, config, { settings, registry: registry.without(BOARD_DRIVING_TOOLS), emit: (e) => boardRunner.emit(e) })
  // Free the coder before the batched review so the reviewer doesn't load on top of the still-resident 35B.
  boardRunner.swapToReviewer = (config) => {
    const reviewerModel = config.reviewerModel?.trim() || settings.connections.find((c) => c.id === config.reviewerConnectionId)?.model || ''
    return freeOtherRoleModels(settings, config, reviewerModel, (text) => boardRunner.emit({ kind: 'notice', text }), settings.keepReviewerResident)
  }
  boardRunner.saveRejectionFeedback = writeRejectionFeedback

  // Loop board data (loop-workspace P1): fetched in main (no Origin → passes the board's origin guard);
  // the renderer hook re-fetches on each board-change ping. One lazy SSE consumer, started on first use.
  let boardSubStarted = false
  ipcMain.handle(IPC.loopBoardList, (_e, project: string) => {
    if (!boardSubStarted) {
      boardSubStarted = true
      subscribeBoardChanges(() => BrowserWindow.getAllWindows()[0]?.webContents.send(IPC.loopBoardChange))
    }
    return fetchBoard(canonicalizeProject(project)) // R5: read the SAME canonical board the orchestrator writes
  })
  ipcMain.handle(IPC.loopBoardProjects, () => fetchProjects())
  // Read-only: resolve each raid's work folder + grouping key (no folder creation) so the rail can group by repo.
  // group = an explicit raidFolders override if set, else the shared projects root — so unassigned raids cluster
  // under one root group and assigned ones break out under their repo.
  ipcMain.handle(IPC.loopBoardFolders, (_e, names: string[]) => {
    const base = (settings.lastCwd ?? '').trim() || (settings.hermesProjectsRoot ?? '').trim()
    const out: Record<string, RaidFolderInfo> = {}
    for (const n of names ?? []) {
      const override = (settings.raidFolders?.[n] ?? settings.raidFolders?.[canonicalizeProject(n)])?.trim()
      out[n] = { cwd: rawWorkFolder(n), group: override || base || '' }
    }
    return out
  })
  ipcMain.handle(IPC.loopDiff, () => boardRunner.diff())
  ipcMain.handle(IPC.loopBoardComment, (_e, p: { id: number; text: string }) => postComment(p.id, p.text))
  // Per-ticket fine control (#52): pause/stop the in-flight ticket, skip a queued one, retry a parked/finished one.
  ipcMain.handle(IPC.loopTicketAction, (_e, p: { id: number; action: TicketAction }) => boardRunner.ticketAction(p.id, p.action))
  // Plan-gate (#53): resolve a ticket's surfaced plan — approve (optionally with an edited plan) or reject.
  ipcMain.handle(IPC.loopPlanDecision, (_e, p: { id: number; decision: 'approve' | 'reject'; editedPlan?: string }) =>
    boardRunner.resolvePlan(p.id, { decision: p.decision, editedPlan: p.editedPlan })
  )

  // Hermes: decompose a big goal → write the board → (drain → replan)* until done. Fire-and-forget: it streams
  // progress as loop events (the renderer already renders them) and returns once decomposition has kicked off.
  ipcMain.handle(IPC.loopOrchestrate, (_e, p: { goal: string; config: LoopConfig }) => {
    if (!p.goal?.trim()) return { ok: false, error: 'a goal is required' }
    // Codex-style folders: each raid works in its resolved folder — a per-raid override (raidFolders) if set, else
    // <projectsRoot>/<project>, created on demand — so "3d slicer" lives in its folder. Otherwise use the picked cwd.
    let cwd = p.config.cwd
    if (hasWorkFolderConfig(p.config.project)) {
      cwd = rawWorkFolder(p.config.project) // override-aware; matches the rail's grouping + the run pin below
      try {
        fs.mkdirSync(cwd, { recursive: true })
      } catch (e) {
        const error = `Could not create the project folder ${cwd}: ${e instanceof Error ? e.message : String(e)}`
        boardRunner.emit({ kind: 'error', message: error })
        return { ok: false, error }
      }
    }
    try {
      if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory')
    } catch {
      const error = `The work folder does not exist: ${cwd}`
      boardRunner.emit({ kind: 'error', message: error })
      return { ok: false, error }
    }
    // Hermes runs in ONE shared working tree across rounds (C3) with review as a terminal hand-off — see
    // hermesRunConfig. A caller's per-run branch isolation would re-branch from HEAD each round and lose prior
    // rounds' work, so it's forced off (with a notice when the caller asked for it).
    if (p.config.branchPerRun) boardRunner.emit({ kind: 'notice', text: 'Hermes shares one working tree across rounds; per-run branch isolation was disabled for cross-round continuity.' })
    // Delegate to launchHermesRun (defined below) — the one place that owns the single-flight guard (O4),
    // the abort/pause reset, the run record, and the drain seams. (Closure ref resolves at call time.)
    const config: LoopConfig = hermesRunConfig({ ...p.config, project: canonicalizeProject(p.config.project), cwd })
    return launchHermesRun(p.goal, config)
  })

  // ----- Brooke: the Hermes group manager (conductor) -----
  const buildHermesConfig = (project: string, cwd: string): LoopConfig => ({
    cwd,
    connectionId: settings.loopWorkerConnectionId || settings.activeConnectionId,
    project: canonicalizeProject(project), // canonical BOARD key — collapses case/whitespace drift to one key (mode 6)
    mode: 'auto',
    caps: { maxTickets: 0, maxTokens: 0, maxWallclockSec: 0, maxConsecutiveFailures: 5 },
    terminal: 'auto',
    reviewerConnectionId: settings.loopReviewerConnectionId || undefined,
    workerModel: settings.loopWorkerModel || undefined,
    reviewerModel: settings.loopReviewerModel || undefined,
    swapModels: settings.loopSwapModels ?? true,
    branchPerRun: false,
    includeReview: false,
    parallelism: settings.loopParallelism && settings.loopParallelism > 1 ? settings.loopParallelism : undefined
  })

  const launchHermesRun = (goal: string, config0: LoopConfig, opts?: { skipDecompose?: boolean; spec?: string }): { ok: boolean; error?: string } => {
    // Pin the work folder to the PERSISTED projects root at launch — this is the single owner of the run, so it's the
    // one correct place to enforce <projectsRoot>/<projectFolder> as the cwd. A controller's cwd is frozen at
    // getOrCreateBrooke time and the in-memory root can drift, so without this re-derivation a new project's code could
    // land inside a PREVIOUS project's folder (observed). Surfaced as a notice when it actually corrects a divergence.
    const config: LoopConfig = hasWorkFolderConfig(config0.project)
      ? { ...config0, cwd: projectWorkFolder(config0.project) }
      : config0
    if (path.resolve(config.cwd) !== path.resolve(config0.cwd)) {
      boardRunner.emit({ kind: 'notice', text: `Work folder pinned to ${config.cwd} (was ${config0.cwd}) — under the configured projects root.` })
    }
    // Single-flight (O4): refuse a second run instead of silently aborting the first one.
    const claim = hermesFlight.tryStart(config.project)
    if (!claim.ok) return { ok: false, error: `A team is already running for "${claim.busyProject}". Stop it first (or let it finish) before starting another — one run at a time.` }
    const token = claim.token
    const emit = (e: LoopEvent): void => boardRunner.emit(e)
    hermesAbort?.abort()
    hermesAbort = new AbortController()
    const runSignal = hermesAbort.signal // snapshot: the run kickoff is deferred (board ensure), so don't read the live ref
    hermesPause.resume() // a fresh run must never inherit a prior run's paused gate
    writeRunRecord(config.cwd, { goal, project: config.project, startedAt: Date.now(), updatedAt: Date.now(), status: 'running' })
    const seams = {
      runDrainOnce: async (): Promise<void> => {
        // VRAM swap: free the planner/reviewer model before the WORKER drain so the (bigger) planner just used for
        // decompose/critic doesn't stay resident alongside the worker. Once per round, at the planner→worker
        // boundary (not per ticket). Best-effort; the worker JIT-loads next. Pairs with the planner-side free in
        // specOrchestrator's liveComplete.
        const workerModel = config.workerModel || settings.connections.find((c) => c.id === config.connectionId)?.model || activeConnection(settings).model
        await freeOtherRoleModels(settings, config, workerModel, (text) => emit({ kind: 'notice', text }), settings.keepReviewerResident)
        boardRunner.start(config)
        await boardRunner.loopDone
      },
      getParked: (): number[] => [...boardRunner.parkedIds],
      getParkedReasons: (): Record<number, string> => Object.fromEntries(boardRunner.parkReasons),
      isPaused: (): boolean => hermesPause.isPaused(),
      waitWhilePaused: (signal?: AbortSignal): Promise<void> => hermesPause.waitWhilePaused(signal),
      isContinuous: (): boolean => hermesContinuous,
      interveneOnStuck: async (stuck: StuckTicket[]): Promise<void> => {
        // Group-manager intervention (escalation tier 2): the per-ticket dept-lead rescue (boardFlow) already failed,
        // so Brooke resolves the stuck tickets herself with her tools. The team runs UNATTENDED, so she must ACT, never
        // ask the user. And she must not be SILENTLY SKIPPED when mid-chat (the old isBusy no-op dead-ended stuck runs):
        // if she is busy, the intervention is enqueued as a steer so it runs right after her current turn.
        const session = getOrCreateBrooke(config.project)
        const lines = stuck.map((t) => `- #${t.id} "${t.title}" [${t.status}]${t.check ? ` -- check: \`${t.check}\`` : ' -- no check'}`).join('\n')
        const prompt =
          `The team is STUCK and these tickets are unfinished:\n${lines}\n\n` +
          'This team runs UNATTENDED. Resolve it yourself with your tools - do NOT ask the user to choose between options and do NOT just describe the problem. ' +
          'Often the WORK is done and only the CHECK is broken or impossible: a bash idiom that fails in PowerShell (test -f / grep / 2>/dev/null / &&), an unparenthesized `Test-Path a -and Test-Path b`, or a check for files no ticket creates (e.g. a `pytest` / `npm test` check when the project has no test files). ' +
          'For EACH stuck ticket take a concrete action NOW: if its CHECK is broken or impossible, FIX it in place with edit_ticket (a corrected PowerShell check like `npm run build` / `pytest` / `npx tsc --noEmit`) and reopen_ticket it - do NOT cancel-and-refile a duplicate; cancel only a ticket that is genuinely out of scope or impossible; or reopen one that is just blocked. ' +
          'When the only work left is unresolvable, cancel it so the project can complete. Act with your tools now.'
        if (session.isBusy()) session.enqueueSteer(prompt)
        else await session.runTurn(prompt, randomUUID(), hermesEmit)
      }
    }
    // Ensure the ticket board is up BEFORE the run touches it. A board that died mid-session (or a raid restarted
    // against a dead board) would otherwise fail the first decompose with "board not reachable" — the exact failure
    // observed. Best-effort + deferred: kick the run off after the ensure so decompose doesn't race a dead/binding
    // board, but the IPC call still returns { ok: true } immediately. Wrapped so a board hiccup can never strand the
    // single-flight token (the run always starts and its .finally frees the slot).
    void (async () => {
      try {
        const r = await ensureBoardRunning(boardPaths(), (text) => boardRunner.emit({ kind: 'notice', text }))
        if (r === 'started' && !(await waitForBoardReady())) {
          boardRunner.emit({ kind: 'notice', text: 'Started the ticket board, but it has not answered yet — the first decompose may retry.' })
        }
      } catch {
        /* best-effort: proceed to the run, which surfaces a clear board error if it is still unreachable */
      }
      runHermes(goal, config.project, config, { settings, emit }, seams, {
        signal: runSignal,
        skipDecompose: opts?.skipDecompose,
        existingSpec: opts?.spec,
        // Decompose-time manager meeting OFF: the per-department grooming + meeting added a round of model calls before
        // the FIRST board write, so the board sat empty while the managers went back and forth — a slow startup. The
        // decompose prompt already right-sizes tickets and wires deps in ONE call, so the board now appears fast.
        // (Set true to re-enable the grooming/meeting pass; the code path is retained.)
        planMeeting: false
      })
        .then((r) => {
          patchRunRecord(config.cwd, { status: r.reason }, Date.now())
          boardRunner.emit({ kind: 'hermes-state', state: 'done' })
          boardRunner.emit({ kind: 'notice', text: `Hermes finished: ${r.reason} after ${r.rounds} round(s) (${r.improveRounds} improve), ${r.tickets} ticket(s).` })
        })
        .catch((err: unknown) => {
          patchRunRecord(config.cwd, { status: 'error' }, Date.now())
          boardRunner.emit({ kind: 'hermes-state', state: 'done' })
          boardRunner.emit({ kind: 'error', message: `Hermes failed: ${err instanceof Error ? err.message : String(err)}` })
        })
        .finally(() => hermesFlight.finish(token)) // frees the slot only if a newer run hasn't taken it (token guard)
    })()
    return { ok: true }
  }

  /** Department-by-department status snapshot, parsed from each ticket's "**Department: …**" banner. */
  const formatTeamStatus = (tickets: BoardTicketRow[]): string => {
    if (!tickets.length)
      return 'No tickets on the board yet — if a goal was just started, the plan is still being decomposed in the background (a few minutes). Nothing to report yet; do NOT keep polling — check again only when the user asks.'
    const deptOf = (t: BoardTicketRow): string => departmentOf(t.body) ?? 'unassigned' // canonical normalized parser (no inlined regex copy)
    const groups = new Map<string, BoardTicketRow[]>()
    for (const t of tickets) {
      const arr = groups.get(deptOf(t))
      if (arr) arr.push(t)
      else groups.set(deptOf(t), [t])
    }
    const lines: string[] = []
    for (const [dept, ts] of groups) {
      const done = ts.filter((t) => t.status === 'done').length
      const inProg = ts.filter((t) => t.status === 'in_progress').map((t) => `#${t.id}`)
      const review = ts.filter((t) => t.status === 'review').map((t) => `#${t.id}`)
      const blocked = ts.filter((t) => t.blocked).map((t) => `#${t.id}`)
      let line = `${dept}: ${done}/${ts.length} done`
      if (inProg.length) line += `; in progress ${inProg.join(' ')}`
      if (review.length) line += `; review ${review.join(' ')}`
      if (blocked.length) line += `; blocked ${blocked.join(' ')}`
      lines.push(line)
    }
    return lines.join('\n')
  }

  const makeController = (project: string, cwd: string): HermesController => {
    const config = buildHermesConfig(project, cwd)
    const emit = (e: LoopEvent): void => boardRunner.emit(e)
    return {
      startGoal: async (goal) => {
        const r = launchHermesRun(goal, config)
        return r.ok
          ? `Started — the team is decomposing "${goal}" for ${project}. Decomposition runs in the BACKGROUND and takes a few minutes; tickets appear on the board as it finishes. Tell the user it's underway in ONE short message, then STOP — do NOT call team_status in a loop waiting for the board to fill. You'll report real status when the user next asks (by then the tickets exist).`
          : r.error!
      },
      addWork: async ({ title, body, role, check, deps }) => {
        const dept = normalizeRole(role)
        // Backstop (mode 2): never file a structurally-broken check — auto-rewrite the trivial case, else drop it.
        const safeCheck = check && !validateCheck(check).ok ? (rewriteCheck(check) ?? undefined) : check
        const row = await addTicket({ project, title, body: withRoleBanner(dept, body ?? ''), check: safeCheck, spec_ref: `board:${project}` })
        // Wire prerequisites so runtime-added work runs IN ORDER (not immediately): a ticket that builds on/tests an
        // existing one must wait for it. The board cycle-checks + de-dupes, so a bad/duplicate/self edge is ignored.
        let wired = 0
        for (const dep of deps ?? []) {
          if (dep === row.id) continue
          try {
            await addDependency(row.id, dep)
            wired++
          } catch {
            /* board rejected the edge (cycle / unknown id) — skip it */
          }
        }
        return `Filed #${row.id} "${title}" to ${dept}${wired ? ` (after ${wired} prerequisite${wired > 1 ? 's' : ''})` : ''}.`
      },
      reopen: async (id) => {
        await setStatus(id, 'todo', 'reopened by Brooke')
        return `Reopened #${id}.`
      },
      cancel: async (id, reason) => {
        await setStatus(id, 'cancelled', reason?.trim() || 'cancelled by Brooke (stale/obsolete)')
        return `Cancelled #${id}${reason?.trim() ? ` — ${reason.trim()}` : ''}.`
      },
      editTicket: async (id, fields) => {
        const updated = await updateTicket(id, fields)
        const changed = (['body', 'check', 'priority'] as const).filter((k) => fields[k] !== undefined)
        const checkNote = fields.check !== undefined ? ` - check is now \`${updated.check ?? '(none)'}\`` : ''
        return `Edited #${id} (${changed.join(', ') || 'no change'})${checkNote}. Reopen it if it had parked so the team re-runs it.`
      },
      dedupeBoard: async () => {
        const plan = planBoardDedupe(await fetchTickets(project))
        if (!plan.length) return 'No duplicate tickets found (matched by normalized title). The board is clean.'
        let cancelled = 0
        for (const g of plan) {
          for (const id of g.cancelIds) {
            await setStatus(id, 'cancelled', `duplicate of #${g.keepId}`)
            cancelled++
          }
        }
        const lines = [...plan]
          .sort((a, b) => b.cancelIds.length - a.cancelIds.length)
          .slice(0, 12)
          .map((g) => `• "${g.title.slice(0, 52)}" — kept #${g.keepId}, cancelled ${g.cancelIds.length}`)
        return (
          `De-duplicated the board: cancelled ${cancelled} duplicate ticket(s) across ${plan.length} title(s), ` +
          `keeping the most-advanced copy of each (reversible with reopen_ticket).\n${lines.join('\n')}` +
          (plan.length > 12 ? `\n…and ${plan.length - 12} more title(s)` : '')
        )
      },
      requestImprove: async () => {
        const board = await fetchTickets(project)
        const spec = (await getSpec(project))?.content ?? project
        // Use the run's real goal (C2) so the critic judges against intent, not the spec restated as the goal.
        const goal = readRunRecord(cwd)?.goal?.trim() || spec
        const diff = await runCritic(goal, spec, board, cwd, config, { settings, emit })
        const applied = await applyReplanDiff({ ...diff, cancel: [] }, project, undefined, emit)
        return applied.added ? `Improvement pass: filed ${applied.added} ticket(s) — ${diff.note || 'see board'}.` : 'Reviewed the project — nothing worth changing right now.'
      },
      pause: async () => {
        hermesPause.pause() // hold the orchestrator cycle (C1) — survives across rounds, not just this drain
        boardRunner.pause() // halt the in-flight drain at the next ticket boundary
        return 'Paused at the next ticket boundary.'
      },
      resume: async () => {
        // A live run that's merely paused → real un-pause: release the gate the orchestrator loop is waiting on.
        if (hermesFlight.activeProject() === project) {
          hermesPause.resume()
          return 'Resumed the team.'
        }
        // No live orchestrator (it finished a pass, was stopped, or the app restarted) — relaunch on the EXISTING
        // board WITHOUT re-decomposing, picking up the unfinished tickets. This is "continue where we left off".
        const board = await fetchTickets(project)
        const unfinished = board.filter((t) => t.status !== 'done' && t.status !== 'cancelled')
        if (!unfinished.length) return 'Nothing to continue — every ticket is done or cancelled. Give me a goal and I will start a fresh run.'
        // Orphaned in_progress tickets are now reset by runHermes's startup reconciliation sweep (single-sourced
        // there so a crash WITHOUT an explicit continue is reclaimed too); we still count them for the message.
        const stranded = board.filter((t) => t.status === 'in_progress')
        const spec = (await getSpec(project))?.content ?? ''
        const goal = readRunRecord(cwd)?.goal?.trim() || spec || project
        const r = launchHermesRun(goal, config, { skipDecompose: true, spec })
        if (!r.ok) return r.error!
        return `Continuing on the existing board — ${unfinished.length} ticket(s) to do${stranded.length ? `, ${stranded.length} reset from a stalled state` : ''}.`
      },
      stop: async () => {
        hermesContinuous = false // a Stop ends "keep working" mode
        hermesAbort?.abort()
        hermesPause.resume() // clear any pause so a stopped run never strands the gate paused
        hermesFlight.clear() // free the single-flight slot immediately so a new run can start (O4)
        boardRunner.stop()
        return 'Stopped the team.'
      },
      teamStatus: async () => formatTeamStatus(await fetchTickets(project)),
      keepWorking: async (on: boolean) => {
        hermesContinuous = on
        return on
          ? 'Keep-working mode ON — I will run the team until you tell me to stop. When the board drains I convene a manager meeting with the department leads for the next improvements, otherwise the team stays on-call. Call resume_team (or give me a goal) to set it working now.'
          : 'Keep-working mode OFF — the team will stop once the current work is complete.'
      }
    }
  }

  const brookeSessions = new Map<string, AgentSession>()
  // Brooke's session/team-memory cwd is the SAME single-sourced work folder the run and board use (projectWorkFolder),
  // so her memory can never drift to a different folder than where the workers write code.
  const brookeCwd = (project: string): string => projectWorkFolder(project)
  // Team memory viewer (team-leads Phase 4): read/write a department's lead memory in the project's work folder.
  ipcMain.handle(IPC.hermesTeamMemoryGet, (_e, p: { project: string; dept: string }) => readTeamMemory(brookeCwd(p.project), normalizeRole(p.dept)))
  ipcMain.handle(IPC.hermesTeamMemorySet, (_e, p: { project: string; dept: string; content: string }) => {
    writeTeamMemory(brookeCwd(p.project), normalizeRole(p.dept), p.content)
    return { ok: true }
  })
  // Brooke is a PERSISTENT session, so over a long autonomous run her chat history accretes. loop.ts compaction
  // bounds it, but the generic conversation summary is lossy for a MANAGER — her durable state is the BOARD + team
  // memory, not chat. So when her history grows past this (below the loop's ~64k compaction trigger, so this fires
  // FIRST), we rebuild her on a tiny re-seed: the goal + "check team_status". She sheds chatter but keeps the
  // substance, which she re-derives from the board. Token estimate is chars/4 (rough, just a threshold).
  const BROOKE_RESET_TOKENS = 50_000
  const brookeHistoryTokens = (s: AgentSession): number => estimateHistoryTokens(s.getHistory())
  const buildBrookeSeed = (prev: AgentSession, cwd: string): ChatMessage[] =>
    managerResetSeed(
      readRunRecord(cwd)?.goal?.trim() || '',
      prev.getHistory().filter((m) => m.role === 'user' || m.role === 'assistant').slice(-4)
    )
  const getOrCreateBrooke = (project: string): AgentSession => {
    const key = canonicalizeProject(project) // canonical BOARD key (controller/maps/config); work folder keeps the raw name
    const cwd = brookeCwd(project)
    // Each project's Brooke is independently instanced: register THIS project's controller (keyed by the canonical
    // board key) and scope her config to it (config.hermesProject), so her tools resolve her own board — never another.
    setHermesController(key, makeController(key, cwd))
    // Brooke is a PERSISTENT session (never reset per ticket) — the headline unbounded-growth risk. Keep her in the
    // genius zone: clamp her window and lower her per-turn budget (she orchestrates with a few tool calls, she is not
    // a 50-round coding worker), so a single turn can't balloon her accumulated history toward the cliff.
    const base = configFromSettings()
    // Brooke runs on the configured REVIEWER connection/model — a SMALL, tool-capable, mostly-resident model — NOT
    // the chat top-menu (a stale pick there 400s her) and NOT the big PLANNER. The planner is huge AND is freed
    // during the drain by design (it's idle once coding starts), so a Brooke-on-planner would hit "Model unloaded"
    // the moment she acts mid-run. The reviewer is light, co-resides through the drain, and JIT-reloads fast if
    // evicted. Her memory loop is model-agnostic (it lives in a global file injected into prompts), so moving her
    // model changes nothing there. Falls back to the active connection when no reviewer is configured.
    const brookeConn = (settings.loopReviewerConnectionId ? settings.connections.find((c) => c.id === settings.loopReviewerConnectionId) : undefined) ?? activeConnection(settings)
    const brookeClient = createConnectionClient(brookeConn)
    const managerConfig = {
      ...base,
      model: settings.loopReviewerModel?.trim() || brookeConn.model,
      connectionKind: brookeConn.kind,
      connectionLabel: brookeConn.label,
      persona: 'manager' as const,
      hermesProject: key,
      maxTurns: Math.min(base.maxTurns ?? 16, 16),
      contextLimitTokens: Math.min(base.contextLimitTokens ?? 80_000, 80_000)
    }
    const existing = brookeSessions.get(key)
    if (existing) {
      existing.setConfig(managerConfig)
      // Long-run reset: only when idle (never mid-turn) AND her history has grown large — rebuild on a compact
      // re-seed (goal + "check team_status") so she stays in the genius zone over a 12h+ run.
      if (existing.isBusy() || brookeHistoryTokens(existing) < BROOKE_RESET_TOKENS) return existing
      const reset = new AgentSession({
        id: `brooke:${key}`,
        workspaceRoot: cwd,
        client: brookeClient,
        registry: buildManagerRegistry(),
        config: managerConfig,
        mode: 'auto',
        history: buildBrookeSeed(existing, cwd)
      })
      brookeSessions.set(key, reset)
      boardRunner.emit({ kind: 'notice', text: 'Brooke: long-run session reset — re-grounded on the goal + current board to stay sharp.' })
      return reset
    }
    const session = new AgentSession({
      id: `brooke:${key}`,
      workspaceRoot: cwd,
      client,
      registry: buildManagerRegistry(),
      config: managerConfig,
      mode: 'auto',
      history: []
    })
    brookeSessions.set(key, session)
    return session
  }

  const hermesEmit = (e: AgentEvent): void => {
    const wc = BrowserWindow.getAllWindows()[0]?.webContents
    if (wc && !wc.isDestroyed()) wc.send(IPC.hermesEvent, e)
  }
  ipcMain.handle(IPC.hermesMessage, (_e, p: { project: string; text: string }) => {
    const session = getOrCreateBrooke(p.project)
    if (session.isBusy()) {
      session.enqueueSteer(p.text)
      return { turnId: session.getCurrentTurnId() ?? '' }
    }
    const turnId = randomUUID()
    void session.runTurn(p.text, turnId, hermesEmit)
    return { turnId }
  })
  ipcMain.handle(IPC.hermesHistory, (_e, project: string) => {
    const s = brookeSessions.get(canonicalizeProject(project)) // sessions are keyed by the canonical board key, not the raw name
    return s ? s.getHistory().filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.content ?? '' })) : []
  })
  ipcMain.handle(IPC.hermesCancel, () => {
    for (const s of brookeSessions.values()) s.cancel()
  })

  ipcMain.handle(IPC.settingsGet, () => settings)
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<Settings>) => {
    settings = updateSettings(patch)
    rebuildClient()
    const newActive = activeConnection(settings).id
    if (newActive !== lastActiveConnId) {
      modelContextLengths = {} // different backend — drop the previous one's per-model context cache
      cappedNotified.clear() // and re-allow the cap hint for the new connection's model(s)
      lastActiveConnId = newActive
    }
    void refreshContextLengths()
    void syncMcpTools() // mcpServers may have changed — reconnect and refresh the external tool set
    for (const s of sessions.values()) {
      s.setClient(client) // a Base URL change rebuilds the client — push it to live/cached sessions
      s.setConfig(configFromSettings())
    }
    return settings
  })

  ipcMain.handle(
    IPC.lmstudioProbe,
    (_e, p?: { baseURL?: string; apiKey?: string; kind?: import('../shared/domain-types').ConnectionKind }): Promise<ProbeResult> => {
      const conn = activeConnection(settings)
      return probeConnection(p?.baseURL ?? conn.baseURL, p?.apiKey ?? conn.apiKey, p?.kind ?? conn.kind)
    }
  )
  // Full installable model list for a backend (LM Studio includes unloaded models) — for model pickers.
  ipcMain.handle(
    IPC.lmstudioModels,
    (_e, p?: { baseURL?: string; apiKey?: string; kind?: import('../shared/domain-types').ConnectionKind }): Promise<string[]> => {
      const conn = activeConnection(settings)
      return listModels(p?.baseURL ?? conn.baseURL, p?.apiKey ?? conn.apiKey, p?.kind ?? conn.kind)
    }
  )
  // Read-only capability summary for the Settings model picker (seeded registry + learned facts).
  ipcMain.handle(IPC.modelProfileDescribe, (_e, model: string): string => describeProfile(model))

  ipcMain.handle(IPC.voiceProbe, () => probeVoice(settings.voice.sidecarURL))
  ipcMain.handle(IPC.voiceTranscribe, (_e, p: { wav: ArrayBuffer }) =>
    voiceTranscribe(settings.voice.sidecarURL, p.wav)
  )
  ipcMain.handle(IPC.voiceSpeak, (_e, p: { text: string; voice?: string }) =>
    voiceSpeak(settings.voice.sidecarURL, p.text, p.voice ?? settings.voice.voice)
  )
  ipcMain.handle(IPC.voiceSetWake, (_e, enabled: boolean) => setWakeEnabled(enabled))

  ipcMain.handle(IPC.dialogPickDirectory, async (): Promise<string | null> => {
    try {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return null
      const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
    } catch {
      return null // never leave the renderer's await hanging
    }
  })

  ipcMain.handle(IPC.sessionList, () => listSessions())
  ipcMain.handle(IPC.sessionLoad, (_e, id: string) => loadSession(id))
  ipcMain.handle(IPC.sessionCreate, (_e, cwd: string) => {
    // A new chat is a clean break — kill dev servers/watchers a previous chat left running so they
    // don't linger holding ports across sessions (a main source of "localhost flooded" / stale preview).
    // Skip while a Loop/Hermes run is active: those background tasks belong to the drain, not a stale chat.
    const loopState = boardRunner.status().state
    if (loopState !== 'running' && loopState !== 'paused') bgTasks.killAll()
    return createSession(cwd, settings.mode)
  })
  ipcMain.handle(IPC.sessionRemove, (_e, id: string) => {
    turnTranscriptSaver.cancel(id)
    sessions.delete(id)
    deleteSession(id)
  })
  ipcMain.handle(IPC.sessionSearch, (_e, query: string) => searchSessions(query))
  ipcMain.handle(IPC.sessionSetComposer, (_e, p: { id: string; composer: ComposerSessionState }) => {
    saveComposerState(p.id, p.composer)
  })

  ipcMain.handle(IPC.agentStartTurn, (_e, p: { sessionId: string; userText: string; images?: string[] }) => {
    const session = getOrCreateSession(p.sessionId)
    if (!session) throw new Error('session not found')
    const persisted = loadSession(p.sessionId)
    // Re-validate the stored workspace folder still exists as a directory before running any tool against
    // it — a chat whose cwd was moved or deleted must not silently operate on whatever now sits there.
    if (persisted) {
      let dirOk = false
      try {
        dirOk = fs.statSync(persisted.cwd).isDirectory()
      } catch {
        dirOk = false
      }
      if (!dirOk) {
        const turnId = randomUUID()
        emit({
          type: 'turn-done',
          turnId,
          stopReason: 'error',
          error: `The working folder for this chat no longer exists:\n${persisted.cwd}\nChoose a folder again to continue.`
        })
        return { turnId }
      }
    }
    const userText = persisted ? inlineMentions(p.userText, persisted.cwd) : p.userText
    // If a turn is already running for this session, this message STEERS it — it's folded into the live
    // turn at the next loop iteration (Claude-Code-style interjection) instead of starting a competing
    // turn. The renderer shows the message optimistically and keeps the same running turn id.
    if (session.isBusy()) {
      session.enqueueSteer(userText, p.images)
      return { turnId: session.getCurrentTurnId() ?? '' }
    }
    const turnId = randomUUID()
    turnToSession.set(turnId, p.sessionId)

    void (async () => {
      // Pin the model to the configured context window BEFORE the first request, then refresh the cached
      // context length so this turn trims and meters against what the model actually loaded with — not a
      // value read at startup that an unload/respawn has since invalidated.
      await ensureModelForTurn(turnId)
      await refreshContextLengths()
      session.setConfig(configFromSettings())
      await session.runTurn(userText, turnId, emit, p.images, p.userText)
    })()
      .catch((err: unknown) =>
        emit({ type: 'turn-done', turnId, stopReason: 'error', error: err instanceof Error ? err.message : String(err) })
      )
      .finally(() => {
        turnToSession.delete(turnId)
        const persisted = loadSession(p.sessionId)
        if (persisted) {
          saveTranscript(p.sessionId, {
            cwd: persisted.cwd,
            mode: persisted.mode,
            messages: session.getHistory(),
            title: persisted.title,
            allowList: session.getAllowList(),
            tokenScale: session.getTokenScale()
          })
        }
        saveSnapshot(p.sessionId, turnId, session.getSnapshotForTurn(turnId))
        // First completed turn → upgrade the auto-derived title to an LLM-generated one. Runs AFTER
        // turn-done (never delays the composer) and falls back silently to the derived slice on failure.
        if (session.getHistory().filter((m) => m.role === 'user').length === 1) {
          void session
            .generateTitle()
            .then((title) => {
              const t = title.trim()
              if (!t) return
              const s = loadSession(p.sessionId)
              if (!s || s.title === t) return
              s.title = t
              saveSession(s)
              emit({ type: 'session-titled', sessionId: p.sessionId, title: t })
            })
            .catch(() => undefined)
        }
      })

    return { turnId }
  })

  ipcMain.handle(IPC.agentCancel, (_e, turnId: string) => {
    const sid = turnToSession.get(turnId)
    if (sid) sessions.get(sid)?.cancel()
  })

  ipcMain.handle(
    IPC.agentDecide,
    (_e, p: { turnId: string; callId: string; decision: ApprovalDecision; note?: string }) => {
      const sid = turnToSession.get(p.turnId)
      if (sid) sessions.get(sid)?.resolveApproval(p.callId, p.decision, p.note)
    }
  )

  // Per-chat reasoning-effort dial (composer): an explicit value overrides for THIS session; null
  // restores the connection's own setting (or the model profile's default for local backends).
  ipcMain.handle(IPC.agentSetEffort, (_e, p: { sessionId: string; effort: 'off' | 'low' | 'medium' | 'high' | null }) => {
    const session = getOrCreateSession(p.sessionId)
    if (!session) return
    const conn = activeConnection(settings)
    const fallback = conn.reasoningEffort ?? resolveConnectionDefaults(conn.model, isLocalWeakModel(conn)).reasoningEffort
    session.setReasoningEffort(p.effort ?? fallback)
  })

  ipcMain.handle(IPC.agentSetMode, (_e, p: { sessionId: string; mode: AgentMode }) => {
    const session = getOrCreateSession(p.sessionId)
    if (!session) return
    session.setMode(p.mode)
    const persisted = loadSession(p.sessionId)
    if (persisted) {
      // Persist from the LIVE session (single writer), never stale on-disk messages.
      saveTranscript(p.sessionId, {
        cwd: persisted.cwd,
        mode: p.mode,
        messages: session.getHistory(),
        title: persisted.title,
        allowList: session.getAllowList()
      })
    }
  })

  ipcMain.handle(IPC.agentClearApprovals, (_e, sessionId: string) => {
    const session = getOrCreateSession(sessionId)
    session?.clearApprovals()
    const persisted = loadSession(sessionId)
    if (session && persisted) {
      saveTranscript(sessionId, {
        cwd: persisted.cwd,
        mode: persisted.mode,
        messages: session.getHistory(),
        title: persisted.title,
        allowList: session.getAllowList()
      })
    }
  })

  ipcMain.handle(IPC.agentUndoTurn, (_e, p: { sessionId: string; turnId: string }) => {
    const persisted = loadSession(p.sessionId)
    const snap = loadSnapshot(p.sessionId, p.turnId)
    if (!persisted || !snap) return { restored: 0, total: 0, failed: 0 }
    const ws = new Workspace(persisted.cwd)
    let restored = 0
    let failed = 0
    for (const e of snap) {
      try {
        const abs = ws.resolve(e.path) // re-validate against the sandbox before touching disk
        if (e.before === null) {
          fs.rmSync(abs, { force: true })
        } else {
          fs.mkdirSync(path.dirname(abs), { recursive: true })
          fs.writeFileSync(abs, e.before, 'utf8')
        }
        restored++
      } catch {
        failed++ // file moved/locked/out-of-sandbox — count it instead of hiding the data loss
      }
    }
    // Keep the snapshot if anything failed, so the user can retry the undo rather than losing it.
    if (failed === 0) deleteSnapshot(p.sessionId, p.turnId)
    return { restored, total: snap.length, failed }
  })

  // ── W5c conversation rewind: plan (for the confirm dialog) + execute (restore files, truncate, persist). ──
  const rewindMessages = (sessionId: string): { persisted: NonNullable<ReturnType<typeof loadSession>>; live?: AgentSession; messages: ChatMessage[] } | null => {
    const persisted = loadSession(sessionId)
    if (!persisted) return null
    const live = sessions.get(sessionId)
    // The live transcript wins — it may be ahead of the last persisted write.
    return { persisted, live, messages: live ? live.getHistory() : persisted.messages }
  }

  ipcMain.handle(IPC.agentRewindPlan, (_e, p: { sessionId: string; turnId: string }): RewindPlanSummary | null => {
    const ctx = rewindMessages(p.sessionId)
    if (!ctx) return null
    const plan = planRewind(ctx.messages, p.turnId, (t) => loadSnapshot(p.sessionId, t))
    if (!plan) return null
    return {
      files: plan.restores.map((r) => ({ path: r.path, action: r.content === null ? ('delete' as const) : ('restore' as const) })),
      binarySkipped: plan.binarySkipped,
      turns: plan.turnIds.length,
      composerText: plan.composerText
    }
  })

  ipcMain.handle(IPC.agentRewindExecute, (_e, p: { sessionId: string; turnId: string }): RewindExecuteResult => {
    const ctx = rewindMessages(p.sessionId)
    if (!ctx) return { ok: false, error: 'Session not found.' }
    if (ctx.live?.isBusy()) return { ok: false, error: 'A turn is still running — stop it before rewinding.' }
    const plan = planRewind(ctx.messages, p.turnId, (t) => loadSnapshot(p.sessionId, t))
    if (!plan) return { ok: false, error: 'This message cannot be rewound (it has no turn marker).' }

    // Files first, transcript second: a failed restore is reported (and its snapshot kept) but does not
    // abort the rewind — the user asked to go back, and the transcript truncation is what they see.
    const ws = new Workspace(ctx.persisted.cwd)
    let restored = 0
    let failed = 0
    for (const r of plan.restores) {
      try {
        const abs = ws.resolve(r.path) // re-validate against the sandbox before touching disk
        if (r.content === null) {
          fs.rmSync(abs, { force: true })
        } else {
          fs.mkdirSync(path.dirname(abs), { recursive: true })
          fs.writeFileSync(abs, r.content, 'utf8')
        }
        restored++
      } catch {
        failed++
      }
    }

    const kept = ctx.messages.slice(0, plan.keepCount)
    if (ctx.live && !ctx.live.rewindHistory(plan.keepCount)) {
      return { ok: false, error: 'A turn started mid-rewind — try again.', restored, failed }
    }
    // Invalidate a trailing turn-done save captured before the transcript was truncated. Otherwise that
    // timer could restore the pre-rewind live history over the explicit rewind write below.
    turnTranscriptSaver.historyRewound(p.sessionId)
    saveTranscript(p.sessionId, {
      cwd: ctx.persisted.cwd,
      mode: ctx.persisted.mode,
      messages: kept,
      title: ctx.persisted.title,
      allowList: ctx.live ? ctx.live.getAllowList() : ctx.persisted.allowList
    })
    // Consume the rewound turns' snapshots only on a clean restore — a failure keeps them for retry.
    if (failed === 0) for (const t of plan.turnIds) deleteSnapshot(p.sessionId, t)
    return { ok: true, restored, failed, total: plan.restores.length, binarySkipped: plan.binarySkipped, composerText: plan.composerText, messages: kept }
  })

  // ── W4a self-update: compare installed vs pending build; install = detached helper + quit. ──
  const updateResultFile = (): string => path.join(app.getPath('userData'), 'self-update-result.json')
  const updateContext = (): { srcDir: string; installDir: string; installed: ReturnType<typeof statBuild>; pending: ReturnType<typeof statBuild> } => {
    const srcDir = settings.updateSourceDir?.trim() ?? ''
    const installDir = path.dirname(app.getPath('exe'))
    return {
      srcDir,
      installDir,
      installed: statBuild(path.join(installDir, 'resources', 'app.asar')),
      pending: srcDir ? statBuild(path.join(srcDir, 'resources', 'app.asar')) : null
    }
  }

  ipcMain.handle(IPC.updateStatus, (): UpdateStatus => {
    if (!app.isPackaged) return { packaged: false }
    const { srcDir, installed, pending } = updateContext()
    let lastResult: UpdateStatus['lastResult'] = null
    try {
      lastResult = parseUpdateResult(fs.readFileSync(updateResultFile(), 'utf8'))
    } catch {
      /* no prior self-update */
    }
    return {
      packaged: true,
      state: srcDir ? compareBuilds(installed, pending) : 'unconfigured',
      installedAt: installed?.mtimeMs,
      pendingAt: pending?.mtimeMs,
      lastResult
    }
  })

  ipcMain.handle(IPC.updateInstall, (): { ok: boolean; error?: string } => {
    if (!app.isPackaged) return { ok: false, error: 'Dev build — run the packaged app to self-update.' }
    const { srcDir, installDir, installed, pending } = updateContext()
    if (!srcDir) return { ok: false, error: 'Set the pending-build folder (…\\dist\\win-unpacked) in Settings first.' }
    const state = compareBuilds(installed, pending)
    if (state === 'pending-invalid') {
      return { ok: false, error: 'The pending app.asar is undersized — the package step was interrupted. Repackage, then retry.' }
    }
    if (state !== 'pending') return { ok: false, error: 'No newer build to install.' }
    launchUpdateHelper({
      pid: process.pid,
      distDir: srcDir,
      installDir,
      exeName: path.basename(app.getPath('exe')),
      resultFile: updateResultFile()
    })
    setTimeout(() => app.quit(), 400) // let the invoke reply reach the renderer before quitting
    return { ok: true }
  })

  ipcMain.handle(IPC.workspaceListFiles, (_e, p: { sessionId: string; query: string }) => {
    const persisted = loadSession(p.sessionId)
    return persisted ? listWorkspaceFiles(persisted.cwd, p.query) : []
  })

  ipcMain.handle(IPC.uiSetTitleBar, (_e, p: { color: string; symbolColor: string }) => {
    if (process.platform === 'linux') return // native frame on Linux — there's no overlay to recolor
    try {
      BrowserWindow.getAllWindows()[0]?.setTitleBarOverlay?.({ color: p.color, symbolColor: p.symbolColor })
    } catch {
      /* overlay not active on this window — ignore */
    }
  })

  ipcMain.handle(IPC.dialogPickFiles, async (_e, p?: { sessionId?: string }) => {
    try {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return []
      const persisted = p?.sessionId ? loadSession(p.sessionId) : null
      const res = await dialog.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
        defaultPath: persisted?.cwd
      })
      if (res.canceled) return []
      if (persisted) {
        const root = path.resolve(persisted.cwd)
        return res.filePaths.map((fp) => {
          const rel = path.relative(root, fp)
          return rel.startsWith('..') || path.isAbsolute(rel) ? fp : rel.replace(/\\/g, '/')
        })
      }
      return res.filePaths
    } catch {
      return [] // never leave the renderer's await hanging
    }
  })

  ipcMain.handle(IPC.workspaceReadFile, (_e, p: { sessionId: string; path: string }) => {
    const persisted = loadSession(p.sessionId)
    if (!persisted) return null
    try {
      // Route through the workspace sandbox (symlink/junction + traversal defense).
      const abs = new Workspace(persisted.cwd).resolve(p.path)
      return fs.readFileSync(abs, 'utf8')
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.workspaceSavePlan, (_e, p: { sessionId: string; content: string; title?: string }) => {
    const persisted = loadSession(p.sessionId)
    if (!persisted) return null
    try {
      const safe = (p.title || 'plan').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'plan'
      // Resolve through the sandbox so a symlinked `plans` dir can't write outside the workspace.
      const file = new Workspace(persisted.cwd).resolve(`plans/${safe}-${fileStamp()}.md`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, p.content, 'utf8')
      return path.relative(persisted.cwd, file).replace(/\\/g, '/')
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.workspaceListPlans, (_e, p: { sessionId: string }) => {
    const persisted = loadSession(p.sessionId)
    if (!persisted) return []
    try {
      const dir = new Workspace(persisted.cwd).resolve('plans')
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .map((name) => {
          const full = path.join(dir, name)
          return {
            name,
            path: path.relative(persisted.cwd, full).replace(/\\/g, '/'),
            updatedAt: fs.statSync(full).mtimeMs
          }
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)
    } catch {
      return []
    }
  })

  ipcMain.handle(IPC.bgtaskList, () => bgTasks.list())
  ipcMain.handle(IPC.bgtaskStop, (_e, id: string) => bgTasks.stop(id))
  ipcMain.handle(IPC.bgtaskOutput, (_e, id: string) => bgTasks.output(id))

  // Preview <webview> bridge (one-way renderer → main; main drives the guest via previewService).
  ipcMain.on(IPC.previewRegister, (_e, p: PreviewRegister) => previewService.onRegister(p))
  ipcMain.on(IPC.previewClosed, (_e, webContentsId: number) => previewService.onClosed(webContentsId))

  ipcMain.handle(IPC.gitStatus, async (_e, sessionId: string) => {
    const persisted = loadSession(sessionId)
    if (!persisted) return { isRepo: false, branch: '', files: [] }
    const cwd = persisted.cwd
    const branchRes = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (branchRes.code !== 0) return { isRepo: false, branch: '', files: [] }
    // Both use -z so renames and non-ASCII/spaced paths parse correctly (the default LF format C-quotes
    // such paths and renders renames as `old -> new`, which the old slice/lookup mis-parsed). See git-util.
    const statusRes = await runGit(cwd, ['status', '--porcelain=v1', '-z'])
    const numstatRes = await runGit(cwd, ['diff', '--numstat', '-z', 'HEAD'])
    const files = buildGitFiles(statusRes.stdout, numstatRes.stdout)
    return { isRepo: true, branch: branchRes.stdout.trim(), files }
  })

  ipcMain.handle(IPC.gitDiff, async (_e, p: { sessionId: string; path: string }) => {
    const persisted = loadSession(p.sessionId)
    if (!persisted) return ''
    const res = await runGit(persisted.cwd, ['diff', 'HEAD', '--', p.path])
    if (res.stdout.trim()) return res.stdout
    // Untracked / new file: synthesize an additions-only diff from its content.
    try {
      const abs = new Workspace(persisted.cwd).resolve(p.path)
      const content = fs.readFileSync(abs, 'utf8')
      return `--- /dev/null\n+++ ${p.path}\n${content
        .split('\n')
        .map((l) => `+${l}`)
        .join('\n')}`
    } catch {
      return res.stdout || '(no diff)'
    }
  })

  ipcMain.handle(IPC.gitCommit, async (_e, p: { sessionId: string; message: string }) => {
    const persisted = loadSession(p.sessionId)
    if (!persisted) return { ok: false, error: 'no session' }
    if (!p.message.trim()) return { ok: false, error: 'empty message' }
    const add = await runGit(persisted.cwd, ['add', '-A'])
    if (add.code !== 0) return { ok: false, error: add.stderr.trim() || 'git add failed' }
    const commit = await runGit(persisted.cwd, ['commit', '-m', p.message])
    if (commit.code !== 0) return { ok: false, error: (commit.stderr || commit.stdout).trim() || 'git commit failed' }
    return { ok: true }
  })
}

/** Resolve @path mentions to actual file contents and inline them so the model can read them. */
function inlineMentions(userText: string, cwd: string): string {
  const matches = userText.match(/(?:^|\s)@([\w./-]+)/g) || []
  const rels = [...new Set(matches.map((s) => s.trim().replace(/^@/, '')))]
  if (!rels.length) return userText
  const ws = new Workspace(cwd)
  const blocks: string[] = []
  for (const rel of rels) {
    try {
      const abs = ws.resolve(rel)
      if (!fs.statSync(abs).isFile()) continue
      let content = fs.readFileSync(abs, 'utf8')
      const MAX = 16000
      if (content.length > MAX) content = `${content.slice(0, MAX)}\n… [truncated]`
      blocks.push(`File \`${rel}\`:\n\`\`\`\n${content}\n\`\`\``)
    } catch {
      /* unresolved / binary / missing — skip */
    }
  }
  return blocks.length
    ? `${userText}\n\n--- Attached files (resolved from @mentions) ---\n\n${blocks.join('\n\n')}`
    : userText
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.next', '.cache'])

/** Find workspace files matching a fuzzy query, ranked by basename match then path length. */
function listWorkspaceFiles(root: string, query: string, max = 12): string[] {
  const q = query.toLowerCase()
  const ws = new Workspace(root)
  const candidates: string[] = []
  const stack: string[] = [root]
  let scanned = 0
  while (stack.length && candidates.length < 2000 && scanned < 50000) {
    const dir = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      scanned++
      const full = path.join(dir, e.name)
      // Re-validate through the sandbox so a symlinked dir can't surface out-of-root paths as @mentions.
      try {
        ws.resolve(full)
      } catch {
        continue
      }
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full)
        continue
      }
      const rel = path.relative(root, full).replace(/\\/g, '/')
      if (!q || rel.toLowerCase().includes(q)) candidates.push(rel)
    }
  }
  if (!q) return candidates.slice(0, max)
  const score = (rel: string): number => {
    const base = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase()
    if (base.startsWith(q)) return 0
    if (base.includes(q)) return 1
    return 2
  }
  return candidates.sort((a, b) => score(a) - score(b) || a.length - b.length).slice(0, max)
}
