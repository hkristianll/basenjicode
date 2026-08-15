// Hermes orchestrator — the model-bound half of "give it a big goal and it runs": run a DECOMPOSE turn that
// breaks a goal into ~one-session tickets (each with a check command + acceptance criteria), then write them
// to the board in dependency order. The pure parse/validate/ordering logic lives in specPlan.ts (unit-tested
// headless); the replan loop and drain hand-off build on top of this in later steps.
import { z } from 'zod'
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createConnectionClient } from './lmstudio'
import { ensureModelLoaded } from '../lmstudio/loadModel'
import { freeOtherRoleModels } from './modelSwap'
import { readManagerMemory, appendManagerMemory } from './managerMemory'
import { dedupeKey } from './boardDedupe'
import { setSpec as boardSetSpec, addTicket as boardAddTicket, setStatus as boardSetStatus, fetchTickets, type NewTicket } from '../loopBoard'
import { parsePlan, orderForCreate, parseReplan, allSettled, normalizeRole, departmentOf, extractJsonObject, MAX_DECOMPOSE_TICKETS, type Department, type DecomposePlan, type PlanTicket, type ReplanDiff, type ReplanAdd } from './specPlan'
import { readTeamMemory, writeTeamMemory, extractMemoryBlock } from './teamMemory'
import { detectContestedConcepts, createParkTracker, type Concept } from './thrashGuard'
import { applyGroomSplits, parseGroomSplits } from './groom'
import { validateCheck, rewriteCheck } from './checkLint'
import { findUnwiredModules, type SourceFile } from './unwiredModules'
import type { LoopConfig, LoopEvent, BoardTicketRow } from '../../shared/ipc-types'
import type { Settings, ChatMessage, Connection } from '../../shared/domain-types'

/** PHASE 1 — the OUTLINE contract. The plan is generated in two pieces so a weak local model never has to emit the
 *  whole thing at once: here it produces ONLY the spec + a compact ticket SKELETON (title/role/deps, no bodies, no
 *  checks). The per-ticket body + check are written in a separate DETAIL pass (DETAIL_SYSTEM). Keeping this output
 *  small is what makes decomposition reliable — a full-plan emission is what was failing → falling back. */
const DECOMPOSE_SYSTEM = [
  'You are a planning engine that breaks a software goal into a dependency-linked OUTLINE of tickets for an',
  'autonomous coding loop to execute one at a time. Each ticket\'s detailed body + check are written in a SEPARATE',
  'later step — here you produce ONLY the spec and the ticket skeleton, so keep the output compact.',
  '',
  'Output RULES — obey exactly:',
  '- Respond with ONE JSON object and NOTHING else. No prose, no markdown fences.',
  '- Shape: {"spec": string, "tickets": [{"title": string, "role": string, "deps": number[], "priority": number, "files": string[]}]}',
  '  Do NOT include "body" or "check" — those are filled in the detail step. Just title, role, deps, priority, files.',
  '- "spec" is a SHARED project brief in markdown that EVERY ticket worker reads — the one place a worker gets its',
  '  bearings. Include, tightly: the goal + scope; the stack and KEY CONVENTIONS (language, framework, style, and the',
  '  intended file/module layout); how to RUN and TEST the project (the actual commands); and the overall acceptance.',
  '  If the goal asks for a certain LOOK ("beautiful", "polished", "a clone of <X>", a game or rich UI), encode the',
  '  CONCRETE visual target here — the hallmarks to hit (for a game: the camera/projection e.g. isometric; REAL',
  '  sprite/tile ART, never colored rectangles or primitive shapes as the final look; animated units; a cohesive',
  '  palette; depth/shadow; styled UI). NEVER silently downgrade the ambition to a functional placeholder.',
  '- "role" assigns each ticket to a team — one of: architecture, implementation, design, testing, review, docs.',
  '  architecture = scaffolding/contracts; design = UI/UX, visual & ART work; testing = test tickets; docs = docs;',
  '  review = audits work and routes fixes (it never edits code).',
  '- ONE concern per ticket, SIZED BY FILE — ideally each ticket OWNS one file. SPLIT finely WHEN it yields DISJOINT',
  '  files: paddle, ball, brick, score-UI, lives-UI = five tickets, five files (a wide layer that runs in PARALLEL).',
  '  But do NOT split behaviors that all edit the SAME file into separate tickets — they would fight over one file and',
  '  cannot parallelize. Make them ONE ticket, OR factor the shared logic into its OWN module (a new file) so each is',
  '  disjoint. E.g. ball-paddle + ball-wall + ball-brick collisions that all live in the game scene = ONE "collisions"',
  '  ticket (or a CollisionSystem file), NOT three fighting over the scene. "score AND lives UI" → two (two files).',
  '  NEVER a project-wide SWEEP ("expand the test suite", "build the entire frontend") as one ticket.',
  '- DECLARE FILES: list each ticket\'s owned file path(s) in "files" (what it creates or edits). The executor batches',
  '  tickets with DISJOINT "files" to run CONCURRENTLY and serializes ones that share a file — so accurate "files" =',
  '  more parallelism. A ticket that edits a SHARED file (the main scene, the app entry, a central config) declares it',
  '  and runs alone; a ticket that creates its OWN module declares that file and runs alongside its siblings. Prefer a',
  '  layout that MAXIMIZES disjoint-file tickets (give a piece its own module rather than piling into one big file).',
  '- TESTING tickets are scoped to ONE behavior/scenario group with NAMED cases — e.g. "pathfinding tests: shortest',
  '  path, obstacle avoidance, unreachable→null", NOT one catch-all "unit tests for pathfinding". IMPLEMENTATION work',
  '  is paired with a focused test (added in the detail step).',
  '- For a VISUAL goal, emit explicit DESIGN tickets for the LOOK: real art/asset generation, the rendering approach',
  '  (e.g. an isometric renderer), unit/building animation, and a final visual-polish pass. Add a DESIGN-REVIEW ticket',
  '  (role: review) that VIEWS the running app and judges it against the spec\'s visual target, routing look-gaps back;',
  '  depend it on the main visual + feature tickets.',
  '- ASSEMBLE THE WHOLE — the plan MUST include an explicit INTEGRATION / wire-up ticket: the top-level entry (main /',
  '  the primary scene / the app root) instantiates and USES every major module you create, and assets are loaded by a',
  '  real preload/load step. NO module may be built and left unreferenced — a built-but-unwired module renders nothing,',
  '  the #1 cause of a "done" board that does nothing. AND include at least one HEADLESS INTEGRATION-TEST ticket that',
  '  boots the ASSEMBLED app in-process (e.g. Phaser HEADLESS) and asserts it actually does something — the display',
  '  list is populated, textures/assets loaded, the entry uses each module — gated on `npm test`. Every "build module',
  '  X" ticket needs a downstream wire-up + integration test; depend the integration ticket on the modules it assembles.',
  '- "deps" are 0-based indices into THIS tickets array — real prerequisites ONLY (over-linking serializes parallel',
  '  work). A ticket that READS/TESTS/VALIDATES/EXTENDS a component MUST list the ticket that CREATES it. The first',
  '  ticket is usually a scaffold with no deps; leave deps empty ONLY for true roots (scaffold, shared types, README).',
  '- "priority": lower runs earlier among ready tickets (default 100).',
  '- Prefer the FINER decomposition: many small single-purpose tickets beat a few big ones — each small enough that ONE',
  '  worker fully nails it in one session. A non-trivial app (a game, a real UI) typically lands ~15-40 tickets; do NOT',
  `  collapse distinct behaviors to keep the count low. Cap: AT MOST ${MAX_DECOMPOSE_TICKETS} tickets — stay under it, but lean toward the finer split.`,
  '- No cycles. A ticket cannot depend on itself or on a later ticket that depends back on it.'
].join('\n')

/** PHASE 2 — the DETAIL contract. Fills the body + check for a SMALL BATCH of outline tickets at a time, so the heavy
 *  per-ticket content is generated in pieces. This is where the quality bar lives (concrete criteria + behavioral
 *  checks + self-verify), applied to one focused batch the weak model can handle. */
const DETAIL_SYSTEM = [
  'You write the BODY and CHECK for specific tickets in an existing plan. You are given the shared project spec and a',
  'BATCH of tickets (each with its index, title, and role). Return ONE JSON object and NOTHING else:',
  '  {"tickets": [{"index": number, "body": string, "check": string}]}',
  'covering EXACTLY the indices given (reuse the same index numbers). No prose, no fences.',
  '- "body": restate what to build and which files/areas, then list CONCRETE, ENUMERATED acceptance criteria — name the',
  '  specific behaviors and edge cases that must hold (e.g. "returns the shortest path between two walkable tiles",',
  '  "returns null when the target is unreachable", "never routes through water"). BANNED: vague criteria like "works',
  '  correctly", "handles edge cases", "is well tested". Stay in THIS ticket\'s slice; when a boundary is fuzzy, state',
  '  what is OUT of scope (owned by another ticket).',
  '- "check": a command that passes (exit 0) ONLY when the ticket genuinely WORKS. It RUNS IN POWERSHELL ON WINDOWS —',
  '  never bash (`test -f`, `grep`, `/dev/null`, `&&`, `||`). For an IMPLEMENTATION ticket the check MUST FAIL on a stub.',
  '  DEFAULT to `npx tsc --noEmit` — it typechecks (catches missing/mis-typed logic) WITHOUT running the code. This',
  '  matters: BROWSER / GAME-ENGINE code (Phaser, canvas, WebGL, DOM) CANNOT be imported in a node test runner — e.g.',
  '  Phaser pulls in `phaser3spectorjs` / WebGL at module load and crashes vitest before any test runs, so a',
  '  `npx vitest run X.spec.ts` check on an entity is UNWINNABLE. Use a focused runtime test (`npx vitest run …`) ONLY',
  '  when the file is genuinely NODE-RUNNABLE: pure logic / utilities with NO browser-engine import. RUNTIME behavior',
  '  of engine code is verified on the INTEGRATION ticket (the headless smoke test that boots the assembled app where',
  '  a real canvas exists) — never per-entity in node. NEVER a pure existence check (`Test-Path`) for impl — it passes',
  '  on an empty stub. Use `Test-Path`/`Select-String` ONLY for scaffold/config/docs. A REVIEW ticket gets check ""',
  '  (empty). To combine conditions wrap each in parentheses: `(Test-Path a) -and (Test-Path b)`.',
  '- Match the role: IMPLEMENTATION builds the code AND adds a focused test it gates on (self-verify, never stub to go',
  '  green); DESIGN builds the real look to the spec\'s visual bar (REAL art, not colored-rectangle placeholders) and',
  '  views the result; TESTING writes the named-case tests; REVIEW audits + routes fixes (no check); DOCS writes docs.',
  '- An INTEGRATION / wire-up ticket: the body must say to make the top-level entry instantiate + USE every module it',
  '  assembles (and load assets via a real preload), and its check must be the HEADLESS INTEGRATION TEST (`npm test`)',
  '  that boots the assembled app and asserts it actually does something (display list non-empty / entry uses each module).',
  '- The SCAFFOLD ticket must INSTALL dependencies (run `npm install` after writing package.json) so every downstream',
  '  ticket\'s check can resolve imports — a project whose deps were never installed fails every typecheck/test after it.'
].join('\n')

/** A detail batch's parsed shape — per-ticket body + check keyed by the outline index. */
const detailBatchSchema = z.object({
  tickets: z.array(z.object({ index: z.number().int(), body: z.string().default(''), check: z.string().optional() })).default([])
})
const DETAIL_BATCH_SIZE = 6
/** Per-batch detail watchdog — a hung detail call must not stall the whole decompose (board is written only after
 *  all batches). On timeout the batch falls back to defaults. Generous, since a slow local model can take a while. */
const DETAIL_TIMEOUT_MS = 120_000

/** Per-department steering prepended to a ticket body, so the per-ticket worker acts in its team's role
 *  (an "implementation" worker writes code; a "testing" worker writes tests; etc.). Light but effective on
 *  a weak local model — it shapes the one-ticket session without a separate system-prompt mechanism. */
const ROLE_GUIDANCE: Record<Department, string> = {
  architecture:
    'You are the ARCHITECTURE team. Scaffold ONLY the structure, interfaces, and contracts later tickets build on — directory layout, type/interface stubs, module boundaries, config. Favor clear, minimal foundations. Do NOT implement feature logic or write tests; those are other teams\' tickets. Leave the bodies for the implementation team to fill in.',
  implementation:
    'You are the IMPLEMENTATION team. Implement what THIS ticket\'s acceptance criteria require, then PROVE it: add or extend a FOCUSED automated test that exercises those criteria, and make the check pass for real — never stub the code (or the test) just to go green. Make the smallest change that GENUINELY satisfies the criteria; do NOT build features owned by other tickets, refactor unrelated code, add speculative abstractions, or gold-plate. If you spot adjacent work, leave it for its own ticket.',
  design:
    'You are the UI/UX (DESIGN) team. Build the user-facing surface for THIS ticket to the QUALITY BAR set in the spec — not a placeholder. Use REAL art/sprites/tiles (never leave colored rectangles or primitive stub shapes as the FINAL look) and match the intended visual target: projection (e.g. isometric), palette, animation, depth/shadow, and polish. Reuse the project\'s design language/components. After building, VIEW the result (run the app, screenshot the preview) and iterate until it actually looks right. Keep to the UI slice this ticket names; do NOT change unrelated backend logic.',
  testing:
    'You are the TESTING team. Write or extend tests that verify THIS ticket\'s behavior (the check runs them); cover the real edge cases. Do NOT change the code under test or add product features — if a test reveals a bug, report it for the implementation team rather than fixing it yourself.',
  review:
    'You are the REVIEW team. Audit the work THIS ticket names against the spec, but do NOT edit any files. For a VISUAL target, VIEW the running app (screenshot the preview) and judge whether it actually MATCHES the intended look — projection, real art vs placeholder shapes, animation, palette, polish — not merely whether it runs. For each real problem (a correctness bug OR a visual shortfall vs the target), call file_finding(title, body, check) to route a fix to the right team. You review and route — you never fix code yourself. If it is sound, say so.',
  docs:
    'You are the DOCS team. Write or update ONLY the documentation THIS ticket covers (README, usage, key comments) so it matches the code. Do NOT change code behavior or implement features.'
}

/** Prepend a department banner + role guidance to a ticket body. Visible on the board/graph and in the
 *  worker's seed, so each ticket is owned by a specialized team. Exported so Brooke's add_work files tickets
 *  the same way the engine does. */
export function withRoleBanner(role: Department, body: string, files?: string[]): string {
  // A "**Files:**" banner (parsed by filesOf) declares the file(s) this ticket owns, so the parallel executor can
  // batch only file-DISJOINT tickets. Omitted when the planner didn't declare any.
  const filesLine = files && files.length ? `\n**Files:** ${files.join(', ')}` : ''
  return `**Department: ${role}** — ${ROLE_GUIDANCE[role]}${filesLine}\n\n${body || '(no description)'}`
}

function buildDecomposeUser(goal: string, correction?: string): string {
  const base = `# Goal\n\n${goal.trim()}\n\nDecompose this into the JSON board described in the system prompt.`
  return correction ? `${base}\n\nYour previous output was rejected: ${correction}\nReturn corrected JSON only.` : base
}

