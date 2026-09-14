// Pure loop decision logic — no electron / IPC / shell imports, so it unit-tests headless.
// The `check` (a verifiable goal) is the authority for "done"; the inner turn's stop reason is not.
import { validateCheck } from './checkLint'
import type { ShellFamily } from '../shell/powershell'

export interface CheckOutcome {
  /** true ONLY when the check command exited 0 and did not time out. */
  passed: boolean
  /** raw exit code; null when the process produced none (spawn failure / killed). */
  code: number | null
  /** Captured stdout/stderr, supplied to the next worker attempt when the check fails. */
  output?: string
  timedOut: boolean
}

export type Terminal =
  | { kind: 'done' }
  | { kind: 'review' }
  | { kind: 'iterate'; attempt: number } // re-run the inner loop; `attempt` is the next attempt number
  | { kind: 'park'; reason: string } // give up: status back to todo + comment + skip this run

export interface DecideInput {
  /** The ticket's check command. undefined/empty (after trim) => no check. */
  check?: string
  /** Result of running `check`; undefined only when there was no check to run. */
  outcome?: CheckOutcome
  /** Inner-loop attempts already completed for this ticket (1-based). */
  attemptsSoFar: number
  /** Max inner-loop attempts before parking. */
  maxAttempts: number
  /** 'review' = always gate (a passing check yields review, not done); 'auto'/undefined = pass → done. */
  terminalMode?: 'auto' | 'review'
  /** Shell that executes the check. Defaults to the host; injectable so both contracts test on every CI OS. */
  shellFamily?: ShellFamily
}

/**
 * A ticket is UNVERIFIED when it has neither a `check` command nor a reviewer to judge it — there is no
 * evidence it actually works. Such a ticket must NEVER reach `done` silently; it goes to human review flagged
 * unverified. (Hermes authors a check per ticket precisely so this stays empty in practice.) Pure → tested.
 */
export function isUnverified(check: string | undefined | null, hasReviewer: boolean): boolean {
  return !check?.trim() && !hasReviewer
}

/** Decide a ticket's terminal from its check result. See the five rules in the ticket. */
export function decideTerminal(input: DecideInput): Terminal {
  const check = input.check?.trim()
  if (!check) return { kind: 'review' } // unverifiable → hand to a reviewer
  if (input.outcome === undefined) throw new Error('decideTerminal: check present but no outcome to evaluate')
  // A passing check is 'done' — unless the operator chose "always review", which gates every ticket.
  if (input.outcome.passed) return input.terminalMode === 'review' ? { kind: 'review' } : { kind: 'done' }
  // A structurally-broken or cross-dialect check can NEVER pass — retrying the CODE is wasted.
  // Park immediately with a distinct reason that blames the CHECK, so a correct-but-unverifiable ticket doesn't
  // burn maxAttempts fresh ~100k-token sessions before parking (mode 2). Classify from the command string only.
  const lint = validateCheck(check, input.shellFamily)
  if (!lint.ok) return { kind: 'park', reason: `check-broken: ${lint.reason}` }
  if (input.attemptsSoFar < input.maxAttempts) return { kind: 'iterate', attempt: input.attemptsSoFar + 1 }
  const { code, timedOut } = input.outcome
  return {
    kind: 'park',
    reason: `parked after ${input.maxAttempts} attempts — check still failing (exit ${code}${timedOut ? ', timed out' : ''})`
  }
}
