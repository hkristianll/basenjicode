// Pure per-ticket orchestration â€” the work â†’ check â†’ review â†’ revise loop â€” with the heavy steps (the
// agent turn, the shell check, the reviewer completion) injected as a `seam`. This file imports NO
// electron-bound module, so the loop logic unit-tests headless; boardInner.ts wires the real seam.
import { decideTerminal, isUnverified } from './boardDecide'
import { departmentOf, filesOf } from './specPlan'
import { writeTeamMemory } from './teamMemory'
import { takeEscalation } from './escalation'
import { decideReview, type ReviewVerdict } from './boardReview'
import { shouldSwap, unloadModel } from './modelSwap'
import type { CheckOutcome } from './boardDecide'
import type { TicketTurnResult } from './boardSeed'
import type { ToolRegistry } from './registry'
import type { LoopConfig, LoopEvent } from '../../shared/ipc-types'
import type { Settings } from '../../shared/domain-types'
import type { BoardTicket, TicketOutcome, TicketRunHooks } from './boardRunner'
import { shellFamily, type ShellFamily } from '../shell/powershell'

export interface RunnerDeps {
  settings: Settings
  registry: ToolRegistry
  /** Re-stream loop events (per-ticket agent stream + check/review results) to the Loop activity feed. */
  emit?: (e: LoopEvent) => void
}

/** The heavy, model-bound steps â€” injected so the loop is testable. boardInner provides the real ones. */
export interface TicketSeam {
  runTurn: (
    ticket: BoardTicket,
    config: LoopConfig,
    deps: RunnerDeps,
    revision?: { attempt: number; feedback: string },
    hooks?: TicketRunHooks,
    approvedPlan?: string,
    leadBrief?: string
  ) => Promise<TicketTurnResult>
  /** Team-lead brief (Phase 3): the lead distills its team memory → a tiny per-ticket brief for the worker. Optional. */
  runLeadBrief?: (ticket: BoardTicket, config: LoopConfig, deps: RunnerDeps, signal?: AbortSignal) => Promise<string>
  /** Department-lead rescue: when a ticket is about to PARK, the lead diagnoses the failure and either returns a
   *  concrete fix-brief for ONE final guided worker attempt, or {retry:false} to escalate to the group manager. */
  runLeadFix?: (
    ticket: BoardTicket,
    config: LoopConfig,
    deps: RunnerDeps,
    failure: { stage: 'check' | 'review' | 'escalation'; detail: string },
    signal?: AbortSignal
  ) => Promise<{ retry: boolean; brief?: string }>
  runCheck: (command: string, cwd: string, signal?: AbortSignal) => Promise<CheckOutcome>
  runReview: (ticket: BoardTicket, config: LoopConfig, deps: RunnerDeps, signal?: AbortSignal) => Promise<ReviewVerdict>
  /** Plan-gate: a read-only PLAN turn whose final text is the plan to surface (only called when reviewPlans). */
  runPlan?: (ticket: BoardTicket, config: LoopConfig, deps: RunnerDeps, hooks?: TicketRunHooks) => Promise<TicketTurnResult>
  /** Plan-gate: persist the approved plan as a durable artifact in the worktree. */
  persistPlan?: (ticket: BoardTicket, config: LoopConfig, plan: string, deps: RunnerDeps) => Promise<void>
}

/** Worker feedback after a failed `check`. A TIMEOUT is fundamentally different from a non-zero exit: the check
 *  NEVER FINISHED, so re-running the same (often whole-suite) command just times out again and burns the whole
 *  attempt. The worker must instead localize with a fast subset and find the hang. A normal failure means fix the
 *  code the check verifies. Pure → unit-tested. */
export function checkFailureFeedback(check: string, outcome: CheckOutcome): string {
  const tail = outcome.output?.trim().slice(-4_000)
  if (outcome.timedOut) {
    return (
      `The \`check\` command (\`${check}\`) TIMED OUT — it never finished, so there is NO pass/fail signal (this is not a normal failure).` +
      (tail ? `\n\nPartial output before the timeout:\n${tail}` : '') +
      '\n\nDo NOT just re-run the same command — it will time out again and waste the whole attempt. The cause is almost always one of:' +
      '\n1. The code under test HANGS or infinite-loops. Localize it with a NARROW, FAST command (one test file or a single test, e.g. `pytest path/test_x.py::test_y -x`), find the hang, and fix it.' +
      '\n2. The suite is too large/slow to finish in the limit. Run targeted subsets, and bound each test if the tool supports it (e.g. `pytest --timeout=30`).' +
      '\nLocalize FIRST with a fast command, fix the offending code, THEN expect the original check to finish.'
    )
  }
  return (
    `The \`check\` command (\`${check}\`) failed: exit ${outcome.code}.` +
    (tail ? `\n\nCaptured output:\n${tail}` : '') +
    '\n\nFix the project files that the check verifies. Do not alter shell aliases, profiles, PATH, or create a workaround script for the check unless the ticket explicitly requires it. If you are genuinely stuck after a couple of attempts (a missing prerequisite, an ambiguous requirement, or a check you cannot satisfy), call escalate_to_lead instead of guessing or rewriting files.'
  )
}