export interface OrchestratorDeps {
  settings: Settings
  emit?: (e: LoopEvent) => void
  /** Test seam: the raw completion that drives decompose/replan/critic. Defaults to the live LM Studio call
   *  (`liveComplete`) — injected by tests so `runHermes` exercises headless, no model needed. */
  complete?: (messages: ChatMessage[], signal?: AbortSignal) => Promise<string>
  /** Test seam: board writes for writePlanToBoard/applyReplanDiff. Defaults to liveBoardIO. */
  io?: BoardWriteIO
  /** Test seam: the integration gate's verdict on the assembled app. Defaults to a STATIC liveIntegrationCheck
   *  (no runtime) — injected by tests so the termination logic exercises headless. */
  integrationCheck?: (cwd: string, board: BoardTicketRow[]) => IntegrationCheckResult
}

/** Static verdict on whether the ASSEMBLED app is verified — no unwired modules AND an integration test exists.
 *  `ok` when verified OR when not assessable (no source / non-code project, so we never falsely block). */
export interface IntegrationCheckResult {
  ok: boolean
  orphans: string[]
  hasIntegrationTest: boolean
  detail: string
}

/** Dispatch the planning completion through the test seam when present, else the live LM Studio call. */
function complete(config: LoopConfig, deps: OrchestratorDeps, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  return deps.complete ? deps.complete(messages, signal) : liveComplete(config, deps, messages, signal)
}

/**
 * Resolve the connection + model for a planning turn (decompose / replan / critic) — the highest-leverage
 * reasoning steps (Q1). Prefers the configured "planner" connection (settings.hermesPlannerConnectionId +
 * hermesPlannerModel); falls back to the per-ticket WORKER connection (config.connectionId + workerModel) when
 * no planner is set, preserving the prior behaviour. Pure → unit-tested. `conn` is undefined only when the
 * settings have no connections at all (caller throws).
 */
// The genius zone — mirrors boardInner's GENIUS_ZONE_CTX. The worker/reviewer are clamped to it; the PLANNER load
// was not, so a connection set to e.g. 200k loaded agentworld at ~50GB (model + KV) — which reloads on every pin AND
// momentarily co-resides with the worker during the swap handoff, overcommitting VRAM. Cap the planner here too.
const PLANNER_CTX_CAP = 80_000

/** Append Brooke's accumulated cross-project CRAFT (managerMemory) to a planning system prompt, so the PLAN itself
 *  benefits from what she has learned (e.g. "a scaffold check must not bundle Test-Path + npm install", "give each
 *  entity its own file") — not only her after-the-fact interventions. This is the half of the learning loop that makes
 *  the DECOMPOSE better each run; empty memory leaves the prompt unchanged. */
export function craftSystem(base: string): string {
  const craft = readManagerMemory().trim()
  return craft
    ? `${base}\n\n# Your accumulated CRAFT from past projects — APPLY it as you plan (it is why this plan should avoid the mistakes earlier plans made)\n${craft}`
    : base
}

export function resolvePlanner(settings: Settings, config: LoopConfig): { conn: Connection | undefined; model: string } {
  const plannerConn = settings.hermesPlannerConnectionId ? settings.connections.find((c) => c.id === settings.hermesPlannerConnectionId) : undefined
  const conn = plannerConn ?? settings.connections.find((c) => c.id === config.connectionId) ?? settings.connections[0]
  const model = plannerConn ? settings.hermesPlannerModel?.trim() || plannerConn.model : config.workerModel?.trim() || conn?.model || ''
  return { conn, model }
}

/** One-shot completion for a planning turn that returns raw text (no tools, no agent loop) — the same shape
 *  boardInner.runReview uses. Runs on the planner connection (Q1), or the worker when none is set. */
async function liveComplete(config: LoopConfig, deps: OrchestratorDeps, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const { conn, model } = resolvePlanner(deps.settings, config)
  if (!conn) throw new Error('no connection configured for the orchestrator')
  // VRAM swap: free the worker/reviewer model before the (bigger) planner loads, so a planning turn doesn't sit
  // resident alongside the worker. Best-effort; cheap no-op when those models aren't loaded. (Pairs with the
  // drain-side free that drops the planner before workers start — see ipc.ts runDrainOnce.)
  await freeOtherRoleModels(deps.settings, config, model, (text) => deps.emit?.({ kind: 'notice', text }))
  // Clamp the planner to the genius zone — a 200k connection setting otherwise loads agentworld at ~50GB, which
  // reloads on every pin and overcommits VRAM when it overlaps the worker during the swap. 80k is ample for decompose.
  const minCtx = Math.min(conn.contextLimitTokens ?? deps.settings.contextLimitTokens ?? PLANNER_CTX_CAP, PLANNER_CTX_CAP)
  if (conn.kind === 'lmstudio' && typeof minCtx === 'number' && minCtx > 0) {
    await ensureModelLoaded(conn.baseURL, model, minCtx)
  }
  const stream = await createConnectionClient(conn).chatStream({
    model,
    messages,
    tools: [],
    temperature: conn.temperature ?? deps.settings.temperature,
    maxTokens: conn.maxTokens ?? deps.settings.maxTokens,
    signal: signal ?? new AbortController().signal
  })
  let text = ''
  for await (const chunk of stream) {
    const d = chunk.choices?.[0]?.delta?.content
    if (d) text += d
  }
  return text
}

/** Retry budgets (Q2): ask the model for valid JSON a few times (a weak local model often self-corrects when
 *  told exactly what was wrong), then DEGRADE rather than throw — decompose falls back to a single-ticket plan,
 *  a replan/critic skips the round. Note: only PARSE failures retry/degrade; a network error from complete()
 *  is outside the try and still propagates, so an infrastructure outage surfaces instead of being masked. */
const DECOMPOSE_ATTEMPTS = 4
/** A decompose attempt that hasn't returned in this long is hung (the LLM client's own timeout is ~10 min) — abort it
 *  and retry, so a brand-new project never stalls on an empty board waiting on a wedged model call. */
const DECOMPOSE_TIMEOUT_MS = 120_000
/** Grooming + the planning meeting are best-effort pre-write refinements; if they hang, fall back to the decomposed
 *  plan and write the board rather than stalling on an empty one. */
const PLANNING_MEETING_TIMEOUT_MS = 240_000

/** Reject if `p` doesn't settle within `ms` — bounds a best-effort step so a hung model call can't stall the run. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}
const DIFF_ATTEMPTS = 3
/** A ticket body this long is an over-scoped dumping ground for one worker session (the body alone eats the
 *  worker's room before any file is read). Generous — well above a focused ticket's body, below the 8k boardSeed
 *  cap — so it only trips egregious cases. On trip, decompose reject-and-repairs ("split it"). */
const OVERSCOPE_BODY_CHARS = 5_000

// A check that only proves files EXIST (Test-Path / Select-String, no runner) is satisfied by an empty stub, so a
// ticket's behavioral acceptance is never enforced — the #1 quality leak. Existence checks are legitimate for
// scaffold/config/docs tickets (nothing to execute), so runDecompose only rejects this for implementation/testing.
const CHECK_HAS_RUNNER = /\b(npm|npx|pnpm|yarn|node|deno|bun|pytest|python|py|cargo|go|dotnet|dart|flutter|mvn|gradle|jest|vitest|mocha|tsc|tsx|rspec|phpunit|ctest|make|bash|pwsh)\b/i
const CHECK_IS_EXISTENCE = /\b(Test-Path|Select-String|Get-Content|Get-Item|Get-ChildItem)\b/i
// A TESTING ticket's check must actually RUN tests — `npx tsc --noEmit` only typechecks, so a test ticket gating on
// it never exercises the test it adds (the live planner-validation run gave the headless integration-test ticket
// exactly this). These are the runners that count as actually running tests.
const CHECK_RUNS_TESTS = /\b(npm (run )?test|pnpm (run )?test|yarn test|pytest|vitest|jest|mocha|go test|cargo test|dotnet test|rspec|phpunit|ctest|gradle test|mvn test|npm run test|tsx .*test|node .*test)\b/i
function isExistenceOnlyCheck(check: string | undefined | null): boolean {
  const c = (check ?? '').trim()
  if (!c) return false // empty check → routed to review elsewhere, not our concern here
  return CHECK_IS_EXISTENCE.test(c) && !CHECK_HAS_RUNNER.test(c)
}

// A plan that builds several modules but never ASSEMBLES them (no top-level entry instantiating them, no integration
// test booting the whole) is the #1 cause of a "done" board that does nothing (built-but-orphaned modules → blank
// app). We require an explicit integration/wire-up (or end-to-end/smoke) ticket once the plan has multiple module
// builders. Heuristic on titles/bodies — fires only on egregious cases (several builders + zero integration ticket).
const INTEGRATION_TICKET = /\b(integrat|wire[\s-]?up|wires?\b|wiring|assemble|assembl|compose the|bootstrap|end[\s-]?to[\s-]?end|\be2e\b|smoke[\s-]?test|hook[\s-]?up|main (scene|app|entry|loop)|entry[\s-]?point|tie[\s-]?together|brings? .* together)\b/i
function planHasIntegrationTicket(tickets: PlanTicket[]): boolean {
  return tickets.some((t) => INTEGRATION_TICKET.test(t.title) || INTEGRATION_TICKET.test(t.body ?? ''))
}
const MIN_MODULES_FOR_INTEGRATION = 3
function moduleBuildingCount(tickets: PlanTicket[]): number {
  return tickets.filter((t) => normalizeRole(t.role) === 'implementation').length
}

/** A last-resort plan when decomposition keeps failing: the whole goal as ONE ticket with no check → routed to
 *  human review. Lets the run proceed (Brooke/replan can split it) instead of dying on malformed JSON. */
function fallbackPlan(goal: string): DecomposePlan {
  const g = goal.trim()
  return {
    spec: g,
    tickets: [
      {
        title: (g.slice(0, 80) || 'Implement the goal').replace(/\s+/g, ' ').trim(),
        body: `${g}\n\n(Automatic decomposition failed — this is the entire goal as a single ticket. Split it into smaller tickets as needed.)`,
        role: 'implementation',
        deps: [],
        priority: 100
      }
    ]
  }
}

/** Run the decompose turn, parsing its JSON plan. Retries up to DECOMPOSE_ATTEMPTS with the validation error
 *  fed back (a weak model often self-corrects), then falls back to a single-ticket plan rather than throwing. */
