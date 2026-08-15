import { BrowserWindow } from 'electron'
import { IPC, type LoopConfig, type LoopEvent, type LoopStatus, type LoopStopReason, type LoopRunState, type TicketAction, type PlanDecision } from '../../shared/ipc-types'
import { runGit } from '../git'
import { runBranchName, decideStop, commitMessage, pickReopenTargets, type LoopCaps as SafetyCaps } from '../loop-safety'
import { existsSync, writeFileSync, symlinkSync, lstatSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ReviewVerdict } from './boardReview'
import { selectParallelBatch } from './parallelBatch'
import { filesOf } from './specPlan'
import { runPowerShell } from '../shell/powershell'

// The board lives at the same place kanban.ts documents (REST, no MCP client needed).
const BOARD_URL = (process.env.TICKET_BOARD_URL || 'http://127.0.0.1:8930').replace(/\/+$/, '')
const ME = process.env.TICKET_BOARD_ASSIGNEE || 'nordcode'

// Identity for loop commits — set inline so commits never fail on missing global git config, and so the
// loop's machine-authored commits are clearly attributable. Override via env to use your own identity.
const GIT_ID = [
  '-c',
  `user.name=${process.env.TICKET_BOARD_GIT_NAME || 'NordCode Loop'}`,
  '-c',
  `user.email=${process.env.TICKET_BOARD_GIT_EMAIL || 'loop@nordcode.local'}`
]

// Written into a freshly auto-initialized repo BEFORE the baseline commit, so a non-repo folder full of
// dependencies / build output / secrets isn't swept wholesale into git history.
const DEFAULT_GITIGNORE =
  ['node_modules/', 'dist/', 'build/', 'out/', '.next/', '.cache/', '.venv/', '__pycache__/', '.env', '*.env', '*.log', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa', '.DS_Store'].join('\n') + '\n'

// Installing deps can be slow on a cold cache; give it far more headroom than a per-ticket check.
const DEPS_INSTALL_TIMEOUT_MS = 600_000

/** The install command a JS project needs before any typecheck/test can resolve imports — or null when there's
 *  nothing to do (no package.json, or node_modules already present). Package manager is picked from the lockfile.
 *  Pure-ish (reads the filesystem) so the parallel drain can ensure deps ONCE in the run repo before forking
 *  worktrees; without it each worktree pays a cold `npm install` and the check times out (the paralelltesting bug). */
export function depsInstallCommand(cwd: string): string | null {
  if (!existsSync(join(cwd, 'package.json')) || existsSync(join(cwd, 'node_modules'))) return null
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm install'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn install'
  if (existsSync(join(cwd, 'bun.lockb'))) return 'bun install'
  return 'npm install'
}

export interface BoardTicket {
  id: number
  title: string
  body: string
  status: string
  project: string
  check?: string | null
  spec_ref?: string | null
}

export type Terminal = 'done' | 'review' | 'park'
export interface TicketOutcome {
  terminal: Terminal
  /** For park: the one-line reason recorded as the board comment. */
  parkReason?: string
  /** Approx token cost of this ticket (the session's last promptTokens); summed into the token cap. */
  tokens?: number
}

/** Board access seam — production uses fetch; tests inject a fake. */
export interface BoardClient {
  claimNext(project: string): Promise<BoardTicket | null>
  setStatus(id: number, status: string, note?: string): Promise<void>
  summary(project: string): Promise<{ ready: number; in_progress: number; review: number }>
  /** Ids of tickets currently in `review` for a project — drives the includeReview reopen pass. */
  listReview(project: string): Promise<number[]>
}

/** A cancelable in-flight unit — the live per-ticket AgentSession exposes exactly this (loop.ts `cancel()`). */
export interface CancelHandle {
  cancel(): void
}

/** Lets the inner per-ticket runner hand the runner a handle to its live AgentSession, so a per-ticket (or
 *  global) Stop can abort the turn in-flight — not just at the next ticket boundary. Registered when a turn
 *  starts and cleared (null) when it settles. `isCancelled` lets the (multi-attempt) flow bail before
 *  starting another attempt when a Stop landed in the gap between attempts (session momentarily unregistered). */
export interface TicketRunHooks {
  onSession(handle: CancelHandle | null): void
  isCancelled(): boolean
  /** Aborts when this ticket is Stopped (per-ticket OR global) — cancels the in-flight check / reviewer, the
   *  non-session steps that `onSession`'s AgentSession cancel can't reach. */
  signal?: AbortSignal
  /** Plan-gate: block until the user approves/edits/rejects the surfaced plan. Resolves with 'cancel' if a
   *  Stop interrupts the wait (no live session to abort during a human gate). */
  awaitPlanDecision(plan: string): Promise<PlanDecision>
}

class BoardUnreachable extends Error {}

function httpBoardClient(getSignal: () => AbortSignal): BoardClient {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetch(BOARD_URL + path, {
        method,
        signal: getSignal(),
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    } catch (e) {
      throw new BoardUnreachable(`ticket board not reachable at ${BOARD_URL} (${(e as Error).message})`)
    }
    const data = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok) throw new Error((data as { error?: string }).error || `board HTTP ${res.status}`)
    return data
  }
  return {
    claimNext: (project) => call<BoardTicket | null>('POST', '/api/claim-next', { project, assignee: ME }),
    setStatus: async (id, status, note) => {
      await call('POST', `/api/tickets/${id}/status`, { status, note, author: ME })
    },
    summary: (project) => call('GET', `/api/summary?project=${encodeURIComponent(project)}`),
    listReview: async (project) => {
      const rows = await call<{ id: number }[]>('GET', `/api/tickets?project=${encodeURIComponent(project)}&status=review`)
      return rows.map((r) => r.id)
    }
  }
}