/**
 * Scope a whole-project `tsc --noEmit` check down to only the ticket's DECLARED files, so an isolated coder isn't
 * forced to make the ENTIRE project typecheck (the scope-bleed: every batched coder rebuilding the whole app just to
 * satisfy a global tsc). The rewritten command WRITES a tiny per-ticket tsconfig that extends the project config but
 * `include`s only the declared files — tsc still pulls in their real imports (types, libs), but NOT unrelated modules
 * other tickets own — then typechecks against it. Pure: the returned platform-correct shell command writes the
 * tsconfig itself, so there's no file-write side effect here. Left unchanged when the check isn't a bare
 * whole-project tsc or no files are declared.
 */
export function scopeTscCheck(
  check: string,
  files: string[],
  family: ShellFamily = shellFamily()
): string {
  const isBareWholeProjectTsc = /\btsc\s+--noEmit\b/.test(check) && !/(\s-p\b|--project\b|tsconfig|\.tsx?(\s|$))/.test(check)
  if (!isBareWholeProjectTsc || files.length === 0) return check
  const json = JSON.stringify({ extends: './tsconfig.json', include: files.map((file) => file.replace(/\\/g, '/')) })
  // The trailing tsc determines the check's exit code (success = THIS file compiles). Quote the JSON as inert data
  // in each dialect; ticket paths can legally contain apostrophes.
  if (family === 'powershell') {
    return `'${json.replace(/'/g, "''")}' | Set-Content tsconfig.ticket.json; npx tsc --noEmit -p tsconfig.ticket.json`
  }
  const quoted = `'${json.replace(/'/g, `'\\''`)}'`
  return `printf '%s\\n' ${quoted} > tsconfig.ticket.json && npx tsc --noEmit -p tsconfig.ticket.json`
}

/**
 * Run one ticket to a terminal: worker turn â†’ (check gate) â†’ (human gate) â†’ (reviewer judges). A failing
 * check or a changes-requested review re-runs the worker â€” seeded with the feedback â€” up to the cap, then
 * parks. No reviewer + passing check â†’ done; nothing to verify â†’ human review.
 */
export async function runTicketFlow(
  ticket: BoardTicket,
  config: LoopConfig,
  deps: RunnerDeps,
  seam: TicketSeam,
  hooks?: TicketRunHooks,
  opts: { codeOnly?: boolean } = {}
): Promise<TicketOutcome> {
  const maxAttempts = config.maxAttemptsPerTicket ?? 3
  const check = ticket.check?.trim()
  const reviewer = config.reviewerConnectionId
  // `swap` gates every worker↔reviewer VRAM unload in this flow (lead-brief, lead-rescue, review). When the user
  // opts to keep the coder + reviewer co-resident, NONE of those should fire — only the planner is freed elsewhere.
  // Without this, the co-reside setting only covered the freeOtherRoleModels paths and the boardFlow unloads still
  // ejected the worker/reviewer on the sequential review path.
  const swap = shouldSwap(config) && deps.settings.keepReviewerResident !== true
  const workerConn = deps.settings.connections.find((c) => c.id === config.connectionId)
  const reviewerConn = reviewer ? deps.settings.connections.find((c) => c.id === reviewer) : undefined
  let tokens = 0
  let revision: { attempt: number; feedback: string } | undefined
  let approvedPlan: string | undefined
  // R9: a capability stall (the worker turn returns stopReason 'error' from an oscillation / empty-args / same-call
  // guard) gets up to TWO clean restarts — a fresh session re-seeded WITHOUT the stalled turn's SPECIFIC (poisoned)
  // feedback, but WITH a short generic anti-loop nudge — before it becomes terminal. The looping context IS the cause;
  // throwing it away recovers more often than re-reasoning over it, and on a single GPU a clean re-seed is the cheapest
  // escape; the second restart catches a non-deterministic re-loop. A SEPARATE counter so a stall never silently
  // consumes a genuine revise attempt.
  let cleanRestarts = 0
  const MAX_CLEAN_RESTARTS = 2

  // (0) Plan-gate (opt-in): before any edits, run a read-only PLAN turn, surface it, and pause until the user
  // approves/edits it. A reject (or a Stop, surfaced as 'cancel') lands the ticket in review without editing.
  if (config.reviewPlans && seam.runPlan && hooks?.awaitPlanDecision) {
    const planResult = await seam.runPlan(ticket, config, deps, hooks)
    tokens += planResult.promptTokens + (planResult.completionTokens ?? 0)
    if (planResult.stopReason === 'cancelled' || hooks.isCancelled()) return { terminal: 'review', tokens }
    deps.emit?.({ kind: 'plan-ready', id: ticket.id, plan: planResult.text })
    const decision = await hooks.awaitPlanDecision(planResult.text)
    if (decision.decision !== 'approve') {
      deps.emit?.({ kind: 'notice', text: `#${ticket.id} plan ${decision.decision === 'reject' ? 'rejected' : 'cancelled'} â€” handed to review, no edits made` })
      return { terminal: 'review', tokens }
    }
    approvedPlan = decision.editedPlan?.trim() || planResult.text
    await seam.persistPlan?.(ticket, config, approvedPlan, deps)
    deps.emit?.({ kind: 'notice', text: `#${ticket.id} plan approved â€” executing` })
  }

  // Team-lead brief (Phase 3): the lead distills the team memory into a tiny per-ticket brief, seeded into the
  // worker so it gets the team's relevant craft without carrying the whole memory. Computed ONCE per ticket
  // (not per revise-attempt); empty when there is no memory/lead -> no turn, no cost. Then free the lead model
  // so the worker loads clean (the swap optimization).
  const leadBrief = seam.runLeadBrief ? await seam.runLeadBrief(ticket, config, deps, hooks?.signal) : ''
  // Free the lead model after the brief ONLY when this ticket's worker uses a DIFFERENT model. For a DESIGN ticket
  // whose designer IS the reviewer/lead model (e.g. both the 27B), unloading now just forces an immediate reload
  // before the designer turn (the observed "redeploy"). When the worker is the coder, freeing the lead model still
  // frees VRAM as before. Either way the worker turn's `freeOtherRoleModels` catch-all is the backstop against a
  // double-load, so this only optimizes away a wasteful same-model reload. (workerModel resolved inline to avoid a
  // boardInner import cycle.)
  const leadModel = (config.reviewerModel || reviewerConn?.model || '').trim()
  const ticketWorkerModel =
    departmentOf(ticket.body) === 'design' && deps.settings.hermesDesignerModel?.trim()
      ? deps.settings.hermesDesignerModel.trim()
      : (config.workerModel || workerConn?.model || '').trim()
  if (seam.runLeadBrief && swap && reviewerConn && ticketWorkerModel !== leadModel) {
    await unloadModel(reviewerConn, config.reviewerModel || reviewerConn.model)
  }

  // Department-lead rescue (escalation tier 1): before a ticket PARKS, its lead diagnoses the failure and either
  // guides ONE final worker attempt with a concrete fix, or escalates (false -> park -> the group manager intervenes).
  let leadRescued = false
  let loopCap = maxAttempts
  const maybeLeadRescue = async (stage: 'check' | 'review' | 'escalation', detail: string): Promise<boolean> => {
    if (leadRescued || !seam.runLeadFix) return false
    leadRescued = true
    const dept = departmentOf(ticket.body) ?? 'team'
    deps.emit?.({ kind: 'notice', text: `#${ticket.id} ${dept} lead reviewing the stuck ticket before parking it` })
    // VRAM swap: free the WORKER before the lead model (it rides the reviewer slot) loads, and free the lead model
    // again afterwards so the worker's rescue retry loads clean. Without this, the lead model loaded ON TOP of the
    // still-resident worker on park — two models pinned on one GPU (observed: gemma loaded, the qwen worker stayed).
    if (swap && workerConn) await unloadModel(workerConn, config.workerModel || workerConn.model)
    const fix = await seam.runLeadFix(ticket, config, deps, { stage, detail }, hooks?.signal)
    if (swap && reviewerConn) await unloadModel(reviewerConn, config.reviewerModel || reviewerConn.model)
    if (!fix.retry || !fix.brief?.trim()) return false
    loopCap = maxAttempts + 1 // grant exactly one guided rescue attempt beyond the normal cap
    revision = { attempt: maxAttempts + 1, feedback: `Your ${dept} lead reviewed this and says, apply this fix:\n${fix.brief.trim()}` }
    deps.emit?.({ kind: 'notice', text: `#${ticket.id} ${dept} lead handed the worker a fix; one rescue attempt` })
    return true
  }

  for (let attempt = 1; attempt <= loopCap; attempt++) {
    // A Stop that landed in the gap between attempts (check/review running, no live session to cancel) can't
    // abort a turn that isn't running yet â€” so bail before starting another one. The outer loop decides
    // global-stop (finish) vs per-ticket-stop (continue) from its own stopRequested flag.
    if (hooks?.isCancelled()) return { terminal: 'review', tokens }
    const result = await seam.runTurn(ticket, config, deps, revision, hooks, approvedPlan, leadBrief)
    tokens += result.promptTokens + (result.completionTokens ?? 0) // each attempt is a fresh session â†’ independent cost; sum for the cap
    // Proactive escalation: the worker called escalate_to_lead because it's stuck. Confirm it really is stuck (the
    // check still fails) — if it actually finished, accept the work — otherwise route the worker's OWN reason
    // straight to the lead rescue, skipping the retry thrash, for a guided fix or a hand-off to the group manager.
    // Takes precedence over the error/clean-restart path below (an explicit "I'm stuck" is the clearer signal).
    const escalation = takeEscalation()
    if (escalation) {
      const stillStuck = check ? !(await seam.runCheck(check, config.cwd, hooks?.signal)).passed : true
      if (stillStuck) {
        deps.emit?.({ kind: 'notice', text: `#${ticket.id} worker escalated to its lead: ${escalation.slice(0, 140)}` })
        if (await maybeLeadRescue('escalation', `the worker escalated — it is stuck: ${escalation}`)) continue
        return { terminal: 'park', parkReason: `worker escalated (stuck): ${escalation}`.slice(0, 300), tokens }
      }
      deps.emit?.({ kind: 'notice', text: `#${ticket.id} worker escalated, but its check passes — accepting the completed work` })
      // fall through: the check gate below re-confirms (passes) and the reviewer/done path runs.
    }
    if (result.stopReason === 'error') {
      if (cleanRestarts < MAX_CLEAN_RESTARTS) {
        cleanRestarts++
        // Clean seed: drop the stalled turn's SPECIFIC feedback (re-reasoning over the poisoned context is the trap),
        // but seed a short GENERIC anti-loop nudge so the fresh session doesn't fall straight back into the same loop.
        revision = {
          attempt,
          feedback:
            'The previous attempt stalled by repeating the same action with no effect. This time work in small, ' +
            'distinct, concrete steps; never repeat a tool call that changed nothing — do something different. Make ' +
            'the smallest edit that moves the ticket forward, then continue.'
        }
        deps.emit?.({ kind: 'notice', text: `#${ticket.id} stalled — clean restart with anti-loop guidance (${cleanRestarts}/${MAX_CLEAN_RESTARTS})` })
        attempt-- // re-run this attempt number with a fresh session; do not burn a revise slot on the stall
        continue
      }
      throw new Error(result.error || 'agent turn failed (model error)')
    }
    // A user Stop aborted the turn: bail without running the check/reviewer. The outer loop decides whether
    // this was a global stop (finish the run) or a per-ticket stop (release to review, continue draining).
    if (result.stopReason === 'cancelled') return { terminal: 'review', tokens }
    if (result.summary) deps.emit?.({ kind: 'ticket-summary', id: ticket.id, text: result.summary })

    // Review department: the worker audits and ROUTES fixes (via file_finding → implementation tickets); it
    // never edits code. Its deliverable is the audit, not a passing code-check — so a completed review turn is
    // done, and we skip the check/reviewer gates (which assume a worker that changed the code).
    if (departmentOf(ticket.body) === 'review') {
      deps.emit?.({ kind: 'notice', text: `#${ticket.id} reviewed — any fixes routed to implementation` })
      return { terminal: 'done', tokens }
    }

    // (1) Check gate: a failing `check` iterates/parks before we bother reviewing broken work. Scope a whole-project
    // tsc to the ticket's own files so the coder isn't pushed to rebuild the whole app (scope-bleed) just to go green.
    if (check) {
      const runCmd = scopeTscCheck(check, filesOf(ticket.body))
      deps.emit?.({ kind: 'notice', text: `#${ticket.id} running check: ${runCmd}` })
      const outcome = await seam.runCheck(runCmd, config.cwd, hooks?.signal)
      const checkOutput = outcome.output?.trim().slice(-4_000)
      const resultText = `exit ${outcome.code}${outcome.timedOut ? ' (timed out)' : ''}${checkOutput ? `\n${checkOutput}` : ''}`
      deps.emit?.({ kind: 'check-result', id: ticket.id, passed: outcome.passed, output: resultText })
      if (!outcome.passed) {
        const d = decideTerminal({ check, outcome, attemptsSoFar: attempt, maxAttempts })
        if (d.kind === 'park') {
          if (await maybeLeadRescue('check', `check \`${check}\` failed: ${resultText}`)) continue
          return { terminal: 'park', parkReason: d.reason, tokens }
        }
        const retryKind = outcome.timedOut ? 'timed out' : 'check failed'
        deps.emit?.({ kind: 'notice', text: `#${ticket.id} ${retryKind} â€” retry ${attempt + 1}/${maxAttempts}` })
        revision = { attempt: attempt + 1, feedback: checkFailureFeedback(check, outcome) }
        continue
      }
    }

    // PARALLEL batch path: a code-only run stops here — coded + check-passed, left in its worktree. The batch
    // coordinator runs the reviewer ONCE for the whole batch (one model swap) and merges the approved worktrees, so
    // the inline reviewer below is skipped. 'review' marks the ticket coded-and-awaiting-(batch)-review.
    if (opts.codeOnly) {
      deps.emit?.({ kind: 'notice', text: `#${ticket.id} coded + check passed — queued for batch review` })
      return { terminal: 'review', tokens }
    }

    // (2) Explicit "always review" gate wins over the LLM reviewer.
    if (config.terminal === 'review') return { terminal: 'review', tokens }

    // (3) Reviewer judges quality against the acceptance criteria â€” changes-requested â†’ revise loop.
    if (reviewer) {
      // Swap: free the worker before the reviewer runs, free the reviewer after, so only one model is
      // GPU-resident at a time (the other JIT-reloads on its next request).
      if (swap && workerConn) {
        deps.emit?.({ kind: 'notice', text: `#${ticket.id} swapping to reviewer model (freeing the worker)` })
        await unloadModel(workerConn, config.workerModel || workerConn.model)
      }
      const verdict = await seam.runReview(ticket, config, deps, hooks?.signal)
      // NOTE: we deliberately do NOT unload the reviewer here. The next thing is often the next ticket's lead-brief,
      // which rides the SAME reviewer slot — unloading now just forces an immediate reload (the observed "redeploy
      // after approve"). The worker turn's `freeOtherRoleModels` catch-all (and the planner's) free the reviewer
      // before a coder/planner turn actually needs the VRAM, so only one model is still ever resident.
      // Reviewer couldn't run (offline/misconfigured) → hand to a human, never auto-approve as done.
      if (verdict.unreachable) {
        deps.emit?.({ kind: 'notice', text: `#${ticket.id} reviewer unreachable — handed to human review (not auto-approved)` })
        return { terminal: 'review', tokens }
      }
      // Team-lead memory (Phase 2): persist any memory update the lead emitted (on approve OR changes-requested).
      const leadDept = departmentOf(ticket.body)
      if (leadDept && verdict.memoryUpdate) {
        writeTeamMemory(config.cwd, leadDept, verdict.memoryUpdate)
        deps.emit?.({ kind: 'notice', text: `#${ticket.id} ${leadDept} lead refreshed its team memory` })
      }
      deps.emit?.({ kind: 'review-result', id: ticket.id, approved: verdict.approved, feedback: verdict.feedback, round: attempt })
      const rd = decideReview({ approved: verdict.approved, attemptsSoFar: attempt, maxAttempts })
      if (rd.kind === 'done') return { terminal: 'done', tokens }
      if (rd.kind === 'park') {
        if (await maybeLeadRescue('review', `reviewer kept requesting changes: ${verdict.feedback}`)) continue
        return { terminal: 'park', parkReason: rd.reason, tokens }
      }
      deps.emit?.({ kind: 'notice', text: `#${ticket.id} changes requested â€” revision ${rd.attempt}/${maxAttempts}` })
      revision = { attempt: rd.attempt, feedback: verdict.feedback }
      continue
    }

    // (4) No reviewer: a passing check â†’ done; nothing to verify â†’ hand to a human reviewer.
    if (isUnverified(check, !!reviewer)) {
      // No check + no reviewer = no evidence the work is correct — never auto-promote that to done.
      deps.emit?.({ kind: 'notice', text: `#${ticket.id} unverified (no check command, no reviewer) — handed to human review, not marked done` })
      return { terminal: 'review', tokens }
    }
    return { terminal: check ? 'done' : 'review', tokens }
  }
  return { terminal: 'review', tokens } // exhausted attempts without parking (e.g. check kept failing)
}