export async function runDecompose(goal: string, config: LoopConfig, deps: OrchestratorDeps, signal?: AbortSignal): Promise<DecomposePlan> {
  let correction: string | undefined
  let lastErr = ''
  let outline: DecomposePlan | null = null
  deps.emit?.({ kind: 'notice', text: 'Planning: outlining the board…' }) // progress for the empty-board indicator
  for (let attempt = 0; attempt < DECOMPOSE_ATTEMPTS; attempt++) {
    // Watchdog: a hung decompose call would otherwise block the WHOLE run behind the client's ~10-min timeout, stranding
    // a new project on an empty board. Abort an attempt that hasn't returned in DECOMPOSE_TIMEOUT_MS and retry. The run's
    // own signal still aborts immediately — and a run-stop is rethrown (not retried). The model call is INSIDE the try so
    // a transient network/timeout error is retried (reject-and-repair) instead of killing the run.
    const ac = new AbortController()
    const onAbort = (): void => ac.abort()
    if (signal?.aborted) ac.abort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => ac.abort(), DECOMPOSE_TIMEOUT_MS)
    try {
      const text = await complete(
        config,
        deps,
        [
          { role: 'system', content: craftSystem(DECOMPOSE_SYSTEM) },
          { role: 'user', content: buildDecomposeUser(goal, correction) }
        ],
        ac.signal
      )
      const plan = parsePlan(text)
      orderForCreate(plan.tickets) // validate the dep graph up front so writePlanToBoard can't wedge
      // Validate the model-authored checks BEFORE storing them — a bash/invalid-PS check parks its ticket
      // forever (mode 2). On reject, feed the reason back through the existing repair loop (reject-and-repair).
      const badCheck = plan.tickets.map((t, i) => ({ i, lint: validateCheck(t.check) })).find((x) => !x.lint.ok)
      if (badCheck) throw new Error(`ticket ${badCheck.i} has an invalid check — ${badCheck.lint.reason}`)
      // Context-sizing (reject-and-repair): an egregiously long body means the slice is too broad for one worker
      // session — split it BEFORE it parks the run, rather than truncating it later (boardSeed's hard cap).
      const overScoped = plan.tickets.map((t, i) => ({ i, len: (t.body ?? '').length })).find((x) => x.len > OVERSCOPE_BODY_CHARS)
      if (overScoped) throw new Error(`ticket ${overScoped.i} is over-scoped for one worker session (body ${overScoped.len} chars, max ${OVERSCOPE_BODY_CHARS}) — split it into smaller vertical slices`)
      // Quality gate: an implementation/testing ticket whose check only proves files EXIST passes on a stub, so its
      // behavioral acceptance is never enforced. Reject → repair toward a behavioral check (tsc/test). Scaffold/
      // config/docs tickets may keep an existence check.
      const weakCheck = plan.tickets
        .map((t, i) => ({ i, t }))
        .find(({ t }) => {
          const r = normalizeRole(t.role)
          return (r === 'implementation' || r === 'testing') && isExistenceOnlyCheck(t.check)
        })
      if (weakCheck)
        throw new Error(
          `ticket ${weakCheck.i} ("${weakCheck.t.title}") has an existence-only check (\`${(weakCheck.t.check ?? '').trim()}\`) — it passes on a stub and never verifies behavior. Use a BEHAVIORAL check that fails on broken/missing logic: \`npx tsc --noEmit\` at minimum, ideally \`npm test\` running a focused test this ticket adds.`
        )
      // Integration gate (reject-and-repair): a plan that builds several modules but has NO integration/wire-up ticket
      // ships built-but-orphaned modules that nothing assembles → a "done" board that renders/does nothing.
      if (moduleBuildingCount(plan.tickets) >= MIN_MODULES_FOR_INTEGRATION && !planHasIntegrationTicket(plan.tickets))
        throw new Error(
          `the plan builds ${moduleBuildingCount(plan.tickets)} modules but has NO integration/wire-up ticket — add ONE ticket that ASSEMBLES the modules into the running entry (the top-level main/scene/app instantiates + USES each module; assets loaded by a real preload/load), PLUS a headless integration test that boots the assembled app and asserts it actually renders/runs (the display list is non-empty / the entry uses each module). Modules built but never wired in are the #1 cause of a "done" board that does nothing.`
        )
      outline = plan
      break // got a valid OUTLINE — leave the retry loop; the detail pass runs below
    } catch (e) {
      if (signal?.aborted) throw e instanceof Error ? e : new Error(String(e)) // the RUN was stopped — abort, don't retry
      lastErr = ac.signal.aborted ? `timed out after ${Math.round(DECOMPOSE_TIMEOUT_MS / 1000)}s` : e instanceof Error ? e.message : String(e)
      correction = lastErr
      deps.emit?.({ kind: 'notice', text: `decompose attempt ${attempt + 1}/${DECOMPOSE_ATTEMPTS} rejected: ${lastErr}` })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
  // A weak local model's malformed JSON must not kill the whole run (Q2): fall back to a single-ticket plan —
  // the goal as one review ticket — so the run PROCEEDS and Brooke/replan can split it.
  if (!outline) {
    deps.emit?.({ kind: 'notice', text: `decompose failed after ${DECOMPOSE_ATTEMPTS} attempts (${lastErr}); proceeding with the goal as a single ticket for review.` })
    return fallbackPlan(goal)
  }
  // PHASE 2 — fill each bare outline ticket's body + check in SMALL BATCHES, so the heavy per-ticket content is
  // generated in pieces (never all at once). Best-effort: a failed batch leaves a sensible default rather than
  // sinking the whole plan. A model that already returned full tickets (body+check present) skips this entirely.
  deps.emit?.({ kind: 'notice', text: `Planning: outlined ${outline.tickets.length} tickets — writing details…` })
  await detailTickets(outline, config, deps, signal)
  return outline
}

/** Fill body + check for every outline ticket that has neither yet (a bare skeleton), one small batch per model
 *  call. Defensive: a batch that fails to parse, or omits a ticket, falls back to title-as-body + a safe behavioral
 *  check, so a weak model can never strand a ticket. Never throws. */
async function detailTickets(plan: DecomposePlan, config: LoopConfig, deps: OrchestratorDeps, signal?: AbortSignal): Promise<void> {
  const pending = plan.tickets.map((t, i) => ({ t, i })).filter(({ t }) => !t.body?.trim() && !t.check?.trim())
  for (let b = 0; b < pending.length; b += DETAIL_BATCH_SIZE) {
    const slice = pending.slice(b, b + DETAIL_BATCH_SIZE)
    const batch = slice.map(({ t, i }) => ({ index: i, title: t.title, role: normalizeRole(t.role) }))
    deps.emit?.({ kind: 'notice', text: `Planning: detailing tickets ${b + 1}–${Math.min(b + slice.length, pending.length)} of ${pending.length}…` })
    let byIndex = new Map<number, { body: string; check?: string }>()
    try {
      // Per-batch watchdog: a wedged detail call would otherwise stall the WHOLE decompose forever (the board is
      // written only after all batches finish), leaving an empty board. On timeout we throw → fall back to defaults
      // for this batch and move on, so the plan always completes.
      const text = await withTimeout(
        complete(config, deps, [
          { role: 'system', content: craftSystem(DETAIL_SYSTEM) },
          { role: 'user', content: buildDetailUser(plan.spec, batch) }
        ], signal),
        DETAIL_TIMEOUT_MS,
        `detail batch timed out after ${Math.round(DETAIL_TIMEOUT_MS / 1000)}s`
      )
      const json = extractJsonObject(text)
      const parsed = json ? detailBatchSchema.parse(JSON.parse(json)) : { tickets: [] }
      byIndex = new Map(parsed.tickets.map((d) => [d.index, { body: d.body, check: d.check }]))
    } catch (e) {
      deps.emit?.({ kind: 'notice', text: `detail batch failed (${e instanceof Error ? e.message : String(e)}); using defaults for ${slice.length} ticket(s)` })
    }
    for (const { t, i } of slice) {
      const role = normalizeRole(t.role)
      const d = byIndex.get(i)
      t.body = d?.body?.trim() || t.title // title is a safe minimal body — the worker still has the spec + role banner
      const c = d?.check?.trim()
      const existenceOnlyOnCode = (role === 'implementation' || role === 'testing') && !!c && isExistenceOnlyCheck(c)
      if (role === 'review') {
        t.check = undefined // review audits + routes; it never gates on a check
      } else if (c && validateCheck(c).ok && !existenceOnlyOnCode) {
        t.check = c // keep the model's check — but NEVER an existence-only one on impl/testing (passes on a stub)
      } else if (role === 'implementation' || role === 'testing' || role === 'design') {
        t.check = 'npx tsc --noEmit' // behavioral floor for code/visual roles when the check is missing/weak/broken
      } else {
        t.check = undefined // docs/architecture with no usable check → routed to review
      }
      // A TESTING ticket must RUN its tests — upgrade a typecheck-only / non-runner check to `npm test` so the test
      // it adds actually executes (otherwise a headless integration-test ticket silently gates on `tsc` and proves
      // nothing — the exact gap the planner validation surfaced).
      if (role === 'testing' && t.check && !CHECK_RUNS_TESTS.test(t.check)) t.check = 'npm test'
    }
  }
}

/** Build the DETAIL user message — the spec for shared context + the batch of tickets to write body/check for. */
function buildDetailUser(spec: string, batch: { index: number; title: string; role: string }[]): string {
  const list = batch.map((t) => `- index ${t.index} [${t.role}] ${t.title}`).join('\n')
  return `# Project spec\n\n${spec || '(no spec)'}\n\n# Tickets to detail (write body + check for EACH index)\n\n${list}\n\nReturn the JSON object described in the system prompt.`
}

/** The board side of writing a plan/diff — injected so the write logic unit-tests without a live board. */
export interface BoardWriteIO {
  setSpec(project: string, content: string): Promise<unknown>
  addTicket(t: NewTicket): Promise<{ id: number }>
  setStatus(id: number, status: string, note?: string): Promise<unknown>
}

export const liveBoardIO: BoardWriteIO = {
  setSpec: (project, content) => boardSetSpec(project, content),
  addTicket: (t) => boardAddTicket(t),
  setStatus: (id, status, note) => boardSetStatus(id, status, note)
}

/**
 * Write a decompose plan to the board: store the spec, then create tickets in dependency order, mapping each
 * ticket's LOCAL dep indices to the REAL board ids assigned as we go (the board rejects a dep to a ticket that
 * doesn't exist yet, which is exactly why we create deps-first). Returns the created ids in creation order.
 */
export async function writePlanToBoard(plan: DecomposePlan, project: string, io: BoardWriteIO = liveBoardIO): Promise<number[]> {
  await io.setSpec(project, plan.spec)
  const order = orderForCreate(plan.tickets)
  const localToReal = new Map<number, number>()
  const created: number[] = []
  for (const localIdx of order) {
    const t = plan.tickets[localIdx]
    const realDeps = (t.deps ?? []).map((d) => {
      const id = localToReal.get(d)
      if (id === undefined) throw new Error(`internal: dep ${d} of ticket ${localIdx} was not created first`)
      return id
    })
    // Backstop: a check that slipped past the decompose validator (e.g. the single-ticket fallbackPlan) must
    // never reach the board broken — auto-rewrite the trivial case, else drop it (→ the ticket goes to review,
    // not park-forever).
    const check = t.check && !validateCheck(t.check).ok ? (rewriteCheck(t.check) ?? undefined) : t.check
    const row = await io.addTicket({
      project,
      title: t.title,
      body: withRoleBanner(normalizeRole(t.role), t.body, t.files),
      check,
      deps: realDeps,
      priority: t.priority,
      spec_ref: `board:${project}` // truthy → each ticket's seed pulls in the project spec
    })
    localToReal.set(localIdx, row.id)
    created.push(row.id)
  }
  return created
}

/* ----- Replan: the closed-loop half that makes long runs survive ----- */

const REPLAN_SYSTEM = [
  'You are the replanner for an autonomous coding loop. A drain just ran. Given the GOAL, the SPEC, and the',
  'CURRENT BOARD (each ticket: id, status, title), revise the REMAINING work so the goal gets finished.',
  '',
  'Output RULES — obey exactly:',
  '- Respond with ONE JSON object, OPTIONALLY followed by a single <memory> block (see the LEARN rule at the end).',
  '- Shape: {"add": [{"title","body","check","role","deps":number[],"priority"}], "cancel": number[], "reopen": number[], "note": string}',
  '- "role" assigns the ticket to a team: architecture, implementation, design, testing, review, or docs.',
  '- "add": new tickets — e.g. split a PARKED ticket into smaller pieces, or add newly discovered work.',
  '  Their "deps" are REAL board ids that already exist. Every added ticket needs a real "check" command that runs',
  '  in PowerShell — a portable tool command (`npm test`/`pytest`/`npx tsc --noEmit`/`npm run build`), never bash',
  '  (`test -f`/`grep`/`/dev/null`/`&&`). Combine PowerShell conditions ONLY with parentheses — `(Test-Path a) -and',
  '  (Test-Path b)`, never bare `Test-Path a -and Test-Path b` (a syntax error). If a ticket parked on a broken check, re-file it fixed.',
  '- ESCALATIONS: if a ticket parked because the worker ESCALATED about a SEPARATE blocking issue it discovered (its',
  '  park reason starts "worker escalated"), ADD a NEW ticket scoped to THAT issue and REOPEN the original — make the',
  '  original depend on the new ticket when it needs the fix first. That is the whole point of the escalation: move the',
  '  big discovered issue into its OWN ticket so the worker is not stuck doing two jobs at once. Do not just re-file the original.',
  '- "cancel": always return []. Hermes never cancels tickets autonomously; add/reopen work instead.',
  '- "reopen": ids of tickets stuck in review that still need doing.',
  '- "note": one short sentence explaining this round.',
  '- If the board is essentially finished and nothing needs changing, return all three arrays empty — that',
  '  ends the run. Do NOT invent busywork.',
  '',
  '- LEARN (this is how the PLAN gets better over time): look at WHY tickets PARKED or were repeatedly reopened —',
  '  reviewers/checks rejecting the same shape of thing is a signal the PLAN was wrong, not just the code. If a',
  '  failure reveals a GENERALIZABLE lesson a FUTURE plan should apply — a brittle check pattern, a missing',
  '  dependency, a ticket that should have been split or specified more tightly, a structure that caused rework —',
  '  emit it AFTER the JSON as ONE tight bullet inside a <memory>...</memory> block. This becomes durable',
  '  CROSS-PROJECT planning craft injected into every future decompose. Generalize it (do NOT restate this project\'s',
  '  code or ticket ids); omit the block entirely if nothing generalizable came up.'
].join('\n')

function buildReplanUser(goal: string, spec: string, board: BoardTicketRow[], parkedIds: number[], parkedReasons: Record<number, string> = {}): string {
  const lines = board.map((t) => `- #${t.id} [${t.status}] ${t.title}`).join('\n')
  let parked = ''
  if (parkedIds.length) {
    const detail = parkedIds
      .map((id) => {
        const reason = parkedReasons[id] || 'failed its check after retries'
        // A "check-broken" park means the WORK is likely fine and only the CHECK command was invalid. Replan can
        // only ADD/REOPEN (never cancel — applySafe), so steer it to ADD a corrected-check replacement (R4).
        const fix = /check-broken/i.test(reason)
          ? ' — the work is likely done but the CHECK was invalid; ADD a replacement ticket for the same work with a CORRECTED PowerShell check (npm test / pytest / npx tsc --noEmit), never bash.'
          : ''
        return `  - #${id}: ${reason}${fix}`
      })
      .join('\n')
    parked = `\n\nPARKED this round (split, add a missing prerequisite, or add a corrected replacement):\n${detail}`
  }
  return `# Goal\n${goal.trim()}\n\n# Spec\n${spec.trim() || '(none)'}\n\n# Current board\n${lines || '(empty)'}${parked}\n\nReturn the replan JSON.`
}

/** Run a board-diff turn (replan or critic) and parse its JSON diff, retrying ONCE with the validation error
 *  fed back. Shared by runReplan and runCritic — both emit the same {add,cancel,reopen,note} shape. `onRaw` (when
 *  given) receives the raw text of the ACCEPTED completion, so a meeting caller can also pull a `<memory>` block
 *  the lead appended after the JSON. */
async function completeDiff(system: string, user: string, label: string, config: LoopConfig, deps: OrchestratorDeps, signal?: AbortSignal, onRaw?: (raw: string) => void): Promise<ReplanDiff> {
  let correction: string | undefined
  let lastErr = ''
  for (let attempt = 0; attempt < DIFF_ATTEMPTS; attempt++) {
    const u = user + (correction ? `\n\nYour previous output was rejected: ${correction}\nReturn corrected JSON only.` : '')
    const text = await complete(config, deps, [
      { role: 'system', content: system },
      { role: 'user', content: u }
    ], signal)
    try {
      const diff = parseReplan(text)
      const badAdd = diff.add.map((t, i) => ({ i, lint: validateCheck(t.check) })).find((x) => !x.lint.ok)
      if (badAdd) throw new Error(`added ticket ${badAdd.i} has an invalid check — ${badAdd.lint.reason}`)
      onRaw?.(text)
      return diff
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      correction = lastErr
      deps.emit?.({ kind: 'notice', text: `${label} attempt ${attempt + 1}/${DIFF_ATTEMPTS} rejected: ${lastErr}` })
    }
  }
  // A failed replan/critic must not abort the whole cycle (Q2): skip the round with an empty diff. For replan
  // that's "no change this round"; for critic, empty ends the run cleanly (the board is already drained).
  deps.emit?.({ kind: 'notice', text: `${label} failed after ${DIFF_ATTEMPTS} attempts (${lastErr}); skipping this round.` })
  return { add: [], cancel: [], reopen: [], note: `${label} unavailable this round` }
}

/** Run the replan turn against the live board, parsing its diff. */
export function runReplan(
  goal: string,
  spec: string,
  board: BoardTicketRow[],
  parkedIds: number[],
  config: LoopConfig,
  deps: OrchestratorDeps,
  signal?: AbortSignal,
  parkedReasons?: Record<number, string>
): Promise<ReplanDiff> {
  // onRaw: the replan may append a <memory> block distilling a GENERALIZABLE planning lesson from the failures
  // (parked/reopened tickets = what reviewers/checks kept rejecting). Fold it into Brooke's cross-project memory so
  // it shapes EVERY future decompose (craftSystem) — the bridge from review rejections to a better plan.
  return completeDiff(REPLAN_SYSTEM, buildReplanUser(goal, spec, board, parkedIds, parkedReasons), 'replan', config, deps, signal, (raw) => {
    const lesson = extractMemoryBlock(raw)
    if (lesson) appendManagerMemory(lesson)
  })
}

/* ----- L2 self-heal: a Decision Record ends a CONTESTED concept the replan would otherwise relitigate ----- */

// When thrashGuard flags a concept the run is FIGHTING (a ticket re-parking, the replan piling on overlapping
// tickets over one undecided question — the godkveld deck-exhaustion failure), this turn RULES ONCE: it issues a
// binding architectural decision, supersedes the thrashing tickets with a single apply-ticket that carries the
// decision inline, and generalizes the lesson so future PLANS decide such contracts up front. Authority, not debate.
const DECIDE_CONTRACT_SYSTEM = [
  'You are the TECH LEAD making a BINDING ARCHITECTURAL DECISION to end a thrash. A team has been fighting ONE',
  'undecided question across several tickets — re-parking, cancelling, and re-filing near-duplicate work without',
  'converging. The cause is almost always a CROSS-MODULE CONTRACT nobody decided (e.g. "what happens when the',
  'deck runs out?"). Your job is to DECIDE it once, for the whole codebase, and let the team apply that decision.',
  '',
  'You are given the GOAL, the SPEC, and the CONTESTED tickets (id, status, title, body). Output RULES — obey exactly:',
  '- Respond with ONE JSON object, nothing else:',
  '  {"decision": string, "contract": string, "apply": {"title": string, "body": string, "check": string},',
  '   "cancel": number[], "lesson": string}',
  '- "decision": a short Decision Record in markdown — *Context* (the contested question), *Decision* (the single',
  '  ruling), *Consequences* (what each affected module must now do). Be concrete and final; pick ONE design.',
  '- "contract": one sentence stating the rule every module must honor (e.g. "Deck.dealCard() returns null when',
  '  empty and never auto-resets; callers create a fresh Deck").',
  '- "apply": ONE consolidation ticket that implements the decision everywhere it is needed and removes the',
  '  conflicting code. "check" must be a real PowerShell-portable command (npm test / npx vitest run / pytest /',
  '  npx tsc --noEmit) — never bash. Reuse the contested tickets\' check when in doubt.',
  '- "cancel": the ids of the OPEN contested tickets this decision SUPERSEDES (they are replaced by "apply"). Only',
  '  ids from the list given; never invent ids.',
  '- "lesson": ONE generalizable, cross-project planning lesson — what a FUTURE decompose should decide up front to',
  '  avoid this thrash (e.g. "decide resource-exhaustion / boundary contracts in the plan, before splitting tickets").',
  '  Generalize it (no project-specific names or ids). Empty string if nothing generalizable.'
].join('\n')

function buildDecideContractUser(goal: string, spec: string, concept: Concept, cluster: BoardTicketRow[]): string {
  const tickets = cluster
    .map((t) => `- #${t.id} [${t.status}] ${t.title}${t.body ? `\n    ${t.body.replace(/\s+/g, ' ').slice(0, 280)}` : ''}`)
    .join('\n')
  return `# Goal\n${goal.trim()}\n\n# Spec\n${spec.trim() || '(none)'}\n\n# Contested concept: ${concept.label}\nWhy it is contested: ${concept.reason}\n\n# The tickets fighting over it\n${tickets}\n\nRule on it once. Return the decision JSON.`
}

interface DecideContract {
  decision: string
  contract: string
  apply: { title: string; body: string; check?: string }
  cancel: number[]
  lesson: string
}

function parseDecideContract(text: string): DecideContract | null {
  const raw = extractJsonObject(text)
  if (!raw) return null
  let o: Record<string, unknown>
  try {
    o = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const apply = (o.apply ?? {}) as Record<string, unknown>
  const decision = typeof o.decision === 'string' ? o.decision.trim() : ''
  const title = typeof apply.title === 'string' ? apply.title.trim() : ''
  if (!decision || !title) return null // a Decision Record with no ruling or no apply-ticket is unusable
  return {
    decision,
    contract: typeof o.contract === 'string' ? o.contract.trim() : '',
    apply: {
      title,
      body: typeof apply.body === 'string' ? apply.body : '',
      check: typeof apply.check === 'string' ? apply.check : undefined
    },
    cancel: Array.isArray(o.cancel) ? o.cancel.filter((x): x is number => typeof x === 'number') : [],
    lesson: typeof o.lesson === 'string' ? o.lesson.trim() : ''
  }
}

/** Pick a valid check for the apply-ticket: the model's if it lints, else a rewrite of it, else reuse a contested
 *  ticket's check (they target the same code), else none (→ the ticket goes to review rather than park-on-broken). */
function pickHealCheck(proposed: string | undefined, cluster: BoardTicketRow[]): string | undefined {
  if (proposed && validateCheck(proposed).ok) return proposed
  if (proposed) {
    const rw = rewriteCheck(proposed)
    if (rw && validateCheck(rw).ok) return rw
  }
  const fromCluster = cluster.map((t) => t.check).find((c): c is string => !!c && validateCheck(c).ok)
  return fromCluster ?? undefined
}

export interface ContestedResolution {
  healed: boolean
  cancelledIds: number[]
  applyId?: number
}

/**
 * Rule once on a contested concept and apply the ruling to the board: record the Decision Record to the project's
 * architecture memory, cancel the OPEN thrashing tickets it supersedes, file ONE apply-ticket carrying the decision
 * inline (so the worker obeys it), and fold the generalized lesson into Brooke's cross-project memory. Best-effort:
 * an unusable/failed decision turn returns {healed:false} and leaves the board for the replanner — it must never
 * abort the run. Model-bound but seam-injected (deps.complete, io), so it unit-tests headless.
 */
export async function resolveContestedConcept(
  concept: Concept,
  board: BoardTicketRow[],
  goal: string,
  spec: string,
  project: string,
  config: LoopConfig,
  deps: OrchestratorDeps,
  io: BoardWriteIO,
  signal?: AbortSignal
): Promise<ContestedResolution> {
  const cluster = board.filter((t) => concept.ticketIds.includes(t.id))
  const open = cluster.filter((t) => t.status !== 'done' && t.status !== 'cancelled')
  if (open.length === 0) return { healed: false, cancelledIds: [] } // the fight already ended — nothing to collapse

  const text = await complete(
    config,
    deps,
    [
      { role: 'system', content: DECIDE_CONTRACT_SYSTEM },
      { role: 'user', content: buildDecideContractUser(goal, spec, concept, cluster) }
    ],
    signal
  ).catch(() => '')
  const decision = parseDecideContract(text)
  if (!decision) {
    deps.emit?.({ kind: 'notice', text: `Thrash on "${concept.label}": the decision turn returned nothing usable — leaving it for the replanner.` })
    return { healed: false, cancelledIds: [] }
  }

  // 1) Record the decision as durable project craft (read by future architecture-department workers).
  const prior = readTeamMemory(config.cwd, 'architecture')
  writeTeamMemory(config.cwd, 'architecture', `${prior}\n\n## Decision — ${concept.label}\n${decision.decision}`.trim())

  // 2) Cancel the OPEN contested tickets the decision supersedes — never a done one, never outside the cluster.
  //    If the model named none, supersede every open cluster ticket (the whole fight is replaced by one apply-ticket).
  const openIds = new Set(open.map((t) => t.id))
  const named = decision.cancel.filter((id) => openIds.has(id))
  const cancelIds = named.length ? named : open.map((t) => t.id)
  for (const id of cancelIds) await io.setStatus(id, 'cancelled', `superseded by Decision Record "${concept.label}"`)

  // 3) File ONE consolidation ticket that carries the decision inline so the worker honors it.
  const body = withRoleBanner(
    'implementation',
    `${decision.apply.body}\n\n---\nDECISION OF RECORD (honor exactly):\n${decision.decision}${decision.contract ? `\n\nContract: ${decision.contract}` : ''}`
  )
  const { id: applyId } = await io.addTicket({
    project,
    title: decision.apply.title,
    body,
    check: pickHealCheck(decision.apply.check, cluster),
    deps: [],
    priority: 1,
    spec_ref: `board:${project}`
  })

  // 4) Generalize the lesson into Brooke's CROSS-PROJECT memory so future DECOMPOSES decide this contract up front.
  if (decision.lesson) appendManagerMemory(decision.lesson)

  deps.emit?.({
    kind: 'notice',
    text: `Decision Record "${concept.label}": ruled once — superseded ${cancelIds.length} thrashing ticket(s) with apply-ticket #${applyId}.`
  })
  return { healed: true, cancelledIds: cancelIds, applyId }
}

/* ----- Critic: the auto-improve half — when the board is drained, decide if the PROJECT can be improved ----- */

const CRITIC_SYSTEM = [
  'You are the lead reviewer of an autonomous engineering team. The board for this goal is fully drained —',
  'every ticket is done. Decide whether the PROJECT genuinely meets the goal at a professional quality bar, or',
  'whether a few targeted improvements are warranted, then act like a tech lead filing follow-up work.',
  '',
  'Output RULES — obey exactly:',
  '- Respond with ONE JSON object: {"add": [{"title","body","check","role","deps":number[],"priority"}], "cancel": [], "reopen": [], "note": string}',
  '- "role" assigns each improvement ticket to a team: architecture, implementation, design, testing, review, or docs.',
  '  ("review" tickets only audit + route fixes to implementation; prefer implementation/testing for actual changes.)',
  '- If the project is genuinely complete and solid, return empty add/cancel/reopen with a short note — do NOT',
  '  invent busywork. Empty ENDS the run, so only continue when there is real value left.',
  '- Otherwise propose a SMALL set (1–4) of HIGH-VALUE improvement tickets: missing tests, unhandled edge cases,',
  '  error handling, a risky-area refactor, missing docs. Each needs a real "check" that runs in PowerShell — a',
  '  portable tool command (`npm test`/`pytest`/`npm run build`/`npx tsc --noEmit`), never bash (`test -f`/`grep`).',
  '  Combine PowerShell conditions only with parentheses: `(Test-Path a) -and (Test-Path b)`, never the bare form.',
  '- "deps" are real existing board ids (usually none — improvements layer on done work).',
  '- The project\'s file tree AND source code are shown below — READ the code and ground every improvement in a',
  '  specific file/function or a concrete gap you can see there. Never guess from filenames.',
  '- BUILT-BUT-UNWIRED modules: if the evidence lists modules defined but never imported from an entry, you MUST file',
  '  a wire-up implementation ticket for each (the top-level entry must instantiate + USE the module; assets loaded',
  '  via a real preload), and you may NOT return empty while any module is unwired — an orphaned module renders/does',
  '  nothing, the #1 cause of a "done" project that is actually broken.',
  '- INTEGRATION TEST: if no test boots the ASSEMBLED app and asserts it actually does something (display list',
  '  populated / the entry exercises each module), file one (role: testing, check `npm test`). Do not finish a',
  '  runnable app verified only by isolated unit tests.',
  '- Be conservative and concrete. Tie every ticket to the goal; never propose vague "improve quality" work.'
].join('\n')

function buildCriticUser(goal: string, spec: string, board: BoardTicketRow[], tree: string): string {
  const done = board.filter((t) => t.status === 'done').map((t) => `- #${t.id} ${t.title}`).join('\n')
  return `# Goal\n${goal.trim()}\n\n# Spec\n${spec.trim() || '(none)'}\n\n# Completed tickets\n${done || '(none)'}\n\n# Project — what was actually built (file tree + source)\n${tree || '(none)'}\n\nReturn the critic JSON — improvement tickets, or empty to finish.`
}

const TREE_IGNORE = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.cache', '.venv', '__pycache__', '.nordcode'])
/** Text-like source extensions whose CONTENTS the critic is shown. Everything else (binaries, images) is only
 *  listed by name. */
const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.cs', '.rb', '.php', '.swift', '.css', '.scss', '.html', '.vue', '.svelte', '.json', '.yml', '.yaml', '.toml', '.sh', '.sql', '.md', '.txt'
])
/** Lockfiles: huge, generated, zero review value — listed by name but their contents are never dumped. */
const SKIP_CONTENT_NAMES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'])

