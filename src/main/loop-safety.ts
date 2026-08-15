// Pure safety helpers for the Loop runner â€” no electron / git imports, so they unit-test headless
// (mirrors the git-util.ts / git-util.test.ts split).

export interface LoopCaps {
  maxTickets: number
  tokenBudget: number
  wallClockMs: number
  maxConsecutiveFailures: number
}

export interface RunCounters {
  ticketsDone: number
  tokensUsed: number
  startedAt: number
  consecutiveFailures: number
}

export type CapStop = null | 'max-tickets' | 'token-budget' | 'wall-clock' | 'consecutive-failures'

/** A run branch name: `board/<slug>-<YYYYMMDD-HHmmss UTC>`. Blank project â†’ slug `run`. */
export function runBranchName(project: string, now: Date = new Date()): string {
  const slug = slugify(project) || 'run'
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  return `board/${slug}-${stamp}`
}

/** The slug transform shared by the run-branch name and the canonical board key. */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * Canonical board/project key — GENTLE normalization: trim ends, lowercase, collapse internal whitespace runs to
 * a single space. A case/whitespace variant ("3D Slicer ", "3d  slicer") therefore attaches to the SAME board
 * ("3d slicer") instead of forking it (mode 6), and the idempotent-decompose guard checks the key the board was
 * written under. It deliberately does NOT slug to dashes or strip punctuation: doing so would CHANGE existing board
 * keys (e.g. live key "3d slicer" -> "3d-slicer", which no board has) and orphan them. A ".N" suffix stays a
 * distinct project (intentional), and all existing keys are preserved — no migration needed. Blank -> "project".
 * (runBranchName uses the harsher dash-slug separately, because a git branch name cannot contain spaces.)
 */
export function canonicalizeProject(project: string): string {
  return project.trim().toLowerCase().replace(/\s+/g, ' ') || 'project'
}

/**
 * The on-disk work folder for a project — the SINGLE source of truth, derived FROM the canonical board key so the
 * work folder, Brooke's cwd, and the board key can never diverge. Previously the folder was derived independently
 * in three places (the run cwd, brookeCwd, and the renderer) from raw-vs-canonical inputs, which silently divorced
 * a project's CODE from its BOARD. Because this canonicalizes FIRST, it is input-invariant: projectFolder(raw) ===
 * projectFolder(canonical). Strips filesystem-illegal characters; lowercasing is inherited from the canonical key,
 * which is safe on case-insensitive Windows (the folder is unchanged) and keeps folder↔key 1:1.
 */
export function projectFolder(project: string): string {
  return canonicalizeProject(project).replace(/[<>:"/\\|?*]+/g, '').replace(/\s+/g, ' ').trim() || 'project'
}

/**
 * Resolve a raid's on-disk working folder. An explicit per-raid override (settings.raidFolders) wins — that's what
 * lets several raids point at ONE real project repo (and the rail group them under it). Otherwise fall back to the
 * unified `<lastCwd | hermesProjectsRoot>/<projectFolder>` derivation. Returns '' when nothing is configured, so the
 * caller can decide its own fallback (the live run uses process.cwd()). Pure (no fs/path) so it unit-tests headless;
 * the override is matched on BOTH the raw and canonical key, so a non-canonical board name still resolves.
 */
export function resolveRaidCwd(
  project: string,
  cfg: { raidFolders?: Record<string, string>; lastCwd?: string | null; hermesProjectsRoot?: string | null }
): string {
  const map = cfg.raidFolders ?? {}
  const mapped = (map[project] ?? map[canonicalizeProject(project)])?.trim()
  if (mapped) return mapped
  const base = (cfg.lastCwd ?? '').trim() || (cfg.hermesProjectsRoot ?? '').trim()
  if (!base) return ''
  const sep = base.includes('\\') ? '\\' : '/'
  return base.replace(/[\\/]+$/, '') + sep + projectFolder(project)
}

/** The FIRST breached cap, checked in order, or null. A non-positive cap value means "no limit" (skipped). */
export function capExceeded(caps: LoopCaps, c: RunCounters, now: number): CapStop {
  if (caps.maxTickets > 0 && c.ticketsDone >= caps.maxTickets) return 'max-tickets'
  if (caps.tokenBudget > 0 && c.tokensUsed >= caps.tokenBudget) return 'token-budget'
  if (caps.wallClockMs > 0 && now - c.startedAt >= caps.wallClockMs) return 'wall-clock'
  if (caps.maxConsecutiveFailures > 0 && c.consecutiveFailures >= caps.maxConsecutiveFailures) return 'consecutive-failures'
  return null
}

const CAP_TO_CAUSE = {
  'max-tickets': 'max-tickets',
  'token-budget': 'max-tokens',
  'wall-clock': 'wall-clock',
  'consecutive-failures': 'max-failures'
} as const

/** Outer-loop stop decision: board-green > paused > caps. `none` means keep draining. */
export type StopDecision =
  | { stop: false; reason: 'none' }
  | { stop: true; reason: 'paused' | 'board-green' | 'max-tickets' | 'max-tokens' | 'wall-clock' | 'max-failures' }

export interface StopInput {
  ready: number
  inProgress: number
  review: number
  ticketsRun: number
  tokensUsed: number
  elapsedMs: number
  consecutiveFailures: number
  caps: LoopCaps
  paused: boolean
}

/** Should the drain stop now, and why? Composes the goal check, the kill switch, and capExceeded. */
export function decideStop(i: StopInput): StopDecision {
  // Goal met: nothing ready, in-flight, or awaiting review â†’ done, even if pause was requested.
  if (i.ready === 0 && i.inProgress === 0 && i.review === 0) return { stop: true, reason: 'board-green' }
  if (i.paused) return { stop: true, reason: 'paused' }
  // Reuse capExceeded by mapping elapsed onto (startedAt 0 â†’ now elapsedMs).
  const cap = capExceeded(
    i.caps,
    { ticketsDone: i.ticketsRun, tokensUsed: i.tokensUsed, startedAt: 0, consecutiveFailures: i.consecutiveFailures },
    i.elapsedMs
  )
  if (cap) return { stop: true, reason: CAP_TO_CAUSE[cap] }
  return { stop: false, reason: 'none' }
}

/**
 * Which `review` tickets to reopen for another autonomous pass (the `includeReview` lever that breaks the
 * "only review tickets left → board-green dead-end"). Excludes anything already reopened this run (so each is
 * tried at most once — no churn) and anything the user set aside (skip). Pure so it unit-tests headless.
 */
export function pickReopenTargets(reviewIds: number[], excluded: Iterable<number>): number[] {
  const ex = new Set(excluded)
  return reviewIds.filter((id) => !ex.has(id))
}

/** Single-line commit message for a ticket (internal title whitespace collapsed). */
export function commitMessage(ticket: { id: number | string; title: string }): string {
  const title = ticket.title.replace(/\s+/g, ' ').trim()
  return `loop: #${ticket.id} ${title}`.trim()
}