/** STUB — replaced by ipc.ts injecting the real per-ticket runner (T4: a fresh AgentSession; T5: the check). */
async function defaultRunTicket(_ticket: BoardTicket, _config: LoopConfig, _hooks: TicketRunHooks, _opts?: { codeOnly?: boolean }): Promise<TicketOutcome> {
  await new Promise((r) => setTimeout(r, 5))
  return { terminal: 'review' }
}

function defaultEmit(e: LoopEvent): void {
  const wc = BrowserWindow.getAllWindows()[0]?.webContents
  if (wc && !wc.isDestroyed()) wc.send(IPC.loopEvent, e)
}

/**
 * The OUTER drain loop: claim the next ready ticket → run it (stub here; T4/T5 make it real) → mark the
 * board → repeat, until a stop condition (board green, a cap, or the user). One in-app singleton runner.
 * The board client, per-ticket runner, and emitter are injectable so the loop's decision logic is unit-tested.
 */
export class BoardRunner {
  makeClient: (getSignal: () => AbortSignal) => BoardClient = httpBoardClient
  runTicket: (t: BoardTicket, config: LoopConfig, hooks: TicketRunHooks, opts?: { codeOnly?: boolean }) => Promise<TicketOutcome> = defaultRunTicket
  /** Review seam for the PARALLEL batch path — runs the reviewer over a worktree cwd, separate from the inline
   *  review, so the coordinator can review code-only results in one swept pass. ipc injects runReview; the default
   *  stub approves so non-wired tests don't block. */
  reviewTicket: (t: BoardTicket, config: LoopConfig) => Promise<ReviewVerdict> = async () => ({ approved: true, feedback: '' })
  /** Free the coder (every non-reviewer role model) before the batched review loads the reviewer — the parallel
   *  path's single code→review swap. ipc injects freeOtherRoleModels(keep=reviewer); default no-op for tests. */
  swapToReviewer: (config: LoopConfig) => Promise<void> = async () => {}
  /** Persist review-rejection feedback to the main raid so a re-queued batch ticket carries it into its sequential
   *  re-run (no feedback lost). ipc injects writeRejectionFeedback; default no-op. */
  saveRejectionFeedback: (cwd: string, ticketId: number, title: string, feedback: string) => void = () => {}
  emit: (e: LoopEvent) => void = defaultEmit
  /** Git seam — production uses runGit; tests inject a no-op so no real branch/commit happens. */
  git: (cwd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> = runGit
  /** Shell seam for non-git commands (e.g. `npm install` in ensureDeps). Production runs PowerShell; tests inject a
   *  no-op so no real install happens. */
  runCmd: (command: string, cwd: string, timeoutMs: number) => Promise<{ code: number | null; timedOut: boolean }> = (command, cwd, timeoutMs) =>
    runPowerShell({ command, cwd, timeoutMs, signal: this.abort?.signal ?? new AbortController().signal })
  /** Write a default .gitignore on auto-init (injectable so tests never touch disk). */
  writeIgnore: (cwd: string, content: string) => void = (cwd, content) => {
    const p = join(cwd, '.gitignore')
    if (!existsSync(p)) writeFileSync(p, content)
  }
  /** Share the run repo's node_modules into a fresh worktree via a junction/symlink, so the batched coder's
   *  typecheck/tests resolve deps without a slow per-worktree `npm install` (node_modules is gitignored, so a
   *  worktree never inherits it from HEAD). Injectable so tests never touch disk; best-effort in production. */
  linkDeps: (runCwd: string, wt: string) => void = (runCwd, wt) => {
    const src = join(runCwd, 'node_modules')
    const dest = join(wt, 'node_modules')
    if (!existsSync(src) || existsSync(dest)) return
    try {
      symlinkSync(src, dest, 'junction') // 'junction' = no admin needed on Windows; type ignored on POSIX (dir symlink)
    } catch {
      /* best-effort: a missing link just falls back to the coder npm-installing in its worktree */
    }
  }
  /** Remove the node_modules junction from a worktree BEFORE git deletes the worktree dir — guards against a
   *  recursive delete following the link into the run repo's real node_modules. Only unlinks an actual symlink/
   *  junction (never a real dir, in case linkDeps fell back to an install). Injectable so tests never touch disk. */
  unlinkDeps: (wt: string) => void = (wt) => {
    const dest = join(wt, 'node_modules')
    try {
      if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) rmSync(dest, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
  /** Tests await this to know the drain finished. */
  loopDone: Promise<void> = Promise.resolve()

  private state: LoopRunState = 'idle'
  private paused = false
  private stopRequested = false
  private abort: AbortController | null = null
  /** The in-flight ticket's cancelable session (set via the runTicket hook), so Stop can abort the turn now. */
  private currentSession: CancelHandle | null = null
  /** Per-ticket abort source for the non-session steps (check + reviewer). Aborted by cancelCurrent() so a
   *  per-ticket or global Stop cancels an in-flight check/reviewer too, not just the agent turn. */
  private currentAbort: AbortController | null = null
  /** Set when the current ticket is cancelled (global Stop or a per-ticket stop on it); cleared per ticket.
   *  Lets the multi-attempt flow bail before a new attempt if Stop landed between attempts (session null). */
  private ticketCancel = false
  /** An open plan-gate awaiting the user's verdict (plan-gate). The IPC resolves it; a Stop cancels it. */
  private pendingPlan: { id: number; resolve: (d: PlanDecision) => void } | null = null
  private project = ''
  private startedAt = 0
  private currentTicket: number | undefined
  private consecutiveFailures = 0
  private claimed = 0
  private done = 0
  private review = 0
  private parked = 0
  private failed = 0
  private tokensUsed = 0
  private runBranch = ''
  private runWorktree = ''
  /** Tickets that hit the attempt cap; the outer loop stops when only these remain (T5). */
  readonly parkedIds = new Set<number>()
  /** Why each parked ticket parked (its terminal park reason) — surfaced to the replanner (R4) so a
   *  "check-broken:" park re-files a corrected check instead of re-attempting the implementation. */
  readonly parkReasons = new Map<number, string>()
  /** Tickets the user explicitly set aside this run (skip); the drain releases them to review, never runs them. */
  readonly skippedIds = new Set<number>()
  /** Review tickets reopened (review → todo) this run by includeReview; each reopened at most once so the
   *  drain converges instead of churning the same review work forever. */
  readonly reopenedFromReview = new Set<number>()
  /** Tickets the drain has already settled this run (done/review/park). Skip refuses these so a stray click on a
   *  finished ticket can't demote it (e.g. done → review) and re-gate its dependents. Retry clears the entry. */
  readonly settledIds = new Set<number>()
  /** Parked tickets that were RE-CLAIMED this run and set aside to review so the drain can keep working OTHER
   *  ready tickets (a low-id parked blocker must not starve independent ready work behind it). Excluded from the
   *  includeReview reopen sweep so a set-aside park isn't immediately reopened into a claim loop. Retry clears it. */
  readonly parkedSetAside = new Set<number>()

  start(config: LoopConfig): { ok: boolean; error?: string } {
    if (this.state === 'running') {
      this.emit({ kind: 'notice', text: 'A run is already in progress.' })
      return { ok: true }
    }
    const resuming = this.state === 'paused'
    this.project = config.project
    this.paused = false
    this.stopRequested = false
    if (!resuming) {
      // Fresh run: reset counters + run identity. A resume keeps them (and the run branch) intact.
      this.startedAt = Date.now()
      this.currentTicket = undefined
      this.consecutiveFailures = 0
      this.claimed = this.done = this.review = this.parked = this.failed = this.tokensUsed = 0
      this.runBranch = ''
      this.runWorktree = ''
      this.currentSession = null
      this.currentAbort = null
      this.ticketCancel = false
      this.pendingPlan = null
      this.parkedIds.clear()
      this.parkReasons.clear()
      this.skippedIds.clear()
      this.settledIds.clear()
      this.parkedSetAside.clear()
      this.reopenedFromReview.clear()
    }
    this.state = 'running'
    this.emit({ kind: 'status', status: this.status() })
    this.loopDone = this.drain(config)
      .catch((e: unknown) => {
        this.emit({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
      })
      .finally(() => {
        this.state = this.state === 'running' ? 'stopped' : this.state
        this.emit({ kind: 'run-stats', status: this.status() })
      })
    return { ok: true }
  }

  pause(): void {
    if (this.state === 'running') this.paused = true
  }

  stop(): void {
    this.stopRequested = true
    this.abort?.abort()
    this.cancelCurrent() // abort the in-flight turn now, not just at the next ticket boundary
  }

  /** Abort the current ticket: cancel its live turn (if any), unblock a plan-gate awaiting a verdict, and raise
   *  the per-ticket cancel flag so the multi-attempt flow bails before a new attempt (Stop in the inter-attempt
   *  gap, or during the human plan gate where there's no live session to abort). */
  private cancelCurrent(): void {
    this.ticketCancel = true
    this.currentSession?.cancel()
    this.currentAbort?.abort() // cut an in-flight check / reviewer (the non-session steps)
    this.resolvePendingPlan({ decision: 'cancel' })
  }

  /** Resolve an open plan-gate (the IPC user verdict, or an internal cancel) and clear it. */
  private resolvePendingPlan(decision: PlanDecision): void {
    const pending = this.pendingPlan
    if (!pending) return
    this.pendingPlan = null
    pending.resolve(decision)
  }

  /** Resolve the plan-gate from the UI (loop:plan-decision). No-op if the id isn't the one awaiting. */
  resolvePlan(id: number, decision: PlanDecision): { ok: boolean } {
    if (this.pendingPlan?.id !== id) return { ok: false }
    this.resolvePendingPlan(decision)
    return { ok: true }
  }

  /**
   * Fine per-ticket control from the UI (loop:ticket-action). The run header's Start/Pause/Stop are the coarse
   * control; these act on ONE ticket:
   *  - pause: pause the whole run (sequential single-worktree drain) at the next boundary.
   *  - stop/skip on the in-flight ticket: cancel its agent turn (the drain releases it to review, then continues).
   *  - skip on a queued ticket: set it aside (board → review) so this run never claims it.
   *  - retry: re-queue a parked/finished ticket (board → todo) for an active drain to pick up again.
   */
  async ticketAction(id: number, action: TicketAction): Promise<{ ok: boolean; error?: string }> {
    try {
      switch (action) {
        case 'pause':
          this.pause()
          return { ok: true }
        case 'stop':
        case 'skip':
          // The current ticket is owned by the drain whether it's mid-turn OR settling (currentSession is
          // briefly null between the turn resolving and the terminal write). In BOTH cases cancel it and let
          // the drain settle it — never route it to skipTicket, which would clobber the terminal the drain is
          // about to write (e.g. done → review) and re-gate its dependents.
          if (this.currentTicket === id) {
            this.cancelCurrent()
            this.emit({ kind: 'notice', text: `#${id} stopped` })
            return { ok: true }
          }
          return await this.skipTicket(id)
        case 'retry': {
          const client = this.makeClient(() => new AbortController().signal)
          await client.setStatus(id, 'todo', 'retry requested')
          this.parkedIds.delete(id)
          this.parkReasons.delete(id)
          this.skippedIds.delete(id)
          this.settledIds.delete(id)
          this.parkedSetAside.delete(id)
          this.emit({ kind: 'notice', text: `#${id} re-queued for retry` })
          return { ok: true }
        }
        default:
          return { ok: false, error: `unknown ticket action: ${action as string}` }
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** Set a queued ticket aside for this run: board → review (claim_next only returns ready todo, so it's no
   *  longer claimable) plus a local skip set as a belt-and-suspenders guard against a board-state race.
   *  Refuses a ticket the drain already settled this run, so a stray click on a finished ticket can't demote it. */
  private async skipTicket(id: number): Promise<{ ok: boolean; error?: string }> {
    if (this.settledIds.has(id)) return { ok: false, error: `#${id} already finished this run — use retry to run it again` }
    const client = this.makeClient(() => new AbortController().signal)
    this.skippedIds.add(id)
    await client.setStatus(id, 'review', 'skipped this run')
    this.emit({ kind: 'notice', text: `#${id} skipped — set aside for review` })
    return { ok: true }
  }

  /** includeReview lever: reopen review tickets (review → todo) for another autonomous pass when the drain has
   *  nothing ready to claim. Each is reopened at most once per run and never a user-skipped ticket. Returns how
   *  many were reopened (0 → the drain finishes board-green as before). Best-effort: a board error reopens none. */
  private async reopenReview(client: BoardClient, project: string): Promise<number> {
    let reviewIds: number[]
    try {
      reviewIds = await client.listReview(project)
    } catch {
      return 0 // board hiccup — fall through to board-green rather than throwing out of the drain
    }
    const targets = pickReopenTargets(reviewIds, [...this.reopenedFromReview, ...this.skippedIds, ...this.parkedSetAside])
    for (const id of targets) {
      try {
        await client.setStatus(id, 'todo', 'reopened from review for another pass (includeReview)')
        this.reopenedFromReview.add(id)
        this.settledIds.delete(id) // it's live again — let the drain settle it afresh
      } catch {
        /* leave it in review; a later pass or a human can pick it up */
      }
    }
    if (this.reopenedFromReview.size) {
      this.emit({ kind: 'notice', text: `Reopened ${targets.length} review ticket(s) for another pass: ${targets.join(', ') || '(none new)'}` })
    }
    return targets.length
  }

  status(): LoopStatus {
    return {
      state: this.state,
      project: this.project || undefined,
      currentTicket: this.currentTicket,
      claimed: this.claimed,
      done: this.done,
      review: this.review,
      parked: this.parked,
      failed: this.failed,
      tokensUsed: this.tokensUsed,
      startedAt: this.startedAt || undefined,
      worktree: this.runWorktree || undefined
    }
  }

  /** Uncommitted diff of the active run's worktree (for the per-ticket detail). Empty when no worktree. */
  async diff(): Promise<string> {
    if (this.runWorktree === '') return ''
    const r = await this.git(this.runWorktree, ['diff'])
    return r.code === 0 ? r.stdout : ''
  }

  private finish(reason: LoopStopReason): void {
    this.state = 'stopped'
    this.emit({ kind: 'stopped', reason })
  }

  /** Release a ticket interrupted by a global Stop back to review. Uses a FRESH board signal because stop()
   *  aborts the drain's shared signal — without this the release write would itself abort, stranding the
   *  ticket in_progress. Best-effort: a missed write just leaves it in_progress for the user to retry. */
  private async releaseStopped(id: number): Promise<void> {
    try {
      await this.makeClient(() => new AbortController().signal).setStatus(id, 'review', 'stopped by user mid-run')
    } catch {
      /* board may be unreachable; stopping anyway */
    }
  }

  /** Commit this ticket's changes on the run branch. "Nothing to commit" is a benign no-op; other git
   *  failures surface in the feed but never abort the run (the ticket already reached its board terminal). */
  private async commitTicket(cwd: string, ticket: BoardTicket): Promise<void> {
    if (this.runBranch === '') return // branchPerRun disabled → leave the working tree to the user
    const add = await this.git(cwd, ['add', '-A'])
    if (add.code !== 0) {
      this.emit({ kind: 'notice', text: `git add failed for #${ticket.id}: ${(add.stderr || add.stdout).trim()}` })
      return
    }
    const commit = await this.git(cwd, [...GIT_ID, 'commit', '-m', commitMessage(ticket)])
    if (commit.code !== 0 && !/nothing to commit|no changes added/i.test(commit.stderr + commit.stdout)) {
      this.emit({ kind: 'notice', text: `git commit failed for #${ticket.id}: ${(commit.stderr || commit.stdout).trim()}` })
    }
  }

  /** Commit whatever is in `cwd`'s working tree to HEAD (best-effort; tolerates an already-clean tree). The parallel
   *  batch calls this before forking worktrees because a worktree can only branch from COMMITTED state — in Hermes
   *  mode commitTicket is a no-op, so prior sequential tickets' work would otherwise be invisible to the worktrees. */
  private async snapshotHead(cwd: string): Promise<void> {
    const add = await this.git(cwd, ['add', '-A'])
    if (add.code !== 0) {
      this.emit({ kind: 'notice', text: `parallel: pre-batch git add failed: ${(add.stderr || add.stdout).trim()}` })
      return
    }
    const commit = await this.git(cwd, [...GIT_ID, 'commit', '-m', 'loop: pre-batch snapshot (assemble prior tickets for worktrees)'])
    if (commit.code !== 0 && !/nothing to commit|no changes added/i.test(commit.stderr + commit.stdout)) {
      this.emit({ kind: 'notice', text: `parallel: pre-batch snapshot commit failed: ${(commit.stderr || commit.stdout).trim()}` })
    }
  }

  /** Install JS deps ONCE in the run repo before forking worktrees, so every worktree's typecheck/test resolves
   *  imports from a shared (junctioned) node_modules instead of each paying a cold `npm install` that blows the
   *  check timeout. No-op when there's no package.json or node_modules already exists. */
  private async ensureDeps(runCwd: string): Promise<void> {
    const cmd = depsInstallCommand(runCwd)
    if (!cmd) return
    this.emit({ kind: 'notice', text: `parallel: installing deps once (${cmd}) so worktree checks resolve imports — first batch only…` })
    const res = await this.runCmd(cmd, runCwd, DEPS_INSTALL_TIMEOUT_MS)
    if (res.code !== 0) {
      this.emit({ kind: 'notice', text: `parallel: ${cmd} exited ${res.code}${res.timedOut ? ' (timed out)' : ''}; worktrees may fall back to a per-tree install` })
    }
  }

  /** Bring ONLY the ticket's DECLARED files from its worktree branch into HEAD (a scoped checkout + commit) instead
   *  of a full merge. Enforces file-disjointness mechanically: a coder's out-of-scope scaffolding (a stray
   *  GameScene.ts written just to satisfy a whole-project check) stays in its worktree and never collides with a
   *  sibling batch ticket. Falls back to a full merge when no files are declared (safety; batched tickets always
   *  declare files). Returns true on success; a failure leaves HEAD clean for the caller to re-queue. */
  private async graduateFiles(runCwd: string, branch: string, ticket: BoardTicket): Promise<boolean> {
    const files = filesOf(ticket.body)
    if (!files.length) {
      const merge = await this.git(runCwd, [...GIT_ID, 'merge', '--no-ff', '--no-edit', branch])
      return merge.code === 0
    }
    const co = await this.git(runCwd, ['checkout', branch, '--', ...files]) // stages the declared files from the branch
    if (co.code !== 0) return false
    await this.git(runCwd, ['add', '--', ...files]) // belt-and-suspenders; checkout already stages
    const commit = await this.git(runCwd, [...GIT_ID, 'commit', '-m', commitMessage(ticket)])
    return commit.code === 0 || /nothing to commit|no changes added/i.test(commit.stdout + commit.stderr)
  }

  /** Ensure cwd is a git repo so the run can branch + commit. If it isn't one anywhere up the tree
   *  (the "not a git repository" dead-end), initialize one and baseline any pre-existing files.
   *
   *  `isolate` (Hermes raids): also re-root when cwd is nested INSIDE a foreign parent repo (its toplevel is an
   *  ancestor, not cwd). Without this, a raid created under a monorepo (e.g. `…/working folder test/<raid>`) shares
   *  that repo, so a review's `git diff` returns the whole monorepo's unrelated changes ("this diff is a 3D Slicer
   *  project") and reviews reject correct work. A nested `git init` gives the raid its OWN repo so diffs scope to it.
   *  Regular worktree sessions pass isolate=false so they branch off the user's existing repo as before. */
  private async ensureRepo(cwd: string, opts: { isolate?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
    const top = await this.git(cwd, ['rev-parse', '--show-toplevel'])
    if (top.code === 0) {
      const norm = (p: string): string => p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      const isOwnRoot = norm(top.stdout) === norm(cwd)
      // Its own repo root → use it. Or, when NOT isolating (regular sessions), a subdir of the user's repo → use
      // that repo. Only isolate re-roots a raid nested inside a FOREIGN parent repo.
      if (isOwnRoot || !opts.isolate) return { ok: true }
      this.emit({ kind: 'notice', text: `raid folder is nested in repo ${top.stdout.trim()} — initializing an isolated git repo so reviews diff only this raid` })
      // fall through to init a nested, isolated repo for this raid
    } else if (top.code !== 128) {
      // runGit returns -1 on git-missing / spawn error / timeout; only git's real "not a work tree" is exit 128.
      // Don't auto-init on -1 — that could nest a repo inside a parent repo when git is merely unavailable.
      return { ok: false, error: `could not determine git status in ${cwd}: ${(top.stderr || top.stdout).trim() || 'git unavailable or timed out'}` }
    }
    const init = await this.git(cwd, ['init'])
    if (init.code !== 0) return { ok: false, error: `git init failed in ${cwd}: ${(init.stderr || init.stdout).trim()}` }
    this.emit({ kind: 'notice', text: `initialized a git repository in ${cwd} for run isolation` })
    // A default .gitignore first, so the baseline doesn't sweep deps/build output/secrets into history.
    this.writeIgnore(cwd, DEFAULT_GITIGNORE)
    const add = await this.git(cwd, ['add', '-A'])
    if (add.code !== 0) return { ok: false, error: `git add (baseline) failed in ${cwd}: ${(add.stderr || add.stdout).trim()}` }
    // --allow-empty so even an empty folder gets a HEAD commit for `git worktree add` to branch from.
    const commit = await this.git(cwd, [...GIT_ID, 'commit', '--allow-empty', '-m', 'loop: baseline (pre-run snapshot)'])
    if (commit.code !== 0) {
      return { ok: false, error: `git baseline commit failed in ${cwd}: ${(commit.stderr || commit.stdout).trim()}` }
    }
    return { ok: true }
  }

  /**
   * PARALLEL batch (parallelism > 1): code N file-disjoint IMPLEMENTATION tickets CONCURRENTLY — each in its own git
   * worktree branched off the run's HEAD, so the coder stays resident (no per-ticket review swap). Then review them
   * SEQUENTIALLY (one swap to the reviewer) and MERGE the approved worktrees back. A rejected/failed ticket is
   * re-queued to `todo` with its review feedback persisted to the MAIN raid (no feedback lost) to be revised on the
   * normal sequential path. Runs in `runCwd` (the raid repo). Best-effort: a worktree/merge failure degrades that ONE
   * ticket to a sequential re-run, never breaks the batch.
   */
  private async runParallelBatch(batch: BoardTicket[], config: LoopConfig, runCwd: string, client: BoardClient): Promise<void> {
    this.emit({ kind: 'notice', text: `parallel: coding ${batch.length} tickets at once — ${batch.map((t) => '#' + t.id).join(', ')}` })
    batch.forEach((t) => this.emit({ kind: 'ticket-started', id: t.id, title: t.title }))
    this.emit({ kind: 'run-stats', status: this.status() })

    // Worktrees can only inherit COMMITTED state. In Hermes mode commitTicket is a no-op (runBranch===''), so the
    // scaffold/types/etc. produced by prior sequential tickets sit UNCOMMITTED in runCwd. Snapshot them into HEAD
    // now — otherwise every worktree forks from the empty baseline and the coders thrash rebuilding the missing
    // project. (Also guarantees a clean tree so graduating each worktree's files applies without conflict.)
    await this.snapshotHead(runCwd)
    // Deps in the run repo ONCE → linkDeps shares them into every worktree → checks resolve imports fast instead of
    // each worktree paying a cold install that times out the check (the paralelltesting failure).
    await this.ensureDeps(runCwd)

    // PHASE 1 — CODE concurrently, each in its OWN worktree off the current HEAD (all branch off the same HEAD).
    type Coded = { ticket: BoardTicket; branch: string; wt: string; coded: boolean; tokens: number }
    const coded: Coded[] = await Promise.all(
      batch.map(async (ticket): Promise<Coded> => {
        const branch = `${runBranchName(config.project)}-t${ticket.id}`
        const wt = join(tmpdir(), branch.replace(/\//g, '-'))
        const add = await this.git(runCwd, ['worktree', 'add', '-b', branch, wt, 'HEAD'])
        if (add.code !== 0) {
          this.emit({ kind: 'notice', text: `parallel: worktree for #${ticket.id} failed — will run it sequentially` })
          return { ticket, branch: '', wt: '', coded: false, tokens: 0 }
        }
        this.linkDeps(runCwd, wt) // share node_modules so the worktree's typecheck/tests resolve deps (no reinstall)
        try {
          const outcome = await this.runTicket(
            ticket,
            { ...config, cwd: wt },
            { onSession: () => {}, isCancelled: () => this.stopRequested, signal: this.abort?.signal ?? new AbortController().signal, awaitPlanDecision: () => Promise.resolve({ decision: 'approve' } as PlanDecision) },
            { codeOnly: true }
          )
          const ok = outcome.terminal === 'review' // code-only success (coded + check passed)
          if (ok) await this.commitTicket(wt, ticket)
          return { ticket, branch, wt, coded: ok, tokens: outcome.tokens ?? 0 }
        } catch (e) {
          this.emit({ kind: 'notice', text: `parallel: #${ticket.id} coding errored (${e instanceof Error ? e.message : String(e)})` })
          return { ticket, branch, wt, coded: false, tokens: 0 }
        }
      })
    )

    // PHASE 2/3 — REVIEW each sequentially (one swap), MERGE approved, re-queue the rest WITH feedback.
    // ONE swap: free the coder FIRST so the reviewer doesn't load on top of the still-resident 35B (they can't
    // co-reside on the GPU). runReview only LOADS the reviewer — it relies on the caller having freed the worker
    // (the sequential path does this via boardFlow; the parallel path must do it here).
    if (coded.some((c) => c.coded) && !this.stopRequested) await this.swapToReviewer(config)
    for (const c of coded) {
      this.tokensUsed += c.tokens
      if (this.stopRequested || !c.coded) {
        await this.dropWorktree(runCwd, c.branch, c.wt)
        await this.requeue(client, c.ticket.id, this.stopRequested ? 'released — run stopped' : 'parallel: code/check did not pass — re-queued for a sequential attempt')
        if (!this.stopRequested) this.consecutiveFailures++
        continue
      }
      let verdict: ReviewVerdict
      try {
        verdict = await this.reviewTicket(c.ticket, { ...config, cwd: c.wt })
      } catch {
        verdict = { approved: false, feedback: '(reviewer error)', unreachable: true }
      }
      if (verdict.approved) {
        // Graduate ONLY the declared files (not a full merge), so a coder's out-of-scope scaffolding can't collide
        // with a sibling ticket. Disjoint file sets → this can never conflict.
        const graduated = await this.graduateFiles(runCwd, c.branch, c.ticket)
        if (graduated) {
          await this.dropWorktree(runCwd, c.branch, c.wt)
          this.consecutiveFailures = 0
          this.settledIds.add(c.ticket.id)
          try { await client.setStatus(c.ticket.id, 'done') } catch { /* board lag */ }
          this.done++
          this.emit({ kind: 'ticket-done', id: c.ticket.id, terminal: 'done' })
        } else {
          await this.git(runCwd, ['reset', '--hard', 'HEAD']) // clean any partial checkout so HEAD stays consistent
          await this.dropWorktree(runCwd, c.branch, c.wt)
          await this.requeue(client, c.ticket.id, 'parallel: could not graduate declared files — re-queued for a sequential attempt')
        }
      } else {
        if (verdict.feedback?.trim()) this.saveRejectionFeedback(runCwd, c.ticket.id, c.ticket.title, verdict.feedback)
        await this.dropWorktree(runCwd, c.branch, c.wt)
        await this.requeue(client, c.ticket.id, 'parallel: review requested changes — re-queued (feedback saved for the revise)')
      }
    }
    this.emit({ kind: 'run-stats', status: this.status() })
  }

  /**
   * One parallel ROUND: claim up to `parallelism` ready tickets, pick the largest file-DISJOINT implementation
   * batch, run it via runParallelBatch, and release the rest back to `todo` for the normal sequential path. Returns
   * 'ran' when a batch executed (caller loops again), 'none' when no parallel opportunity exists (caller falls
   * through to the normal single-ticket path). Tickets the sequential path must own (foreign project / skipped /
   * parked) are released immediately.
   */
  private async tryParallelRound(config: LoopConfig, runCwd: string, client: BoardClient): Promise<'ran' | 'none'> {
    const max = config.parallelism ?? 1
    if (max <= 1 || this.stopRequested) return 'none'
    const release = async (id: number): Promise<void> => {
      try {
        await client.setStatus(id, 'todo', 'released — handled on the sequential path')
      } catch {
        /* board lag */
      }
    }
    const claimed: BoardTicket[] = []
    for (let i = 0; i < max; i++) {
      let t: BoardTicket | null = null
      try {
        t = await client.claimNext(config.project)
      } catch {
        break
      }
      if (!t) break
      if (t.project !== config.project || this.skippedIds.has(t.id) || this.parkedIds.has(t.id) || this.settledIds.has(t.id)) {
        await release(t.id)
        continue
      }
      claimed.push(t)
    }
    if (!claimed.length) return 'none'
    const { batch, rest } = selectParallelBatch(claimed, max)
    for (const t of rest) await release(t.id) // re-claimed one-at-a-time by the normal loop
    if (batch.length < 2) return 'none'
    this.claimed += batch.length
    await this.runParallelBatch(batch as BoardTicket[], config, runCwd, client)
    return 'ran'
  }

  /** Re-queue a batch ticket to todo + clear its "working" card. */
  private async requeue(client: BoardClient, id: number, note: string): Promise<void> {
    try {
      await client.setStatus(id, 'todo', note)
    } catch {
      /* board lag — the loop surfaces a persistent board failure elsewhere */
    }
    this.emit({ kind: 'ticket-done', id, terminal: 'review' })
  }

  /** Remove a parallel worktree + its branch (best-effort). */
  private async dropWorktree(runCwd: string, branch: string, wt: string): Promise<void> {
    if (wt) {
      this.unlinkDeps(wt) // drop the node_modules junction first so removal can't follow it into the run repo
      await this.git(runCwd, ['worktree', 'remove', '--force', wt])
    }
    if (branch) await this.git(runCwd, ['branch', '-D', branch])
  }

  private async drain(config: LoopConfig): Promise<void> {
    const ac = new AbortController()
    this.abort = ac
    const client = this.makeClient(() => ac.signal)

    // Isolation: run in a dedicated git WORKTREE branched from HEAD, so the user's folder and any uncommitted
    // work are never touched. Skip when resuming a paused run (the worktree already exists) — reuse it.
    let runCwd = config.cwd
    if (config.branchPerRun !== false && this.runWorktree === '') {
      this.runBranch = runBranchName(config.project)
      const repo = await this.ensureRepo(config.cwd)
      if (!repo.ok) {
        this.emit({ kind: 'error', message: repo.error || `could not prepare a git repository in ${config.cwd}` })
        return this.finish('error')
      }
      const worktree = join(tmpdir(), this.runBranch.replace(/\//g, '-'))
      const wt = await this.git(config.cwd, ['worktree', 'add', '-b', this.runBranch, worktree, 'HEAD'])
      if (wt.code !== 0) {
        this.emit({ kind: 'error', message: `could not create run worktree: ${(wt.stderr || wt.stdout).trim()}` })
        return this.finish('error')
      }
      this.runWorktree = worktree
      runCwd = worktree
      this.emit({ kind: 'notice', text: `running in an isolated worktree on branch ${this.runBranch} — your folder ${config.cwd} is untouched (worktree: ${worktree})` })
    } else if (this.runWorktree !== '') {
      runCwd = this.runWorktree // resuming → reuse the existing worktree
    } else {
      // Hermes (branchPerRun:false): no worktree — work directly in the raid folder. Still ISOLATE it as its own git
      // repo so a review's `git diff` is scoped to THIS raid and not a parent monorepo it happens to be nested in
      // (the "diff is a 3D Slicer project" review failure). Idempotent: once the raid has its own .git, subsequent
      // rounds short-circuit. runs in config.cwd.
      const repo = await this.ensureRepo(config.cwd, { isolate: true })
      if (!repo.ok) {
        this.emit({ kind: 'error', message: repo.error || `could not prepare a git repository in ${config.cwd}` })
        return this.finish('error')
      }
    }
    // All ticket work + commits happen in runCwd (the worktree when isolated, else the folder itself).
    const runConfig: LoopConfig = runCwd === config.cwd ? config : { ...config, cwd: runCwd }

    // Hard caps (T6). config.caps is the canonical shape; map it to capExceeded's inputs once up front.
    const safetyCaps: SafetyCaps = {
      maxTickets: config.caps.maxTickets,
      tokenBudget: config.caps.maxTokens,
      wallClockMs: config.caps.maxWallclockSec * 1000,
      maxConsecutiveFailures: config.caps.maxConsecutiveFailures
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.stopRequested) return this.finish('user')

      // One summary fetch feeds both the goal check (board green) and the cap/pause stop decision.
      let sum
      try {
        sum = await client.summary(config.project)
      } catch (e) {
        this.emit({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
        return this.finish('error')
      }
      const decision = decideStop({
        ready: sum.ready,
        inProgress: sum.in_progress,
        review: sum.review,
        ticketsRun: this.claimed,
        tokensUsed: this.tokensUsed,
        elapsedMs: Date.now() - this.startedAt,
        consecutiveFailures: this.consecutiveFailures,
        caps: safetyCaps,
        paused: this.paused
      })
      if (decision.stop) {
        if (decision.reason === 'paused') {
          this.state = 'paused'
          this.emit({ kind: 'paused' })
          return
        }
        return this.finish(decision.reason) // board-green | max-tickets | max-tokens | wall-clock | max-failures
      }

      // PARALLEL (parallelism > 1): try to run a file-disjoint batch this round. 'ran' → loop again; 'none' → fall
      // through to the proven single-ticket path below (which also handles the released 'rest' one at a time).
      if ((config.parallelism ?? 1) > 1 && (await this.tryParallelRound(config, runCwd, client)) === 'ran') continue

      // claim_next is the authoritative "nothing ready" signal.
      let ticket: BoardTicket | null
      try {
        ticket = await client.claimNext(config.project)
      } catch (e) {
        this.emit({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
        return this.finish('error')
      }
      if (!ticket) {
        // Nothing ready to claim. With includeReview on, re-engage review tickets (review → todo) for another
        // pass instead of dead-ending board-green — each reopened at most once (reopenedFromReview), and never
        // a ticket the user set aside (skip). This is the fix for "can't continue when only review tickets remain".
        if (config.includeReview && (await this.reopenReview(client, config.project)) > 0) continue
        return this.finish('board-green')
      }
      // A project mismatch is a board/server contract failure. Never edit a foreign ticket's worktree.
      if (ticket.project !== config.project) {
        try {
          await client.setStatus(ticket.id, 'todo', `released: belongs to project ${ticket.project}, not ${config.project}`)
        } catch {
          /* Surface the ownership error below even when the release write fails. */
        }
        this.emit({ kind: 'error', message: `board returned ticket #${ticket.id} from project "${ticket.project}" while draining "${config.project}"; it was not run` })
        return this.finish('error')
      }
      if (this.skippedIds.has(ticket.id)) {
        // The user set this ticket aside (skip). claim_next shouldn't hand back a skipped (now-review) ticket,
        // but if board state lags, release it again and move on — never run a skipped ticket.
        try {
          await client.setStatus(ticket.id, 'review', 'skipped this run')
        } catch {
          /* board may be unreachable; loop will surface it on the next call */
        }
        continue
      }
      if (this.parkedIds.has(ticket.id)) {
        // Parking resets a ticket to todo (→ ready) so a human/replan can revisit it, and claim_next (lowest-id
        // ready first) can hand it straight back. Do NOT run it again this sweep — but do NOT stop the whole drain
        // either: other ready, NON-parked tickets that are independent of this one must still run. Stopping here
        // let a low-id parked blocker starve every ready ticket behind it (the "stopped with work still left" bug:
        // #1298 parked → the drain quit while #1301/#1302 sat ready and untouched). Set the parked ticket ASIDE to
        // review (it needs attention anyway) so claim_next stops handing it back, then CONTINUE to the next ready
        // ticket. When the ONLY ready tickets left are parked, they each move to review and claim_next returns null
        // → the drain finishes board-green via the `!ticket` path above. `retry` restores a set-aside park to todo.
        try {
          await client.setStatus(ticket.id, 'review', 'parked — set aside for review so the drain can finish other ready work')
        } catch {
          /* board may be unreachable; skip it and keep draining — a later summary/claim will resurface any error */
        }
        this.parkedSetAside.add(ticket.id)
        this.emit({ kind: 'notice', text: `#${ticket.id} is parked — set aside for review; continuing with other ready tickets.` })
        continue
      }

      this.claimed++
      this.currentTicket = ticket.id
      this.ticketCancel = false // fresh per-ticket cancel flag (a prior per-ticket stop must not bleed forward)
      this.emit({ kind: 'ticket-started', id: ticket.id, title: ticket.title })
      // Push the live currentTicket to the renderer NOW — it drives the per-ticket Stop affordance + the
      // "working" card badge + the live worktree diff. ticket-started carries no status, and the only other
      // run-stats emit is at the end of the iteration (after currentTicket is cleared), so without this the
      // UI would never see a ticket as active.
      this.emit({ kind: 'run-stats', status: this.status() })

      // Per-ticket abort source for the check/reviewer steps (the AgentSession cancel covers the turn itself).
      const ticketAbort = new AbortController()
      this.currentAbort = ticketAbort
      try {
        // The hook hands us the live AgentSession so Stop can abort the turn in-flight; cleared when it settles.
        // isCancelled lets the multi-attempt flow bail before a new attempt if Stop landed between attempts.
        const outcome = await this.runTicket(ticket, runConfig, {
          onSession: (h) => (this.currentSession = h),
          isCancelled: () => this.ticketCancel,
          signal: ticketAbort.signal,
          awaitPlanDecision: () =>
            new Promise<PlanDecision>((resolve) => {
              // If a Stop already fired before the gate opened, decline immediately rather than hang.
              if (this.ticketCancel) return resolve({ decision: 'cancel' })
              this.pendingPlan = { id: ticket.id, resolve }
            })
        })
        this.currentSession = null
        this.currentAbort = null
        this.pendingPlan = null
        // A Stop (global, or a per-ticket stop that escalated to global) fired during the turn: the turn was
        // cancelled. Release the ticket for a future resume and finish cleanly — not as a failure.
        if (this.stopRequested) {
          await this.releaseStopped(ticket.id)
          this.currentTicket = undefined
          return this.finish('user')
        }
        this.tokensUsed += outcome.tokens ?? 0
        this.settledIds.add(ticket.id) // settled this run → skip refuses it (only retry can re-run it)
        if (outcome.terminal === 'park') {
          // Park = todo + comment (one status call records both), then skip it for the rest of this run.
          this.consecutiveFailures++
          await client.setStatus(ticket.id, 'todo', outcome.parkReason || 'parked after attempts')
          this.parkedIds.add(ticket.id)
          this.parkReasons.set(ticket.id, outcome.parkReason || 'parked after attempts')
          this.parked++
        } else {
          this.consecutiveFailures = 0
          await client.setStatus(ticket.id, outcome.terminal) // 'done' unblocks dependents; 'review' still gates them
          if (outcome.terminal === 'done') this.done++
          else this.review++
        }
        await this.commitTicket(runCwd, ticket)
        this.emit({ kind: 'ticket-done', id: ticket.id, terminal: outcome.terminal })
      } catch (e) {
        this.currentSession = null
        this.currentAbort = null
        // A user Stop mid-ticket can surface here as an aborted board call — finish cleanly, not as a failure.
        if (this.stopRequested) {
          await this.releaseStopped(ticket.id)
          this.currentTicket = undefined
          return this.finish('user')
        }
        this.consecutiveFailures++
        this.failed++
        const error = e instanceof Error ? e.message : String(e)
        this.emit({ kind: 'ticket-failed', id: ticket.id, error })
        try {
          await client.setStatus(ticket.id, 'review', `run failed: ${error}`)
        } catch {
          /* board may be unreachable; the cap will stop the run */
        }
      }
      this.currentTicket = undefined
      this.emit({ kind: 'run-stats', status: this.status() })
    }
  }
}

export const boardRunner = new BoardRunner()