/**
 * Evidence for the critic (Q3): the project's file tree PLUS the actual CONTENTS of its source files, capped to
 * a char budget — so the critic reviews REAL CODE instead of guessing from filenames. Reliable for Hermes'
 * commit-free project folders (where a `git diff` would be empty). Reads only text-like source files; skips
 * heavy dirs, dotfiles, lockfiles, and oversized files. Best-effort: returns '' when the folder is unreadable.
 * (A future upgrade can swap this for an interactive read-only agent turn that greps/reads on demand.)
 */
export function gatherCriticEvidence(cwd: string, contentBudget = 16_000, fileCap = 200): string {
  const files: { rel: string; full: string; dir: boolean }[] = []
  const walk = (dir: string, depth: number): void => {
    if (files.length >= fileCap || depth > 3) return
    let entries: string[]
    try {
      entries = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const name of entries) {
      if (files.length >= fileCap) return
      if (name.startsWith('.') || TREE_IGNORE.has(name)) continue
      const full = join(dir, name)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      files.push({ rel: relative(cwd, full).replace(/\\/g, '/'), full, dir: isDir })
      if (isDir) walk(full, depth + 1)
    }
  }
  walk(cwd, 0)
  if (!files.length) return ''
  const tree = files.map((f) => f.rel + (f.dir ? '/' : '')).join('\n')

  // Inline source contents up to the budget, biggest-bang-first by file order (deps-first walk ≈ scaffold-first).
  let used = 0
  const blocks: string[] = []
  for (const f of files) {
    if (f.dir || used >= contentBudget) continue
    const base = f.rel.split('/').pop() ?? ''
    const dot = base.lastIndexOf('.')
    const ext = dot >= 0 ? base.slice(dot).toLowerCase() : ''
    if (!SOURCE_EXT.has(ext) || SKIP_CONTENT_NAMES.has(base)) continue
    let content: string
    try {
      if (statSync(f.full).size > 32_768) continue // skip very large files — they'd blow the budget on one file
      content = readFileSync(f.full, 'utf8')
    } catch {
      continue
    }
    const remaining = contentBudget - used
    const slice = content.length > remaining ? content.slice(0, remaining) + '\n…(truncated)' : content
    blocks.push(`=== ${f.rel} ===\n${slice}`)
    used += slice.length
  }
  const sources = blocks.length ? `\n\n## Source (truncated to a budget)\n${blocks.join('\n\n')}` : ''

  // Static built-but-unwired detection: read every code file (imports live at the top) and flag modules unreachable
  // from any entry — the critic must wire them in before it can finish. Headless, no runtime.
  const orphans = findUnwiredModules(readProjectCodeFiles(cwd))
  const orphanNote = orphans.length
    ? `\n\n## ⚠ BUILT-BUT-UNWIRED modules (defined but never imported from an entry — they render/do NOTHING)\n${orphans
        .map((o) => `- ${o}`)
        .join('\n')}\nYou MUST file a wire-up ticket for each (the entry must instantiate + USE it) before finishing.`
    : ''
  return `## Files\n${tree}${orphanNote}${sources}`
}

/** Read every code file in a project (forward-slash relative paths + contents), bounded — for the static import-graph
 *  / unwired-module analysis. Skips heavy/ignored dirs, dotfiles, and oversized files. */
function readProjectCodeFiles(cwd: string, fileCap = 300): SourceFile[] {
  const out: SourceFile[] = []
  const walk = (dir: string, depth: number): void => {
    if (out.length >= fileCap || depth > 4) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (out.length >= fileCap) return
      if (name.startsWith('.') || TREE_IGNORE.has(name)) continue
      const full = join(dir, name)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        walk(full, depth + 1)
        continue
      }
      if (!/\.(?:[jt]sx?|mjs|cjs)$/i.test(name)) continue
      try {
        if (statSync(full).size > 65_536) continue
        out.push({ path: relative(cwd, full).replace(/\\/g, '/'), content: readFileSync(full, 'utf8') })
      } catch {
        /* unreadable — skip */
      }
    }
  }
  walk(cwd, 0)
  return out
}

/** STATIC integration verdict (no runtime): the assembled app is verified when there are no unwired modules AND an
 *  integration test exists (a project test file named integration/e2e/smoke, OR a done integration-style board
 *  ticket). `ok:true` when not assessable (no code found) so a non-web / unreadable project is never falsely blocked. */
export function liveIntegrationCheck(cwd: string, board: BoardTicketRow[]): IntegrationCheckResult {
  const codeFiles = readProjectCodeFiles(cwd)
  if (!codeFiles.length) return { ok: true, orphans: [], hasIntegrationTest: false, detail: 'no source found — not assessable' }
  const orphans = findUnwiredModules(codeFiles)
  const testFile = codeFiles.some((f) => /(?:integration|e2e|end[\s-]?to[\s-]?end|smoke)/i.test(f.path) && /\.(?:test|spec)\.[jt]sx?$/i.test(f.path))
  const testTicket = board.some(
    (t) => t.status === 'done' && INTEGRATION_TICKET.test(t.title) && /\b(test|spec|smoke|e2e|npm (run )?test)\b/i.test(`${t.title} ${t.check ?? ''}`)
  )
  const hasIntegrationTest = testFile || testTicket
  const ok = orphans.length === 0 && hasIntegrationTest
  const detail = ok
    ? 'assembled app verified (no unwired modules + an integration test)'
    : `${orphans.length ? `built-but-unwired: ${orphans.join(', ')}. ` : ''}${hasIntegrationTest ? '' : 'no integration test boots the assembled app.'}`.trim()
  return { ok, orphans, hasIntegrationTest, detail }
}

/** Dispatch the integration verdict through the test seam when present, else the live static check. */
function runIntegrationCheck(config: LoopConfig, deps: OrchestratorDeps, board: BoardTicketRow[]): IntegrationCheckResult {
  return deps.integrationCheck ? deps.integrationCheck(config.cwd, board) : liveIntegrationCheck(config.cwd, board)
}

/** Run the critic turn: review the drained project + its files and propose improvement tickets (or none). */
export function runCritic(
  goal: string,
  spec: string,
  board: BoardTicketRow[],
  cwd: string,
  config: LoopConfig,
  deps: OrchestratorDeps,
  signal?: AbortSignal
): Promise<ReplanDiff> {
  return completeDiff(CRITIC_SYSTEM, buildCriticUser(goal, spec, board, gatherCriticEvidence(cwd)), 'critic', config, deps, signal)
}

/* ----- Manager meeting: the multi-lead version of the critic — convene each department lead for the next round ----- */

/** Normalize a ticket title for duplicate detection — case- and whitespace-insensitive. Used to stop a meeting
 *  from re-proposing work already on the board (the 3-4× duplicate explosion seen in the overnight runs). */
const normTitle = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')

const MEETING_SYSTEM = (dept: Department): string =>
  [
    `You are the ${dept.toUpperCase()} department lead in a manager meeting. The project's board is fully drained — before the team idles, each department lead is asked what HIGH-VALUE work genuinely remains in THEIR area.`,
    '',
    'Output RULES — obey exactly:',
    '- Respond with ONE JSON object: {"add": [{"title","body","check","role","deps":number[],"priority"}], "cancel": [], "reopen": [], "note": string}',
    `- "role" MUST be "${dept}" for everything you propose — you speak only for your own department.`,
    '- Propose 0-2 GENUINELY valuable follow-up tickets from YOUR lens: EITHER a real gap (missing tests/edge cases,',
    '  error handling, a risky-area refactor, missing docs, a perf issue) OR a valuable NEW capability the goal implies',
    '  but that is not built yet — keep advancing the product, do not just polish. If your area is solid AND the goal is',
    '  fully met, return an EMPTY add list with a one-line note. Do NOT invent busywork or gold-plate a finished project.',
    '- Each ticket needs a real "check" that passes (exit 0) only when done and RUNS IN POWERSHELL — a portable tool',
    '  command (`npm test`/`pytest`/`npx tsc --noEmit`/`npm run build`), never bash (`test -f`/`grep`/`/dev/null`).',
    '  Combine PowerShell conditions only with parentheses: `(Test-Path a) -and (Test-Path b)`.',
    '- The project source is shown below — ground every proposal in a specific file/gap you can see, never guess.',
    '- Do NOT propose anything ALREADY ON THE BOARD — you are shown the pending/in-progress tickets; re-proposing',
    '  filed work just creates duplicates. Propose only GENUINELY NEW work your area still needs.',
    '- "cancel"/"reopen": always []. "deps": real existing ids (usually none).',
    '- Your DEPARTMENT MEMORY (accumulated craft) is shown below — use it, and do not re-raise what it already records.',
    '  If this meeting surfaced a DURABLE, cross-ticket insight (a recurring gap, a risky module, a convention), append',
    '  it and emit the FULL updated memory as concise bullets in a `<memory>...</memory>` block AFTER the JSON (keep it',
    '  tight; summarize if long). Omit the block entirely if nothing durable is new.'
  ].join('\n')

function buildMeetingUser(goal: string, spec: string, board: BoardTicketRow[], evidence: string, dept: Department, memory: string): string {
  const done = board.filter((t) => t.status === 'done').map((t) => `- #${t.id} ${t.title}`).join('\n')
  const pending = board.filter((t) => t.status !== 'done' && t.status !== 'cancelled').map((t) => `- #${t.id} [${t.status}] ${t.title}`).join('\n')
  return `# Goal\n${goal.trim()}\n\n# Spec\n${spec.trim() || '(none)'}\n\n# Your ${dept} department memory (accumulated craft — use it; build on it, don't repeat it)\n${memory.trim() || '(none yet)'}\n\n# Already built (done tickets)\n${done || '(none)'}\n\n# ALREADY ON THE BOARD — do NOT re-propose any of these (filed or in progress; re-proposing them creates duplicates)\n${pending || '(none)'}\n\n# Project — what was built (file tree + source, truncated)\n${evidence || '(none)'}\n\nAs the ${dept} lead, return the meeting JSON — 0-2 GENUINELY NEW improvement tickets for YOUR area that are NOT already listed above, or empty if your area is well covered.`
}

/**
 * Manager meeting (continuous "keep working" mode): instead of the solo critic, convene EACH department lead present
 * on the board and ask what high-value improvement remains in their area; their proposals union into one replan diff.
 * Each lead reasons over the shared evidence in its OWN lean call (context-engineering: distributed + in-zone), so the
 * managers are genuinely involved rather than one critic deciding for everyone. Empty add = every area is solid.
 */
export async function runManagerMeeting(
  goal: string,
  spec: string,
  board: BoardTicketRow[],
  cwd: string,
  config: LoopConfig,
  deps: OrchestratorDeps,
  signal?: AbortSignal
): Promise<ReplanDiff> {
  const present = [...new Set(board.map((t) => departmentOf(t.body)).filter((d): d is Department => !!d))]
  const depts = present.length ? present : (['implementation'] as Department[])
  const evidence = gatherCriticEvidence(cwd)
  // Titles already on the board (any non-cancelled status). A meeting must not re-propose filed/in-progress work
  // — that blindness produced the 3-4× duplicate explosion in the overnight runs. This dedup backstops the
  // visibility fix in buildMeetingUser, and also de-dups WITHIN the meeting's own proposals.
  const seen = new Set(board.filter((t) => t.status !== 'cancelled').map((t) => normTitle(t.title)))
  const adds: ReplanAdd[] = []
  let dropped = 0
  for (const dept of depts) {
    if (signal?.aborted) break
    deps.emit?.({ kind: 'notice', text: `Manager meeting: ${dept} lead weighing in…` })
    const memory = readTeamMemory(cwd, dept)
    // onRaw: the lead may append a <memory> block updating its department's accumulated craft — persist it so the
    // meeting feeds the same memory the reviewer writes and runLeadBrief reads (managers ↔ memory ↔ meetings loop).
    const diff = await completeDiff(MEETING_SYSTEM(dept), buildMeetingUser(goal, spec, board, evidence, dept, memory), `meeting:${dept}`, config, deps, signal, (raw) => {
      const note = extractMemoryBlock(raw)
      if (note) writeTeamMemory(cwd, dept, note)
    })
    for (const a of diff.add) {
      const key = normTitle(a.title)
      if (seen.has(key)) { dropped++; continue }
      seen.add(key)
      adds.push({ ...a, role: a.role || dept })
    }
  }
  const note = `manager meeting — ${depts.length} lead(s) proposed ${adds.length} improvement(s)` + (dropped ? `, ${dropped} duplicate(s) dropped` : '')
  return { add: adds.slice(0, MAX_DECOMPOSE_TICKETS), cancel: [], reopen: [], note }
}

/* ----- Decompose-TIME meeting: the leads shape the FIRST plan, before any ticket exists ----- */

const DECOMPOSE_MEETING_SYSTEM = (dept: Department): string =>
  [
    `You are the ${dept.toUpperCase()} department lead in a PLANNING meeting. The team has just drafted a plan for a new goal — NOTHING is built yet. Before the board is created, each lead reviews the DRAFT plan and flags what it is MISSING from their area.`,
    '',
    'Output RULES — obey exactly:',
    '- Respond with ONE JSON object: {"add": [{"title","body","check","role","deps":[],"priority"}], "cancel": [], "reopen": [], "note": string}',
    `- "role" MUST be "${dept}" for everything you propose — you speak only for your own department.`,
    '- Propose 0-2 tickets for work the draft OVERLOOKED in YOUR area (a missing slice, missing tests/edge cases,',
    '  error handling, a needed doc, a review/validation step). If the draft already covers your area, return an EMPTY',
    '  add list with a one-line note. Do NOT restate tickets already in the draft, and do NOT gold-plate.',
    '- Each ticket needs a real "check" that passes (exit 0) only when done and RUNS IN POWERSHELL — a portable tool',
    '  command (`npm test`/`pytest`/`npx tsc --noEmit`/`npm run build`), never bash (`test -f`/`grep`/`/dev/null`).',
    '  Combine PowerShell conditions only with parentheses: `(Test-Path a) -and (Test-Path b)`.',
    '- "deps" MUST be [] (the board does not exist yet — propose standalone tickets). "cancel"/"reopen": always [].',
    '- Your DEPARTMENT MEMORY (craft from past runs of this project) is shown below — use it to spot what is usually',
    '  missed. If this planning surfaced a DURABLE insight for your team, emit the FULL updated memory as concise',
    '  bullets in a `<memory>...</memory>` block AFTER the JSON; omit it if nothing durable is new.'
  ].join('\n')

function buildDecomposeMeetingUser(goal: string, plan: DecomposePlan, dept: Department, memory: string): string {
  const draft = plan.tickets
    .map((t, i) => `- [${i}] (${normalizeRole(t.role)}) ${t.title}${t.check ? ` — check: ${t.check}` : ''}`)
    .join('\n')
  return `# Goal\n${goal.trim()}\n\n# Spec\n${plan.spec.trim() || '(none)'}\n\n# Your ${dept} department memory (craft from past runs — use it to catch what's usually missed)\n${memory.trim() || '(none yet)'}\n\n# Draft plan (not yet built)\n${draft || '(none)'}\n\nAs the ${dept} lead, return the meeting JSON — 0-2 tickets for work YOUR area needs that the draft is missing, or empty.`
}

/**
 * Decompose-TIME manager meeting: before the FIRST tickets are written, convene each department lead present in the
 * DRAFT plan and ask what their area is MISSING. Their proposals are appended to the plan (as STANDALONE tickets with
 * deps:[], up to MAX_DECOMPOSE_TICKETS) so the initial board reflects the leads' input — not just the solo decompose.
 * Mirrors runManagerMeeting, but operates on the in-memory draft: there is no board (so departments come from the
 * draft tickets' role, not departmentOf(body)) and nothing is built yet (so no source evidence and deps are forced
 * to [] — sidestepping the local-vs-real index world). Each lead's call is leaner than the continuous meeting.
 * Pure aside from deps.complete → unit-tested with a canned complete.
 */
export async function runDecomposeMeeting(
  goal: string,
  plan: DecomposePlan,
  config: LoopConfig,
  deps: OrchestratorDeps,
  signal?: AbortSignal
): Promise<DecomposePlan> {
  const present = [...new Set(plan.tickets.map((t) => normalizeRole(t.role)))]
  const depts = present.length ? present : (['implementation'] as Department[])
  // De-dup against the draft's own titles (and across leads) so the meeting only ADDS genuinely new work.
  const seen = new Set(plan.tickets.map((t) => normTitle(t.title)))
  const additions: PlanTicket[] = []
  for (const dept of depts) {
    if (signal?.aborted) break
    if (plan.tickets.length + additions.length >= MAX_DECOMPOSE_TICKETS) break
    deps.emit?.({ kind: 'notice', text: `Planning meeting: ${dept} lead reviewing the draft…` })
    const memory = readTeamMemory(config.cwd, dept)
    const diff = await completeDiff(DECOMPOSE_MEETING_SYSTEM(dept), buildDecomposeMeetingUser(goal, plan, dept, memory), `plan-meeting:${dept}`, config, deps, signal, (raw) => {
      const note = extractMemoryBlock(raw)
      if (note) writeTeamMemory(config.cwd, dept, note)
    })
    // Force deps:[] — a lead can't safely reference local indices, and the board has no ids yet. Each proposal is a
    // standalone ticket the single writePlanToBoard pass will create.
    for (const a of diff.add) {
      const key = normTitle(a.title)
      if (seen.has(key)) continue
      seen.add(key)
      additions.push({ title: a.title, body: a.body, check: a.check, role: a.role || dept, deps: [], priority: a.priority })
    }
  }
  if (!additions.length) return plan
  const room = Math.max(0, MAX_DECOMPOSE_TICKETS - plan.tickets.length)
  return { spec: plan.spec, tickets: [...plan.tickets, ...additions.slice(0, room)] }
}

/* ----- Department backlog grooming: each dept lead RIGHT-SIZES its own tickets (splits over-scoped sweeps) ----- */

const GROOMING_SYSTEM = (dept: Department): string =>
  [
    `You are the ${dept.toUpperCase()} department lead doing BACKLOG GROOMING before any work starts. You see YOUR department's draft tickets. Your ONE job: find tickets that are TOO BIG for a single worker session and SPLIT them into focused pieces.`,
    '',
    'A ticket is too big when it is a SWEEP — "expand the whole test suite", "write all the docs", "enforce coverage across the project", "build the entire frontend", "refactor everything" — i.e. it spans many files/modules or bundles many separate deliverables. One worker cannot finish that in one focused session; its context fills and it stalls.',
    '',
    'Output RULES — obey exactly:',
    '- Respond with ONE JSON object: {"splits": [{"index": <ticket index>, "pieces": [{"title","body","check","deps":[piece indices]}]}], "note": string}',
    '- Split ONLY tickets from the list below, by their [index], and ONLY ones marked SPLITTABLE. Leave the rest.',
    '- Each split makes 2+ FOCUSED pieces — one concern / a handful of files each — with a real PowerShell check',
    '  (`npm test`/`pytest`/`npx tsc --noEmit`/`npm run build`). "deps" are 0-based indices INTO THIS split\'s pieces',
    '  (e.g. a final "enforce coverage" piece depends on the per-file test pieces); usually [].',
    '- If a ticket is already one focused session, do NOT split it. If nothing is too big, return {"splits": []}.',
    '- Do NOT combine tickets, add new work, or touch other departments.',
    '- AFTER the JSON you MAY append a `<memory>...</memory>` block with a durable sizing lesson for your team.'
  ].join('\n')

function buildGroomingUser(goal: string, plan: DecomposePlan, dept: Department, memory: string, splittable: Set<number>): string {
  const mine = plan.tickets
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => normalizeRole(t.role) === dept)
    .map(({ t, i }) => `- [${i}] ${splittable.has(i) ? 'SPLITTABLE' : 'fixed'} — ${t.title}${t.check ? ` (check: ${t.check})` : ''}`)
    .join('\n')
  return `# Goal\n${goal.trim()}\n\n# Your ${dept} department memory (sizing lessons from past runs)\n${memory.trim() || '(none yet)'}\n\n# Your department's draft tickets\n${mine || '(none)'}\n\nReturn the grooming JSON — split any SPLITTABLE ticket that is too big for one session into focused pieces, or {"splits": []}.`
}

/**
 * Department-lead backlog grooming (the "managers right-size the work" step): before the board is written, convene
 * each department's lead over ITS OWN draft tickets and let it SPLIT the over-scoped sweeps into one-session pieces.
 * This is where over-scoping is caught up front — not by the worker mid-grind. Only LEAF tickets (nothing depends on
 * them) are splittable, so applyGroomSplits never orphans a dependency. Each split + its rationale is surfaced as a
 * notice and folded into the dept's team memory (so the brain icon shows what its manager did). Pure aside from
 * deps.complete + best-effort memory I/O → unit-tested with a canned complete.
 */
export async function runDepartmentGrooming(
  goal: string,
  plan: DecomposePlan,
  config: LoopConfig,
  deps: OrchestratorDeps,
  signal?: AbortSignal
): Promise<DecomposePlan> {
  let current = plan
  const present = [...new Set(plan.tickets.map((t) => normalizeRole(t.role)))]
  for (const dept of present) {
    if (signal?.aborted) break
    if (current.tickets.length >= MAX_DECOMPOSE_TICKETS) break
    // Leaves = tickets nothing depends on (safe to split). Recompute against the CURRENT plan (a prior dept may have split).
    const dependedOn = new Set<number>()
    for (const t of current.tickets) for (const d of t.deps ?? []) dependedOn.add(d)
    const splittable = new Set(current.tickets.map((_, i) => i).filter((i) => normalizeRole(current.tickets[i].role) === dept && !dependedOn.has(i)))
    if (!splittable.size) continue
    const memory = readTeamMemory(config.cwd, dept)
    deps.emit?.({ kind: 'notice', text: `${dept} lead grooming its backlog…` })
    const text = await complete(
      config,
      deps,
      [
        { role: 'system', content: GROOMING_SYSTEM(dept) },
        { role: 'user', content: buildGroomingUser(goal, current, dept, memory, splittable) }
      ],
      signal
    )
    const note = extractMemoryBlock(text)
    if (note) writeTeamMemory(config.cwd, dept, note)
    const splits = parseGroomSplits(text)
    if (!splits.length) continue
    const res = applyGroomSplits(current, splits, dept)
    for (const a of res.applied) deps.emit?.({ kind: 'notice', text: `${dept} lead: "${a.title.slice(0, 56)}" was too broad — split into ${a.pieceCount} focused tickets.` })
    if (res.applied.length) {
      current = res.plan
      // Record the grooming as durable craft so the dept's memory (the brain icon) reflects what its manager did.
      if (!note) writeTeamMemory(config.cwd, dept, `- Right-sized the backlog: split ${res.applied.length} over-scoped sweep ticket(s) into focused per-file/per-module pieces.`)
    }
  }
  return current
}

/** Apply a replan diff to the board: cancel obsolete tickets, reopen stuck review work, add new tickets (whose
 *  deps are real ids that already exist). Injected io → unit-tested without a board.
 *
 *  Each item is applied INDEPENDENTLY: the board throws on any non-2xx (a hallucinated reopen/cancel id from a
 *  weak local model, a missing or cyclic add-ticket dep), and an un-caught throw here propagates out to runHermes
 *  and wedges the whole autonomous cycle. So a failed item is skipped with a notice (mirroring addWork's
 *  per-edge try/catch) and the others still land. The returned counts are ACTUAL successes, not requested counts. */
export async function applyReplanDiff(
  diff: ReplanDiff,
  project: string,
  io: BoardWriteIO = liveBoardIO,
  emit?: OrchestratorDeps['emit'],
  existing: { title: string; status: string }[] = []
): Promise<{ added: number; cancelled: number; reopened: number }> {
  const note = diff.note?.trim().slice(0, 180)
  const skip = (what: string, e: unknown): void =>
    emit?.({ kind: 'notice', text: `Replan skipped ${what}: ${e instanceof Error ? e.message : String(e)}` })
  // Dedup adds against the LIVE board (and within this batch): a replan re-proposing a title already on the board
  // must NOT create a second copy. That re-file churn ballooned boards AND, by changing the board signature every
  // round, defeated the stuck-detector so the run replanned forever (the "continuous replanning" runaway). dedupeKey
  // folds case/punctuation exactly like the board deduper, so distinct work is never wrongly merged.
  const seenTitles = new Set(existing.filter((t) => t.status !== 'cancelled').map((t) => dedupeKey(t.title)).filter(Boolean))
  let cancelled = 0
  let reopened = 0
  let added = 0
  let skippedDupes = 0
  for (const id of diff.cancel) {
    try {
      await io.setStatus(id, 'cancelled', note ? `replan: ${note}` : 'cancelled by replan')
      cancelled++
    } catch (e) {
      skip(`cancel of #${id}`, e)
    }
  }
  for (const id of diff.reopen) {
    try {
      await io.setStatus(id, 'todo', note ? `replan: ${note}` : 'reopened by replan')
      reopened++
    } catch (e) {
      skip(`reopen of #${id}`, e)
    }
  }
  for (const t of diff.add) {
    const key = dedupeKey(t.title)
    if (key && seenTitles.has(key)) {
      skippedDupes++
      continue // already on the board (or earlier in this batch) — skip the duplicate add
    }
    const check = t.check && !validateCheck(t.check).ok ? (rewriteCheck(t.check) ?? undefined) : t.check
    try {
      await io.addTicket({ project, title: t.title, body: withRoleBanner(normalizeRole(t.role), t.body), check, deps: t.deps, priority: t.priority, spec_ref: `board:${project}` })
      if (key) seenTitles.add(key)
      added++
    } catch (e) {
      skip(`add of "${t.title.slice(0, 56)}"`, e)
    }
  }
  if (skippedDupes) emit?.({ kind: 'notice', text: `Replan skipped ${skippedDupes} duplicate add(s) already on the board.` })
  return { added, cancelled, reopened }
}

/**
 * Config invariants EVERY Hermes run must hold, regardless of the caller's LoopConfig (C3):
 *  - branchPerRun:false — the orchestrator drives ONE shared working tree across rounds. Per-run worktree
 *    isolation re-branches from the original HEAD each round (BoardRunner.start resets runWorktree), so round 2
 *    can't see round 1's commits and cross-round dependent tickets break. Hermes works in a dedicated project
 *    folder, so the "untouched folder" guarantee that worktrees provide isn't needed here.
 *  - includeReview:false — review is a terminal hand-off, not an auto-requeue; a replan reopens explicitly.
 * Applied at the launch sites so a caller's stray branchPerRun:true can never wedge continuity. Pure → tested.
 */
export function hermesRunConfig(config: LoopConfig): LoopConfig {
  return { ...config, branchPerRun: false, includeReview: false }
}

/** A still-open ticket handed to the manager when the cycle is stuck (B). The `check` is the key field — it
 *  reveals a broken/bash check; the status distinguishes blocked from parked. */
export interface StuckTicket {
  id: number
  title: string
  check: string | null
  status: string
}

/** Seams the orchestrator drives — injected by ipc.ts (drain = BoardRunner, board reads = loopBoard). Kept as
 *  an interface so the closed-loop control flow is wired against fakes in integration tests. */
export interface HermesSeams {
  /** Start a board drain (with includeReview on) and resolve when it settles. */
  runDrainOnce(): Promise<void>
  /** Live tickets for the project (defaults to loopBoard.fetchTickets). */
  getBoardState?(project: string): Promise<BoardTicketRow[]>
  /** Ids parked during the last drain (BoardRunner.parkedIds) — the replanner's primary signal. */
  getParked(): number[]
  /** Why each parked ticket parked (BoardRunner.parkReasons) — lets the replanner see a "check-broken:" park and
   *  ADD a corrected-check replacement instead of re-attempting the work (R4). Optional → defaults to no reasons. */
  getParkedReasons?(): Record<number, string>
  /** "Keep working until stopped" mode (Brooke's keep_working lever): when true, runHermes never self-terminates on
   *  the round/improve caps or on completion — when the board drains it convenes a MANAGER MEETING for more
   *  improvements and otherwise idles on-call; only a Stop (signal abort) ends it. Read LIVE so it can be toggled
   *  mid-run. Optional → defaults off (existing terminate-when-done behaviour). */
  isContinuous?(): boolean
  /** Pause gate (C1): true while the user has paused the team. The orchestrator holds between rounds on it so
   *  a pause survives the whole decompose→drain→replan cycle instead of being un-paused by the next drain's
   *  start(). Optional → defaults to never-paused, so existing callers/tests are unaffected. */
  isPaused?(): boolean
  /** Resolves once the team is resumed (or `signal` aborts). Paired with isPaused — see pauseGate.ts. */
  waitWhilePaused?(signal?: AbortSignal): Promise<void>
  /** Manager intervention (B): called when the cycle is genuinely stuck (a full round changed nothing and the
   *  replan is empty). Hand the unfinished tickets (with their checks) to the manager (Brooke) so she can
   *  cancel a ticket parked on a broken check + re-file it, reopen a blocked one, or escalate to the user. The
   *  orchestrator re-drains if the board changed afterward (capped). Optional → without it, a stuck cycle hands
   *  off to the user as before. */
  interveneOnStuck?(stuck: StuckTicket[]): Promise<void>
}

export interface HermesResult {
  rounds: number
  /** How the cycle ended: complete = critic found nothing to improve AND the assembled app is verified (no unwired
   *  modules + an integration test); needs-integration = the board drained but the assembled app is unverified and
   *  the improve budget is spent; improve-cap = budget spent while otherwise done; replan-empty = replanner had
   *  nothing; max-rounds/stopped as named. */
  reason: 'complete' | 'needs-integration' | 'needs-split' | 'improve-cap' | 'replan-empty' | 'max-rounds' | 'stopped'
  tickets: number
  improveRounds: number
}

/**
 * The full Hermes cycle: decompose the goal → write the board → (drain → replan)* until the board is settled,
 * the replanner asks for no change, or the round cap trips. The model-bound turns live above; here is the
 * control flow that closes the loop the bare drain is missing.
 */
export async function runHermes(
  goal: string,
  project: string,
  config: LoopConfig,
  deps: OrchestratorDeps,
  seams: HermesSeams,
  opts: {
    maxRounds?: number
    maxImproveRounds?: number
    maxStuckRounds?: number
    signal?: AbortSignal
    /** Continue an existing board (project continuity): skip the decompose+write step and drain the tickets
     *  already on the board. Re-decomposing would duplicate the whole board. */
    skipDecompose?: boolean
    /** The spec to judge against when continuing (decompose normally produces it); falls back to the goal. */
    existingSpec?: string
    /** Poll interval (ms) for the continuous-mode idle wait. Default 4000; tests pass a tiny value. */
    idlePollMs?: number
    /** Run a decompose-TIME manager meeting (each present lead proposes work their area is missing) over the DRAFT
     *  plan before the first board write. Opt-in — ipc sets it on; left off in tests so they don't see the extra
     *  meeting calls. Only fires on non-trivial plans (>= 2 tickets) in the decompose (non-attach) branch. */
    planMeeting?: boolean
    /** Manager-owned (lazy) orchestration — route to runHermesLazy (split-on-failure). Default off → eager path.
     *  Overrides settings.hermesLazyOrchestration when set. */
    lazyDecompose?: boolean
  } = {}
): Promise<HermesResult> {
  // Manager-owned, lazy/split-on-failure orchestration (SPEC-manager-owned-orchestration.md). Built behind a flag so
  // it matures alongside the eager path; default OFF → existing behavior unchanged. The flag is the ONLY change here.
  if (opts.lazyDecompose ?? deps.settings?.hermesLazyOrchestration) {
    return runHermesLazy(goal, project, config, deps, seams, opts)
  }
  const maxRounds = opts.maxRounds ?? 12
  const maxImprove = opts.maxImproveRounds ?? 3
  const maxStuck = opts.maxStuckRounds ?? 2
  const signal = opts.signal
  const getState = seams.getBoardState ?? ((p: string) => fetchTickets(p))

  // A model must not discard user work just by proposing a cancellation. Replan/critic may ADD or REOPEN
  // work; cancellation stays an explicit human/board action — so we strip `cancel` before applying any diff.
  const applySafe = async (diff: ReplanDiff, kind: string, existing: BoardTicketRow[] = []): Promise<{ added: number; reopened: number }> => {
    if (diff.cancel.length) deps.emit?.({ kind: 'notice', text: `Ignored ${diff.cancel.length} automatic cancellation(s); ${kind} only adds or reopens work.` })
    // Pass the live board so re-proposed titles are deduped against it (no second copy of existing work).
    const applied = await applyReplanDiff({ ...diff, cancel: [] }, project, deps.io, deps.emit, existing)
    return applied
  }
  const isEmptyExceptCancel = (diff: ReplanDiff): boolean => diff.add.length === 0 && diff.reopen.length === 0
  // Pause gate (C1): default to never-paused so non-Hermes callers and the unit tests are unaffected.
  const isPaused = seams.isPaused ?? ((): boolean => false)
  const waitWhilePaused = seams.waitWhilePaused ?? ((): Promise<void> => Promise.resolve())

  const io = deps.io ?? liveBoardIO

  // Startup reconciliation (mode 5) + idempotent decompose (mode 1) both read the board ONCE here.
  const startBoard = await getState(project)

  // A prior crash/kill can strand a ticket in_progress with no live owner; claimNext only returns ready todo, so
  // without this it stays invisible forever. Single-flight guarantees no concurrent drain holds one, so resetting
  // in_progress -> todo here is race-free and makes the board self-healing on ANY run start (not only resume).
  const stranded = startBoard.filter((t) => t.status === 'in_progress')
  for (const t of stranded) await io.setStatus(t.id, 'todo', 'reset on run start — orphaned in_progress (no live owner)')
  if (stranded.length) deps.emit?.({ kind: 'notice', text: `Reclaimed ${stranded.length} orphaned in_progress ticket(s).` })

  // Plan the work — UNLESS the board already has live tickets for this key (an explicit continue OR an accidental
  // re-start). Re-decomposing would duplicate every ticket (the 237/166 explosion), so we ATTACH and drain what's
  // there. This holds regardless of whether start_goal or resume was the entry point — no reliance on Brooke's routing.
  const attach = opts.skipDecompose || startBoard.some((t) => t.status !== 'cancelled')
  let plan: DecomposePlan
  let ids: number[]
  if (attach) {
    if (!opts.skipDecompose) deps.emit?.({ kind: 'notice', text: `Board already has work for "${project}" — attaching instead of re-decomposing.` })
    plan = { spec: opts.existingSpec?.trim() || goal, tickets: [] }
    ids = startBoard.map((t) => t.id)
    deps.emit?.({ kind: 'notice', text: `Hermes is continuing the existing board (${ids.length} ticket(s)).` })
  } else {
    deps.emit?.({ kind: 'hermes-state', state: 'planning' })
    plan = await runDecompose(goal, config, deps, signal)
    // Decompose-TIME manager meeting (opt-in): before the first board write, each present department lead reviews the
    // DRAFT plan and proposes any work their area is missing. Gated to non-trivial plans (>= 2 tickets) so a simple
    // goal or the single-ticket fallback isn't slowed. Operates on the in-memory plan, so the adds ride the single
    // writePlanToBoard pass below (no board exists yet).
    if (opts.planMeeting && !signal?.aborted && plan.tickets.length >= 2) {
      // Department managers right-size their backlog FIRST (split over-scoped sweeps), then the meeting adds any
      // missing work. BEST-EFFORT: these are pre-write refinements, so a failure (a model error on a huge goal, or a
      // bad split graph) must NEVER block the board write — otherwise a new project stalls on an empty board and a
      // resume can't recover it. On any error, fall back to the already-validated decomposed plan.
      const safePlan = plan
      try {
        // Bounded: if grooming or the meeting hangs, fall back to the decomposed plan and write the board (don't stall).
        const shaped = await withTimeout(
          (async () => {
            let s = await runDepartmentGrooming(goal, plan, config, deps, signal)
            const before = s.tickets.length
            s = await runDecomposeMeeting(goal, s, config, deps, signal)
            orderForCreate(s.tickets) // re-validate the graph grooming/meeting produced — throws on a cycle/bad dep
            const added = s.tickets.length - before
            if (added > 0) deps.emit?.({ kind: 'notice', text: `Planning meeting shaped the plan: +${added} ticket(s) before build.` })
            return s
          })(),
          PLANNING_MEETING_TIMEOUT_MS,
          `planning meeting timed out after ${Math.round(PLANNING_MEETING_TIMEOUT_MS / 1000)}s`
        )
        plan = shaped
      } catch (e) {
        deps.emit?.({ kind: 'notice', text: `Grooming/meeting skipped (kept the decomposed plan): ${e instanceof Error ? e.message : String(e)}` })
        plan = safePlan
      }
    }
    ids = await writePlanToBoard(plan, project, io)
    deps.emit?.({ kind: 'hermes-round', phase: 'decompose', round: 0, tickets: ids.length })
    deps.emit?.({ kind: 'notice', text: `Hermes decomposed the goal into ${ids.length} ticket(s).` })
  }

  // A signature of the board's statuses — used to tell "still making progress" from "genuinely stuck".
  const sigOf = (b: BoardTicketRow[]): string => b.map((t) => `${t.id}:${t.status}`).sort().join('|')

  // "Keep working until stopped" mode (read LIVE so Brooke's keep_working lever can toggle it mid-run).
  const continuous = (): boolean => seams.isContinuous?.() ?? false
  const idlePollMs = opts.idlePollMs ?? 4000
  const abortableDelay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve()
      const id = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => { clearTimeout(id); resolve() }, { once: true })
    })
  // Continuous-mode idle: the board is fully done and the meeting found nothing — stay on-call, polling for new work
  // (a fresh goal/ticket from the user or Brooke) until either work reappears or the user stops the team.
  const idleUntilWorkOrStop = async (prevSig: string): Promise<'work' | 'stopped'> => {
    deps.emit?.({ kind: 'hermes-state', state: 'paused' })
    while (!signal?.aborted) {
      if (isPaused()) await waitWhilePaused(signal)
      await abortableDelay(idlePollMs)
      if (signal?.aborted) break
      const b = await getState(project)
      if (b.some((t) => t.status !== 'done' && t.status !== 'cancelled') || sigOf(b) !== prevSig) return 'work'
    }
    return 'stopped'
  }

  // L2 self-heal state (run-scoped): the park tracker counts re-entries into the parked set (thrash the
  // board-signature stuck-guard misses), originalIds tells churn from the planned tickets, and resolvedConcepts
  // latches a concept once it has been decided so a Decision Record can't re-trigger.
  const parkTracker = createParkTracker()
  const originalIds = new Set(ids)
  const resolvedConcepts = new Set<string>()
  let improveRounds = 0
  let stuckRounds = 0
  let lastSig = ''
  let round = 0
  while (continuous() || round < maxRounds) {
    // Pause gate (C1): hold the WHOLE cycle while paused, BEFORE starting any drain — so a pause is not
    // un-paused by the next round's drain.start(). resume() (Brooke or the header button) releases this.
    if (isPaused()) deps.emit?.({ kind: 'hermes-state', state: 'paused' })
    await waitWhilePaused(signal)
    if (signal?.aborted) return { rounds: round, reason: 'stopped', tickets: ids.length, improveRounds }

    deps.emit?.({ kind: 'hermes-state', state: 'draining' })
    await seams.runDrainOnce()

    // If the drain halted because of a pause (not a settle), loop back to the gate WITHOUT spending a round or
    // replanning — otherwise a replan would run mid-pause and the next drain would silently un-pause the team.
    if (isPaused()) {
      deps.emit?.({ kind: 'hermes-state', state: 'paused' })
      continue
    }
    if (signal?.aborted) return { rounds: round, reason: 'stopped', tickets: ids.length, improveRounds }

    const board = await getState(project)
    const sig = sigOf(board)
    round++ // a productive round = one drain that wasn't pause-halted

    // L2 self-heal: BEFORE replanning, detect concept-level THRASH (a ticket re-parking, the replan piling
    // overlapping tickets onto one undecided question — the godkveld deck-exhaustion failure) and RULE ONCE with a
    // Decision Record instead of relitigating it for hours. The board-signature stuck-guard below can't see this:
    // the signature changes every round even as the team makes no real progress.
    parkTracker.observe(seams.getParked())
    if (!signal?.aborted) {
      const addedIds = board.filter((t) => !originalIds.has(t.id)).map((t) => t.id)
      const contested = detectContestedConcepts(board, { parkEpisodes: parkTracker.episodes(), addedIds }).filter(
        (c) => !resolvedConcepts.has(c.label)
      )
      if (contested.length) {
        const concept = contested[0]!
        resolvedConcepts.add(concept.label) // latch FIRST so a heal that itself churns can't recurse on it
        deps.emit?.({ kind: 'notice', text: `Thrash detected on "${concept.label}" — ${concept.reason}. Ruling once instead of relitigating.` })
        const res = await resolveContestedConcept(concept, board, goal, plan.spec, project, config, deps, io, signal)
        if (res.healed) {
          parkTracker.forget([...res.cancelledIds, ...concept.ticketIds]) // resolved → drop its park history
          lastSig = '' // board changed (cancels + apply-ticket) → re-drain rather than replan on top
          continue
        }
      }
    }

    if (allSettled(board)) {
      // Continuous "keep working until stopped" mode: never terminate on the improve cap or on completion. When the
      // board drains, convene a MANAGER MEETING (each present department lead proposes the next improvements). If the
      // meeting produces work, apply it and keep going; if every area is solid, idle ON-CALL until new work appears
      // or the user stops. Only a Stop ends the run.
      if (continuous()) {
        improveRounds++
        deps.emit?.({ kind: 'hermes-state', state: 'improving' })
        deps.emit?.({ kind: 'notice', text: 'Board drained — convening a manager meeting for the next improvements.' })
        const meeting = await runManagerMeeting(goal, plan.spec, board, config.cwd, config, deps, signal)
        if (signal?.aborted) return { rounds: round, reason: 'stopped', tickets: board.length, improveRounds }
        if (!isEmptyExceptCancel(meeting)) {
          const applied = await applySafe(meeting, 'meeting', board)
          deps.emit?.({ kind: 'hermes-round', phase: 'improve', round, added: applied.added, reopened: applied.reopened, note: meeting.note })
          deps.emit?.({ kind: 'notice', text: `Manager meeting added ${applied.added} improvement(s) — continuing.` })
          lastSig = sig
          continue
        }
        deps.emit?.({ kind: 'notice', text: 'Every department reports its area is solid — team idling on-call. Stop to end, or give a new goal/ticket.' })
        if ((await idleUntilWorkOrStop(sig)) === 'stopped') return { rounds: round, reason: 'stopped', tickets: board.length, improveRounds }
        lastSig = '' // new work appeared → re-drain
        continue
      }
      // Board fully drained. Rather than stop, the critic (lead reviewer) reviews the actual project and files
      // follow-up improvement tickets — a continuous improve loop that ends only when nothing worthwhile is
      // left or the improve budget is spent.
      if (improveRounds >= maxImprove) {
        // Budget spent. If the assembled app is still unverified (unwired modules / no integration test), report
        // needs-integration rather than a clean improve-cap — a "done board" is not a working product.
        const v = runIntegrationCheck(config, deps, board)
        if (!v.ok) deps.emit?.({ kind: 'notice', text: `Improve budget spent but the app is unverified — ${v.detail}` })
        return { rounds: round, reason: v.ok ? 'improve-cap' : 'needs-integration', tickets: board.length, improveRounds }
      }
      improveRounds++
      deps.emit?.({ kind: 'hermes-state', state: 'improving' })
      const critique = await runCritic(goal, plan.spec, board, config.cwd, config, deps, signal)
      if (isEmptyExceptCancel(critique)) {
        // The critic is satisfied — but only `complete` if the ASSEMBLED app is actually verified. An unwired module
        // or a missing integration test means "every slice passed but the whole is broken" (the blank-screen failure).
        const v = runIntegrationCheck(config, deps, board)
        if (v.ok) return { rounds: round, reason: 'complete', tickets: board.length, improveRounds }
        // Not verified: file a blocking wire-up + integration-test ticket (unless one is already open) and keep going.
        const fixOpen = board.some((t) => /wire[\s-]?up \+ integration/i.test(t.title) && t.status !== 'done' && t.status !== 'cancelled')
        if (!fixOpen)
          await io.addTicket({
            project,
            title: 'Wire-up + integration-test the assembled app',
            body: withRoleBanner(
              'implementation',
              `The assembled app is unverified: ${v.detail}\n\nMake the top-level entry (main/scene/app) instantiate and USE every module (load assets via a real preload), and add a HEADLESS integration test that boots the assembled app and asserts it actually does something (the display list is non-empty / the entry exercises each module). The check is \`npm test\`.`
            ),
            check: 'npm test',
            deps: [],
            priority: 50,
            spec_ref: `board:${project}`
          })
        deps.emit?.({ kind: 'notice', text: `Not complete — ${v.detail} Filed a wire-up + integration-test fix; continuing.` })
        lastSig = sig
        continue
      }
      const applied = await applySafe(critique, 'critic', board)
      deps.emit?.({ kind: 'hermes-round', phase: 'improve', round, added: applied.added, reopened: applied.reopened, note: critique.note })
      deps.emit?.({ kind: 'notice', text: `Improve round ${improveRounds}/${maxImprove}: critic added ${applied.added}, reopened ${applied.reopened} — ${critique.note || 'no note'}` })
      lastSig = sig
      continue
    }

    // Board still has open work: replan the remaining graph (add discovered work, reopen review).
    deps.emit?.({ kind: 'hermes-state', state: 'replanning' })
    const diff = await runReplan(goal, plan.spec, board, seams.getParked(), config, deps, signal, seams.getParkedReasons?.())
    if (!isEmptyExceptCancel(diff)) {
      const applied = await applySafe(diff, 'replan', board)
      if (applied.added > 0 || applied.reopened > 0) {
        deps.emit?.({ kind: 'hermes-round', phase: 'replan', round, added: applied.added, reopened: applied.reopened, note: diff.note })
        deps.emit?.({ kind: 'notice', text: `Replan round ${round}: +${applied.added} added, ${applied.reopened} reopened — ${diff.note || 'no note'}` })
        lastSig = sig
        continue
      }
      // The replan proposed only work already on the board (every add deduped → nothing applied). Don't spin to
      // max-rounds re-proposing the same plan: fall through to the stuck handling so a replan that can't make REAL
      // progress ends (this is what turned an infra failure — workers can't run — into endless replanning).
      deps.emit?.({ kind: 'notice', text: `Replan round ${round}: only duplicates of existing work — nothing to apply.` })
    }

    // Replan found nothing to add. There is still open (usually blocked) work, so DON'T stop just because one
    // replan was empty — keep managing while the board is still changing (a long ticket finishing, a dep
    // unblocking, file_finding adding implementation tickets all show up as a changed signature → re-drain).
    // Only stop when a full round leaves the board unchanged AND the replan is empty: genuinely stuck (e.g. a
    // parked ticket the model can't split), so hand off rather than spin forever.
    if (sig === lastSig) {
      // Genuinely stuck. Before giving up, hand it to the MANAGER to intervene (B) — cancel a ticket parked on a
      // broken check + re-file it, reopen a blocked one, or escalate to the user. Re-drain if she changed the
      // board; cap the rounds so a never-resolving stick can't loop forever.
      if (seams.interveneOnStuck && stuckRounds < maxStuck) {
        stuckRounds++
        const stuck = board
          .filter((t) => t.status !== 'done' && t.status !== 'cancelled')
          .map((t) => ({ id: t.id, title: t.title, check: t.check ?? null, status: t.status }))
        deps.emit?.({ kind: 'notice', text: `Stuck — asking the manager to intervene (${stuckRounds}/${maxStuck}).` })
        await seams.interveneOnStuck(stuck)
        const after = await getState(project)
        if (sigOf(after) !== sig) {
          lastSig = '' // the manager changed the board — re-drain (don't immediately re-trip the stuck path)
          continue
        }
      }
      if (continuous()) {
        deps.emit?.({ kind: 'notice', text: 'No automatic progress right now — idling on-call (keep-working mode). Stop to end, or add work to unblock.' })
        if ((await idleUntilWorkOrStop(sig)) === 'stopped') return { rounds: round, reason: 'stopped', tickets: board.length, improveRounds }
        lastSig = '' // new work appeared → re-drain
        continue
      }
      const leftover = board.filter((t) => t.status !== 'done' && t.status !== 'cancelled').length
      deps.emit?.({ kind: 'notice', text: `Hermes finished best-effort: ${leftover} ticket(s) left parked as unresolvable (their checks can't pass within scope); everything else is done. Review the parked tickets if you want them addressed.` })
      return { rounds: round, reason: 'replan-empty', tickets: board.length, improveRounds }
    }
    lastSig = sig
  }
  const board = await getState(project)
  return { rounds: maxRounds, reason: 'max-rounds', tickets: board.length, improveRounds }
}

/* ----- P0: Brooke owns a rich, contract-complete spec (the source of truth the lazy build reads) ----- */

/** The rich spec Brooke owns: a goal turned into DECIDED cross-module contracts + interfaces + acceptance, so no
 *  node downstream has to GUESS a boundary (an undecided contract is what fragments a build into thrash). */
export interface RichSpec {
  goal: string
  scope: string
  /** The decided cross-module boundary rules (resource exhaustion, error propagation, shared-state ownership, …). */
  contracts: string[]
  /** Key public interfaces / module seams the pieces agree on (also pre-marks the likely split seams). */
  interfaces: string[]
  acceptance: string[]
  /** The single command that verifies the WHOLE goal is done (npm test / npx vitest run / …). The gate the
   *  coarse "build the whole thing" attempt must make pass. */
  check: string
  /** Rendered markdown — the human/worker-facing spec a coarse attempt carries. */
  markdown: string
}

const DRAFT_SPEC_SYSTEM = [
  'You are the LEAD ARCHITECT drafting a RICH, CONTRACT-COMPLETE SPEC from a user goal. This spec is the single',
  'source of truth the build reads — its job is to DECIDE every cross-module contract UP FRONT so nobody downstream',
  'has to guess. An undecided boundary is exactly what causes rework and hallucination.',
  '',
  'Output RULES — obey exactly:',
  '- Respond with ONE JSON object, nothing else:',
  '  {"scope": string, "contracts": string[], "interfaces": string[], "acceptance": string[], "check": string}',
  '- "scope": 1-3 sentences — what is in and out of scope.',
  '- "contracts": the CROSS-MODULE BOUNDARY DECISIONS, each a single DECIDED rule (never an open question). Cover at',
  '  least resource exhaustion / empty / end-of-input, error & failure propagation, and shared-state ownership. Decide',
  '  ONE design — e.g. "Deck.deal() returns null when empty and never auto-resets; callers create a fresh Deck (Deck',
  '  owns no multi-round state)". Do NOT list alternatives.',
  '- "interfaces": the key public interfaces / module seams (short signatures or descriptions) the pieces agree on.',
  '- "acceptance": concrete, checkable acceptance criteria for the whole goal.',
  '- "check": the SINGLE PowerShell-portable command that verifies the whole goal is done (npm test / npx vitest run /',
  '  pytest / npm run build) — never bash. This is the gate the coarse "build the whole thing" attempt must make pass.',
  '- Be concrete and final. A decided spec keeps the build from fragmenting.'
].join('\n')

/** Render a RichSpec to the markdown a worker/board sees. */
function renderSpecMarkdown(s: Omit<RichSpec, 'markdown'>): string {
  const section = (title: string, items: string[]): string =>
    items.length ? `\n\n## ${title}\n${items.map((i) => `- ${i}`).join('\n')}` : ''
  return `# ${s.goal.trim()}${s.scope ? `\n\n${s.scope.trim()}` : ''}${section('Contracts (decided up front)', s.contracts)}${section('Interfaces', s.interfaces)}${section('Acceptance', s.acceptance)}`.trim()
}

/**
 * Brooke drafts the rich, contract-complete spec she will own — a planner turn that turns the goal into DECIDED
 * cross-module contracts. Best-effort: a failed/garbage turn degrades to a minimal spec wrapping the goal (the run
 * continues; it just has fewer pre-decided contracts), NEVER throws. Seam-injected (deps.complete) → unit-testable.
 */
export async function draftRichSpec(goal: string, config: LoopConfig, deps: OrchestratorDeps, signal?: AbortSignal): Promise<RichSpec> {
  const build = (parts: Omit<RichSpec, 'markdown'>): RichSpec => ({ ...parts, markdown: renderSpecMarkdown(parts) })
  const fallback = (): RichSpec => build({ goal, scope: '', contracts: [], interfaces: [], acceptance: [], check: 'npm test' })

  const text = await complete(
    config,
    deps,
    [
      { role: 'system', content: craftSystem(DRAFT_SPEC_SYSTEM) }, // P3 warm-start: Brooke's memory enriches the spec
      { role: 'user', content: `# Goal\n${goal.trim()}\n\nDraft the rich, contract-complete spec as JSON.` }
    ],
    signal
  ).catch(() => '')

  const raw = extractJsonObject(text)
  if (!raw) return fallback()
  let o: Record<string, unknown>
  try {
    o = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return fallback()
  }
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim()) : []
  let check = 'npm test'
  const ck = typeof o.check === 'string' ? o.check.trim() : ''
  if (ck && validateCheck(ck).ok) check = ck
  else if (ck) {
    const rw = rewriteCheck(ck)
    if (rw && validateCheck(rw).ok) check = rw
  }
  return build({
    goal,
    scope: typeof o.scope === 'string' ? o.scope.trim() : '',
    contracts: arr(o.contracts),
    interfaces: arr(o.interfaces),
    acceptance: arr(o.acceptance),
    check
  })
}

/* ----- P2: when a coarse node PARKS, split it into contract-coherent slices (or escalate at the contract floor) ----- */

interface SplitChild {
  title: string
  body: string
  check?: string
}
interface SplitResult {
  escalate: boolean
  reason: string
  children: SplitChild[]
}

const SPLIT_NODE_SYSTEM = [
  'You are the TECH LEAD splitting a PARKED build node — a node that could not be completed in one pass because it',
  'is too big or mixes concerns. Carve it into CONTRACT-COHERENT slices: each slice owns a coherent piece, and any',
  'shared contract is assigned to EXACTLY ONE slice so no slice has to GUESS it. NEVER split THROUGH a contract.',
  '',
  'You are given the SPEC (with its decided contracts), the parked node, and WHY it parked. Output RULES — obey exactly:',
  '- Respond with ONE JSON object: {"escalate": boolean, "reason": string, "children": [{"title","body","check"}]}',
  '- If the node CANNOT be broken into >=2 coherent slices without cutting through a contract (the CONTRACT FLOOR),',
  '  set "escalate": true, a short "reason", and "children": [] — it is handed to a human / stronger model intact.',
  '- Otherwise set "escalate": false and give >=2 children. Each child: a focused "title", a "body" describing',
  '  exactly what to build (honoring the spec contracts), and a real PowerShell-portable "check" (npm test / npx',
  '  vitest run / pytest / npx tsc --noEmit) — never bash. Slices must be INDEPENDENTLY buildable (no slice depends',
  '  on another finishing first); the assembled whole is verified separately.',
  '- "reason": one sentence naming the seam you cut along.'
].join('\n')

function buildSplitUser(node: { title: string; body?: string }, parkReason: string, spec: RichSpec): string {
  return `# Spec\n${spec.markdown}\n\n# Parked node\n${node.title}\n${(node.body ?? '').replace(/\s+/g, ' ').slice(0, 600)}\n\n# Why it parked\n${parkReason}\n\nCarve it into contract-coherent slices, or escalate at the contract floor. Return the split JSON.`
}

function parseSplit(text: string): SplitResult | null {
  const raw = extractJsonObject(text)
  if (!raw) return null
  let o: Record<string, unknown>
  try {
    o = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  const children = Array.isArray(o.children)
    ? o.children
        .filter((c): c is Record<string, unknown> => !!c && typeof (c as Record<string, unknown>).title === 'string' && String((c as Record<string, unknown>).title).trim().length > 0)
        .map((c) => ({ title: String(c.title).trim(), body: typeof c.body === 'string' ? c.body : '', check: typeof c.check === 'string' ? c.check : undefined }))
    : []
  // Fewer than 2 coherent slices = nothing useful to carve → treat as the contract floor (escalate, don't mangle).
  const escalate = o.escalate === true || children.length < 2
  return { escalate, reason: typeof o.reason === 'string' ? o.reason.trim() : '', children: escalate ? [] : children }
}

/** Split a parked node into contract-coherent slices, or escalate at the contract floor. A failed/garbage turn
 *  escalates (hold the node intact rather than mangle it) — best-effort, never throws. Seam-injected → testable. */
export async function splitParkedNode(node: BoardTicketRow, parkReason: string, spec: RichSpec, config: LoopConfig, deps: OrchestratorDeps, signal?: AbortSignal): Promise<SplitResult> {
  const text = await complete(
    config,
    deps,
    [
      { role: 'system', content: SPLIT_NODE_SYSTEM },
      { role: 'user', content: buildSplitUser(node, parkReason, spec) }
    ],
    signal
  ).catch(() => '')
  return parseSplit(text) ?? { escalate: true, reason: 'split turn unavailable', children: [] }
}

/** A status signature of the board — "still making progress" vs "stuck" for the lazy loop. */
const boardSig = (b: BoardTicketRow[]): string => b.map((t) => `${t.id}:${t.status}`).sort().join('|')

/** P3: fold the run's SHAPE into Brooke's cross-project memory so future similar goals warm-start at the right
 *  grain — a one-pass goal teaches "don't over-split this size", a split teaches the seams to plan up front. Flat
 *  lessons (Brooke judges the match when she reads them); memory PROPOSES, the next run's execution DISPOSES. */
function recordRunShape(goal: string, seams: string[]): void {
  const tag = goal.trim().replace(/\s+/g, ' ').slice(0, 60)
  if (seams.length === 0) appendManagerMemory(`- Grain: a "${tag}"-style goal fit ONE coarse pass — attempt the whole thing first, don't over-split this size.`)
  else appendManagerMemory(`- Seam: a "${tag}"-style goal needed splitting along: ${seams.join('; ')}. Plan those slices and their contracts up front next time.`)
}

/**
 * Manager-owned, lazy/split-on-failure orchestration (SPEC-manager-owned-orchestration.md). Brooke drafts a rich,
 * contract-complete spec (P0), then attempts the WHOLE goal as ONE coarse ticket (P1): the verify gate marks it
 * `complete` (it fit one pass) or, when it parks (can't converge = too big), it is SPLIT into contract-coherent
 * slices that recurse the same way (P2) — the integration gate reassembles the whole; a node at the contract floor
 * is escalated, not mangled. P3 will warm-start the grain from memory. Reachable only behind the lazyDecompose flag.
 */
export async function runHermesLazy(
  goal: string,
  project: string,
  config: LoopConfig,
  deps: OrchestratorDeps,
  seams: HermesSeams,
  opts: Parameters<typeof runHermes>[5] = {}
): Promise<HermesResult> {
  const signal = opts.signal
  const io = deps.io ?? liveBoardIO
  const getState = seams.getBoardState ?? ((p: string) => fetchTickets(p))
  const maxRounds = opts.maxRounds ?? 12

  // P0: Brooke drafts the rich, contract-complete spec she OWNS (the single source of truth every node reads).
  deps.emit?.({ kind: 'hermes-state', state: 'planning' }) // W5a: the lazy path speaks the same typed events as eager
  const spec = await draftRichSpec(goal, config, deps, signal)
  await io.setSpec(project, spec.markdown)
  deps.emit?.({
    kind: 'notice',
    text: `Manager-owned (lazy): drafted a rich spec with ${spec.contracts.length} decided contract(s) — attempting the whole goal as ONE coarse ticket.`
  })
  if (signal?.aborted) return { rounds: 0, reason: 'stopped', tickets: 0, improveRounds: 0 }

  // P1: seed ONE coarse root ticket ("build the whole thing").
  await io.addTicket({
    project,
    title: `Build: ${goal.trim()}`.slice(0, 200),
    body: withRoleBanner('implementation', `${spec.markdown}\n\n---\nBuild the WHOLE thing in one coherent pass. Honor every contract above.`),
    check: spec.check,
    deps: [],
    priority: 1,
    spec_ref: `board:${project}`
  })
  deps.emit?.({ kind: 'hermes-round', phase: 'decompose', round: 0, tickets: 1, note: 'one coarse root — the grain is discovered by attempting' })
  deps.emit?.({ kind: 'hermes-state', state: 'draining' })

  // P2: attempt → if a node PARKS (too big to converge), split it into contract-coherent slices and recurse. The
  // board's dependency machinery + the integration gate reassemble the whole; a node that can't be split without
  // cutting a contract (the contract floor) is held/escalated rather than mangled.
  const contractsBlock = spec.contracts.length ? `\n\n## Contracts (honor exactly)\n${spec.contracts.map((c) => `- ${c}`).join('\n')}` : ''
  const escalated = new Set<number>()
  const splitSeams: string[] = [] // P3: the seams this run split along — folded into memory at the end.
  let lastSig = ''
  let round = 0
  while (round < maxRounds) {
    if (signal?.aborted) return { rounds: round, reason: 'stopped', tickets: (await getState(project)).length, improveRounds: 0 }
    await seams.runDrainOnce()
    const board = await getState(project)
    round++
    const open = board.filter((t) => t.status !== 'done' && t.status !== 'cancelled')

    if (open.length === 0) {
      // Every slice is done — verify the ASSEMBLED whole (reuse the eager integration gate).
      const v = runIntegrationCheck(config, deps, board)
      if (v.ok) {
        recordRunShape(goal, splitSeams) // P3: teach the next run the grain that worked (one-pass) / the seams that split.
        deps.emit?.({ kind: 'notice', text: 'Lazy build complete — every slice assembled and the whole verifies.' })
        deps.emit?.({ kind: 'hermes-state', state: 'done' })
        return { rounds: round, reason: 'complete', tickets: board.length, improveRounds: 0 }
      }
      // Slices built but not wired together — file ONE wire-up + integration node (unless one is already open).
      const wireOpen = board.some((t) => /wire[\s-]?up \+ integration/i.test(t.title) && t.status !== 'done' && t.status !== 'cancelled')
      if (!wireOpen) {
        await io.addTicket({
          project,
          title: 'Wire-up + integration-test the assembled app',
          body: withRoleBanner('implementation', `The slices are built but unverified: ${v.detail}\n\nWire them into the top-level entry and add a headless integration test that boots the assembled app and asserts it works.${contractsBlock}`),
          check: spec.check,
          deps: [],
          priority: 50,
          spec_ref: `board:${project}`
        })
        deps.emit?.({ kind: 'notice', text: `Slices built but unverified — ${v.detail} Filed a wire-up + integration node.` })
        deps.emit?.({ kind: 'hermes-round', phase: 'replan', round, added: 1, reopened: 0, note: 'wire-up + integration node' })
        lastSig = ''
        continue
      }
    }

    // Split any PARKED node (couldn't converge = too big) we haven't already escalated.
    const parked = seams.getParked().filter((id) => !escalated.has(id) && open.some((t) => t.id === id))
    let acted = false
    for (const id of parked) {
      const node = board.find((t) => t.id === id)
      if (!node) continue
      const reason = seams.getParkedReasons?.()[id] ?? 'could not converge in one pass'
      const split = await splitParkedNode(node, reason, spec, config, deps, signal)
      if (split.escalate) {
        escalated.add(id)
        deps.emit?.({ kind: 'notice', text: `Node #${id} "${node.title}" is at the CONTRACT FLOOR — held for a human / stronger model (${split.reason || reason}).` })
        continue
      }
      await io.setStatus(id, 'cancelled', `split into ${split.children.length} contract-coherent slice(s)`)
      for (const c of split.children) {
        await io.addTicket({
          project,
          title: c.title.slice(0, 200),
          body: withRoleBanner('implementation', `${c.body}${contractsBlock}`),
          check: pickHealCheck(c.check, [node]),
          deps: [],
          priority: 2,
          spec_ref: `board:${project}`
        })
      }
      acted = true
      splitSeams.push(split.reason || 'unnamed seam')
      deps.emit?.({ kind: 'notice', text: `Split #${id} "${node.title}" into ${split.children.length} contract-coherent slice(s) — ${split.reason || 'carved along the contract seam'}.` })
      deps.emit?.({ kind: 'hermes-round', phase: 'split', round, added: split.children.length, note: `#${id} "${node.title}" → ${split.reason || 'contract seam'}` })
    }

    const sig = boardSig(board)
    if (!acted && sig === lastSig) {
      // No progress and nothing left we can split → stop. needs-split if anything is held at the contract floor.
      const reason: HermesResult['reason'] = escalated.size > 0 ? 'needs-split' : 'needs-integration'
      deps.emit?.({ kind: 'notice', text: `Lazy build stalled: ${open.length} open node(s)${escalated.size ? `, ${escalated.size} held at the contract floor` : ''}.` })
      deps.emit?.({ kind: 'hermes-state', state: 'done' })
      return { rounds: round, reason, tickets: board.length, improveRounds: 0 }
    }
    lastSig = sig
  }
  const finalBoard = await getState(project)
  deps.emit?.({ kind: 'hermes-state', state: 'done' })
  return { rounds: maxRounds, reason: 'max-rounds', tickets: finalBoard.length, improveRounds: 0 }
}
