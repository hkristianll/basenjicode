import { describe, it, expect, vi } from 'vitest'
import { runTicketFlow, checkFailureFeedback, scopeTscCheck, type TicketSeam, type RunnerDeps } from './boardFlow'
import { unloadModel } from './modelSwap'

// Mock only unloadModel (best-effort VRAM unload → hits the lms CLI); keep the real shouldSwap. Swap-off tests
// never call it, so this is inert for them and lets the swap-on test assert the unload ORDER without real I/O.
vi.mock('./modelSwap', async (orig) => {
  const actual = await orig<typeof import('./modelSwap')>()
  return { ...actual, unloadModel: vi.fn(async () => {}) }
})
import { recordEscalation } from './escalation'
import type { LoopConfig, LoopEvent, PlanDecision } from '../../shared/ipc-types'
import type { Settings } from '../../shared/domain-types'
import type { BoardTicket } from './boardRunner'
import type { TicketTurnResult } from './boardSeed'

const ticket: BoardTicket = { id: 1, title: 'T1', body: 'do it', status: 'in_progress', project: 'p' }

describe('scopeTscCheck — scope a whole-project tsc to the ticket files (anti scope-bleed)', () => {
  it('rewrites a bare `tsc --noEmit` to a per-ticket tsconfig over only the declared files', () => {
    const out = scopeTscCheck('npx tsc --noEmit', ['src/entities/Paddle.ts', 'src/entities/Paddle.test.ts'])
    expect(out).toContain('Set-Content tsconfig.ticket.json')
    expect(out).toContain('tsc --noEmit -p tsconfig.ticket.json')
    expect(out).toContain('"include":["src/entities/Paddle.ts","src/entities/Paddle.test.ts"]')
    expect(out).toContain('"extends":"./tsconfig.json"')
  })
  it('leaves it unchanged when the ticket declares no files (can\'t scope)', () => {
    expect(scopeTscCheck('npx tsc --noEmit', [])).toBe('npx tsc --noEmit')
  })
  it('leaves an already-scoped or file-targeted tsc unchanged', () => {
    expect(scopeTscCheck('npx tsc --noEmit -p tsconfig.app.json', ['src/a.ts'])).toBe('npx tsc --noEmit -p tsconfig.app.json')
    expect(scopeTscCheck('npx tsc --noEmit src/a.ts', ['src/a.ts'])).toBe('npx tsc --noEmit src/a.ts')
  })
  it('leaves a non-tsc check (npm test / vitest / Test-Path) untouched', () => {
    expect(scopeTscCheck('npm test', ['src/a.ts'])).toBe('npm test')
    expect(scopeTscCheck('npx vitest run x.spec.ts', ['src/a.ts'])).toBe('npx vitest run x.spec.ts')
    expect(scopeTscCheck('(Test-Path src/a.ts)', ['src/a.ts'])).toBe('(Test-Path src/a.ts)')
  })
  it('normalizes backslashes in declared paths', () => {
    expect(scopeTscCheck('tsc --noEmit', ['src\\ui\\ScoreUI.ts'])).toContain('"src/ui/ScoreUI.ts"')
  })
})

describe('checkFailureFeedback', () => {
  it('gives timeout-specific "localize, do not re-run" guidance when the check timed out', () => {
    const fb = checkFailureFeedback('python -m pytest', { passed: false, code: 1, timedOut: true, output: 'collecting...' })
    expect(fb).toMatch(/TIMED OUT/)
    expect(fb).toMatch(/Do NOT just re-run/)
    expect(fb).toMatch(/narrow|localize/i)
    // It must NOT give the generic "fix the files" advice — that misleads on a hang/too-slow suite.
    expect(fb).not.toMatch(/Fix the project files that the check verifies/)
  })
  it('gives the standard fix-the-code guidance on a normal non-zero exit', () => {
    const fb = checkFailureFeedback('npm test', { passed: false, code: 1, timedOut: false, output: 'AssertionError' })
    expect(fb).toMatch(/failed: exit 1/)
    expect(fb).toMatch(/Fix the project files/)
    expect(fb).not.toMatch(/TIMED OUT/)
  })
})

function cfg(p: Partial<LoopConfig> = {}): LoopConfig {
  return {
    cwd: '/x',
    connectionId: 'worker',
    project: 'p',
    mode: 'auto',
    caps: { maxTickets: 100, maxTokens: 0, maxWallclockSec: 3600, maxConsecutiveFailures: 100 },
    ...p
  }
}

// The flow only reads settings.connections (for the swap); empty + swap-off keeps the test pure I/O-free.
function deps(events: LoopEvent[]): RunnerDeps {
  return { settings: { connections: [] } as unknown as Settings, registry: {} as RunnerDeps['registry'], emit: (e) => events.push(e) }
}

const okTurn: TicketTurnResult = { ticketId: 1, turnId: 't', stopReason: 'completed', editedFiles: 1, promptTokens: 10, summary: 'did the work', text: 'did the work' }

/** A seam whose reviewer returns the given verdicts in order (rejecting once exhausted). */
function seam(verdicts: boolean[]): TicketSeam {
  let i = 0
  return {
    runTurn: async () => okTurn,
    runCheck: async () => ({ passed: true, code: 0, timedOut: false }),
    runReview: async () => ({ approved: verdicts[i++] ?? false, feedback: 'fix the thing' })
  }
}

const reviews = (events: LoopEvent[]): { approved: boolean }[] =>
  events.filter((e) => e.kind === 'review-result') as unknown as { approved: boolean }[]

describe('runTicketFlow — review department audits and routes (no fixing)', () => {
  it('a review-department ticket is done after the worker turn, skipping check + reviewer', async () => {
    const events: LoopEvent[] = []
    const reviewTicket: BoardTicket = { ...ticket, body: '**Department: review** — audit it\n\nAudit the slicer', check: 'npm test' }
    // Both gates would FAIL — neither must run for a review ticket (its deliverable is the audit + routed findings).
    const strictSeam: TicketSeam = {
      runTurn: async () => okTurn,
      runCheck: async () => ({ passed: false, code: 1, timedOut: false }),
      runReview: async () => ({ approved: false, feedback: 'no' })
    }
    const out = await runTicketFlow(reviewTicket, cfg({ reviewerConnectionId: 'rev', swapModels: false }), deps(events), strictSeam)
    expect(out.terminal).toBe('done')
    expect(reviews(events).length).toBe(0) // the reviewer gate never ran
    expect(events.some((e) => e.kind === 'check-result')).toBe(false) // the check never ran
  })
})

describe('runTicketFlow — R9 clean restart on a capability stall', () => {
  it('one stall (stopReason error) then a clean re-run completes — not terminal, no revise slot burned', async () => {
    const events: LoopEvent[] = []
    let calls = 0
    const stallThenOk: TicketSeam = {
      runTurn: async () => (++calls === 1 ? { ...okTurn, stopReason: 'error', error: 'oscillation guard' } : okTurn),
      runCheck: async () => ({ passed: true, code: 0, timedOut: false }),
      runReview: async () => ({ approved: true, feedback: '' })
    }
    const out = await runTicketFlow(ticket, cfg({ reviewerConnectionId: 'rev', swapModels: false }), deps(events), stallThenOk)
    expect(out.terminal).toBe('done')
    expect(calls).toBe(2) // stalled once → fresh clean restart → completed
    expect(events.some((e) => e.kind === 'notice' && /clean restart/.test(e.text))).toBe(true)
  })

  it('two clean restarts, then a third stall is terminal (throws → boardRunner routes to review)', async () => {
    const events: LoopEvent[] = []
    let calls = 0
    const alwaysStall: TicketSeam = {
      runTurn: async () => {
        calls++
        return { ...okTurn, stopReason: 'error', error: 'empty args' }
      },
      runCheck: async () => ({ passed: true, code: 0, timedOut: false }),
      runReview: async () => ({ approved: true, feedback: '' })
    }
    await expect(runTicketFlow(ticket, cfg({ reviewerConnectionId: 'rev', swapModels: false }), deps(events), alwaysStall)).rejects.toThrow(/empty args|model error/)
    expect(calls).toBe(3) // original attempt + TWO clean restarts, then terminal
  })

  it('a clean restart seeds a GENERIC anti-loop nudge, not the stalled turn’s own feedback', async () => {
    const events: LoopEvent[] = []
    let calls = 0
    const revisions: (string | undefined)[] = []
    const stallThenOk: TicketSeam = {
      runTurn: async (_t, _c, _d, revision) => {
        revisions.push(revision?.feedback)
        return ++calls === 1 ? { ...okTurn, stopReason: 'error', error: 'oscillation guard XYZ' } : okTurn
      },
      runCheck: async () => ({ passed: true, code: 0, timedOut: false }),
      runReview: async () => ({ approved: true, feedback: '' })
    }
    const out = await runTicketFlow(ticket, cfg({ reviewerConnectionId: 'rev', swapModels: false }), deps(events), stallThenOk)
    expect(out.terminal).toBe('done')
    expect(revisions[0]).toBeUndefined() // first attempt: clean seed
    expect(revisions[1]).toMatch(/repeating the same action|small, distinct/i) // restart: generic anti-loop nudge
    expect(revisions[1]).not.toContain('oscillation guard XYZ') // NOT the poisoned stall feedback
  })
})

describe('runTicketFlow — worker escalation to the lead', () => {
  const checkTicket: BoardTicket = { ...ticket, check: 'pytest' }

  it('a stuck worker (check still failing) with no lead fix → park with the escalation reason', async () => {
    const events: LoopEvent[] = []
    const escalatingSeam: TicketSeam = {
      runTurn: async () => {
        recordEscalation('the check needs a database that is not provisioned')
        return okTurn
      },
      runCheck: async () => ({ passed: false, code: 1, timedOut: false }),
      runReview: async () => ({ approved: true, feedback: '' }),
      runLeadFix: async () => ({ retry: false })
    }
    const out = await runTicketFlow(checkTicket, cfg({ reviewerConnectionId: 'rev', swapModels: false }), deps(events), escalatingSeam)
    expect(out.terminal).toBe('park')
    expect(out.parkReason).toMatch(/escalated/i)
    expect(out.parkReason).toMatch(/database that is not provisioned/)
  })

  it('a lead fix on escalation grants one guided attempt that passes → done', async () => {
    const events: LoopEvent[] = []
    let turn = 0
    const seam2: TicketSeam = {
      runTurn: async () => {
        if (++turn === 1) recordEscalation('I cannot find where X is defined')
        return okTurn
      },
      runCheck: async () => ({ passed: turn >= 2, code: turn >= 2 ? 0 : 1, timedOut: false }), // fails on the escalation confirm, passes after the guided retry
      runReview: async () => ({ approved: true, feedback: '' }),
      runLeadFix: async () => ({ retry: true, brief: 'X is defined in src/x.ts — import it' })
    }
    const out = await runTicketFlow(checkTicket, cfg({ reviewerConnectionId: 'rev', swapModels: false }), deps(events), seam2)
    expect(out.terminal).toBe('done')
    expect(turn).toBe(2) // escalation → one guided retry
    expect(events.some((e) => e.kind === 'notice' && /escalated/.test(e.text))).toBe(true)
  })

  it('escalation is IGNORED when the check actually passes — completed work is accepted, not parked', async () => {
    const events: LoopEvent[] = []
    const seam3: TicketSeam = {
      runTurn: async () => {
        recordEscalation('felt unsure')
        return okTurn
      },
      runCheck: async () => ({ passed: true, code: 0, timedOut: false }),
      runReview: async () => ({ approved: true, feedback: '' })
    }
    const out = await runTicketFlow(checkTicket, cfg({ reviewerConnectionId: 'rev', swapModels: false }), deps(events), seam3)
    expect(out.terminal).toBe('done')
    expect(events.some((e) => e.kind === 'notice' && /accepting the completed work/.test(e.text))).toBe(true)
  })
})

describe('runTicketFlow — department-lead rescue before park', () => {
  const checkTicket: BoardTicket = { ...ticket, check: 'pytest' }

  it('a lead rescue grants ONE guided attempt that can pass → done', async () => {
    const events: LoopEvent[] = []
    let checks = 0
    let fixes = 0
    const seam: TicketSeam = {
      runTurn: async () => okTurn,
      runCheck: async () => ({ passed: ++checks > 3, code: checks > 3 ? 0 : 1, timedOut: false }), // fails 3×, passes on the rescue
      runReview: async () => ({ approved: true, feedback: '' }),
      runLeadFix: async () => {
        fixes++
        return { retry: true, brief: 'create tests/test_x.py importing X and asserting Y' }
      }
    }
    const out = await runTicketFlow(checkTicket, cfg({ swapModels: false }), deps(events), seam)
    expect(out.terminal).toBe('done')
    expect(fixes).toBe(1) // lead consulted exactly once
    expect(checks).toBe(4) // 3 normal attempts + 1 guided rescue
  })

  it('if the rescue attempt still fails → park (escalates to the group manager)', async () => {
    const events: LoopEvent[] = []
    let fixes = 0
    const seam: TicketSeam = {
      runTurn: async () => okTurn,
      runCheck: async () => ({ passed: false, code: 1, timedOut: false }), // never passes
      runReview: async () => ({ approved: true, feedback: '' }),
      runLeadFix: async () => {
        fixes++
        return { retry: true, brief: 'try X' }
      }
    }
    const out = await runTicketFlow(checkTicket, cfg({ swapModels: false, maxAttemptsPerTicket: 2 }), deps(events), seam)
    expect(out.terminal).toBe('park')
    expect(fixes).toBe(1) // exactly one rescue, then park — no infinite rescue loop
  })

  it('a lead that returns ESCALATE (retry:false) parks immediately, no extra attempt', async () => {
    const events: LoopEvent[] = []
    let checks = 0
    const seam: TicketSeam = {
      runTurn: async () => okTurn,
      runCheck: async () => {
        checks++
        return { passed: false, code: 1, timedOut: false }
      },
      runReview: async () => ({ approved: true, feedback: '' }),
      runLeadFix: async () => ({ retry: false })
    }
    const out = await runTicketFlow(checkTicket, cfg({ swapModels: false, maxAttemptsPerTicket: 1 }), deps(events), seam)
    expect(out.terminal).toBe('park')
    expect(checks).toBe(1) // single normal attempt; lead escalated, no extra run
  })

  it('with no runLeadFix in the seam, behaviour is unchanged (parks at the cap)', async () => {
    const events: LoopEvent[] = []
    const seam: TicketSeam = {
      runTurn: async () => okTurn,
      runCheck: async () => ({ passed: false, code: 1, timedOut: false }),
      runReview: async () => ({ approved: true, feedback: '' })
    }
    const out = await runTicketFlow(checkTicket, cfg({ swapModels: false, maxAttemptsPerTicket: 2 }), deps(events), seam)
    expect(out.terminal).toBe('park')
  })

  it('with swap ON, frees the worker BEFORE the lead rescue and the lead model AFTER (no two models pinned on park)', async () => {
    const events: LoopEvent[] = []
    const conns = [
      { id: 'worker', kind: 'lmstudio', baseURL: 'http://x', model: 'qwen' },
      { id: 'rev', kind: 'lmstudio', baseURL: 'http://x', model: 'gemma' }
    ]
    const d: RunnerDeps = { settings: { connections: conns } as unknown as Settings, registry: {} as RunnerDeps['registry'], emit: (e) => events.push(e) }
    const order: string[] = []
    vi.mocked(unloadModel).mockImplementation(async (_conn, model) => void order.push(`unload:${model}`))
    const seamLead: TicketSeam = {
      runTurn: async () => okTurn,
      runCheck: async () => ({ passed: false, code: 1, timedOut: false }), // check always fails → parks → lead rescue
      runReview: async () => ({ approved: true, feedback: '' }),
      runLeadFix: async () => (order.push('leadFix'), { retry: false })
    }
    const out = await runTicketFlow(checkTicket, cfg({ reviewerConnectionId: 'rev', workerModel: 'qwen', reviewerModel: 'gemma', maxAttemptsPerTicket: 1 }), d, seamLead)
    expect(out.terminal).toBe('park')
    expect(order).toEqual(['unload:qwen', 'leadFix', 'unload:gemma']) // worker freed first, lead model freed after
    vi.mocked(unloadModel).mockReset()
  })

  it('with keepReviewerResident ON, NO worker/reviewer unloads fire (co-reside — the user keeps both loaded)', async () => {
    const events: LoopEvent[] = []
    const conns = [
      { id: 'worker', kind: 'lmstudio', baseURL: 'http://x', model: 'qwen' },
      { id: 'rev', kind: 'lmstudio', baseURL: 'http://x', model: 'gemma' }
    ]
    // Same as the swap-on test, but the user has opted to co-reside coder + reviewer → swap is suppressed.
    const d: RunnerDeps = { settings: { connections: conns, keepReviewerResident: true } as unknown as Settings, registry: {} as RunnerDeps['registry'], emit: (e) => events.push(e) }
    const order: string[] = []
    vi.mocked(unloadModel).mockImplementation(async (_conn, model) => void order.push(`unload:${model}`))
    const seamLead: TicketSeam = {
      runTurn: async () => okTurn,
      runCheck: async () => ({ passed: false, code: 1, timedOut: false }),
      runReview: async () => ({ approved: true, feedback: '' }),
      runLeadFix: async () => (order.push('leadFix'), { retry: false })
    }
    await runTicketFlow(checkTicket, cfg({ reviewerConnectionId: 'rev', workerModel: 'qwen', reviewerModel: 'gemma', maxAttemptsPerTicket: 1 }), d, seamLead)
    expect(order).toEqual(['leadFix']) // NO unload:qwen / unload:gemma — both stay resident
    vi.mocked(unloadModel).mockReset()
  })

  it('with swap ON, frees the lead model after the brief EVEN when the brief returns NONE (no double-load)', async () => {
    const events: LoopEvent[] = []
    const conns = [
      { id: 'worker', kind: 'lmstudio', baseURL: 'http://x', model: 'qwen' },
      { id: 'rev', kind: 'lmstudio', baseURL: 'http://x', model: 'gemma' }
    ]
    const d: RunnerDeps = { settings: { connections: conns } as unknown as Settings, registry: {} as RunnerDeps['registry'], emit: (e) => events.push(e) }
    const order: string[] = []
    vi.mocked(unloadModel).mockImplementation(async (_c, model) => void order.push(`unload:${model}`))
    const seam: TicketSeam = {
      runLeadBrief: async () => (order.push('brief'), ''), // the brief RAN (loaded gemma) but returned NONE
      runTurn: async () => (order.push('worker'), okTurn),
      runCheck: async () => ({ passed: true, code: 0, timedOut: false }),
      runReview: async () => ({ approved: true, feedback: '' })
    }
    const out = await runTicketFlow(checkTicket, cfg({ reviewerConnectionId: 'rev', workerModel: 'qwen', reviewerModel: 'gemma' }), d, seam)
    expect(out.terminal).toBe('done')
    const gemmaFreed = order.indexOf('unload:gemma')
    expect(gemmaFreed).toBeGreaterThan(order.indexOf('brief')) // freed AFTER the brief…
    expect(gemmaFreed).toBeLessThan(order.indexOf('worker')) // …and BEFORE the worker turn — never both resident
    vi.mocked(unloadModel).mockReset()
  })
})

describe('runTicketFlow — review→revise loop', () => {
  it('reviewer rejects once then approves → loops worker→review→worker→review→done', async () => {
    const events: LoopEvent[] = []
    const out = await runTicketFlow(ticket, cfg({ reviewerConnectionId: 'rev', swapModels: false }), deps(events), seam([false, true]))
    expect(out.terminal).toBe('done')
    expect(reviews(events).map((r) => r.approved)).toEqual([false, true]) // round 1 reject, round 2 approve
  })

  it('reviewer always rejects → parks at the cap', async () => {
    const events: LoopEvent[] = []
    const out = await runTicketFlow(
      ticket,
      cfg({ reviewerConnectionId: 'rev', swapModels: false, maxAttemptsPerTicket: 2 }),
      deps(events),
      seam([false, false])
    )
    expect(out.terminal).toBe('park')
    expect(reviews(events).length).toBe(2)
  })

  it('approves on the first round → done after one review', async () => {
    const events: LoopEvent[] = []
    const out = await runTicketFlow(ticket, cfg({ reviewerConnectionId: 'rev', swapModels: false }), deps(events), seam([true]))
    expect(out.terminal).toBe('done')
    expect(reviews(events).length).toBe(1)
  })

  it('reviewer unreachable → human review, NOT auto-approved as done (B2)', async () => {
    const events: LoopEvent[] = []
    const unreachableSeam: TicketSeam = {
      runTurn: async () => okTurn,
      runCheck: async () => ({ passed: true, code: 0, timedOut: false }),
      runReview: async () => ({ approved: false, unreachable: true, feedback: '(reviewer unavailable: ECONNREFUSED)' })
    }
    const out = await runTicketFlow(ticket, cfg({ reviewerConnectionId: 'rev', swapModels: false }), deps(events), unreachableSeam)
    expect(out.terminal).toBe('review')
    expect(reviews(events).length).toBe(0) // no review-result emitted for an unreachable reviewer
    expect(events.some((e) => e.kind === 'notice' && /unreachable/.test((e as { text: string }).text))).toBe(true)
  })

  it('no reviewer + no check → human review (prior behavior preserved)', async () => {
    const events: LoopEvent[] = []
    const out = await runTicketFlow(ticket, cfg({ swapModels: false }), deps(events), seam([]))
    expect(out.terminal).toBe('review')
    expect(reviews(events).length).toBe(0)
  })

  it('a cancelled turn short-circuits to review without running the check or the reviewer (#52)', async () => {
    const events: LoopEvent[] = []
    let checks = 0
    let reviews2 = 0
    const cancelSeam: TicketSeam = {
      runTurn: async () => ({ ...okTurn, stopReason: 'cancelled' }),
      runCheck: async () => ((checks++), { passed: true, code: 0, timedOut: false }),
      runReview: async () => ((reviews2++), { approved: true, feedback: '' })
    }
    const out = await runTicketFlow(
      { ...ticket, check: 'npm test' },
      cfg({ reviewerConnectionId: 'rev', swapModels: false }),
      deps(events),
      cancelSeam
    )
    expect(out.terminal).toBe('review')
    expect(checks).toBe(0)
    expect(reviews2).toBe(0)
  })

  it('bails to review before a new attempt when isCancelled flips true (Stop in the inter-attempt gap, #52)', async () => {
    const events: LoopEvent[] = []
    let cancelled = false
    let turns = 0
    const hooks = {
      onSession: (): void => undefined,
      isCancelled: (): boolean => cancelled,
      awaitPlanDecision: async (): Promise<{ decision: 'approve' }> => ({ decision: 'approve' })
    }
    const failingCheckSeam: TicketSeam = {
      runTurn: async () => ((turns++), (cancelled = true), okTurn), // after attempt 1's turn, a Stop arrives
      runCheck: async () => ({ passed: false, code: 1, timedOut: false }), // would normally drive a retry
      runReview: async () => ({ approved: false, feedback: 'x' })
    }
    const out = await runTicketFlow(
      { ...ticket, check: 'npm test' },
      cfg({ maxAttemptsPerTicket: 3 }),
      deps(events),
      failingCheckSeam,
      hooks
    )
    expect(out.terminal).toBe('review')
    expect(turns).toBe(1) // attempt 2 bailed at the isCancelled gate before starting another turn
  })
  it('passes captured check output into the retry instead of leaving the worker to guess', async () => {
    let retryFeedback = ''
    let turns = 0
    const failingCheckSeam: TicketSeam = {
      runTurn: async (_ticket, _config, _deps, revision) => {
        turns++
        if (revision) retryFeedback = revision.feedback
        return okTurn
      },
      runCheck: async () => ({ passed: false, code: 1, timedOut: false, output: 'Get-ChildItem: cannot find path' }),
      runReview: async () => ({ approved: false, feedback: '' })
    }
    const events: LoopEvent[] = []
    const out = await runTicketFlow({ ...ticket, check: 'Get-ChildItem missing.py' }, cfg({ maxAttemptsPerTicket: 2 }), deps(events), failingCheckSeam)
    expect(out.terminal).toBe('park')
    expect(turns).toBe(2)
    expect(retryFeedback).toContain('Get-ChildItem: cannot find path')
    expect(retryFeedback).toContain('Do not alter shell aliases')
    expect(events.some((e) => e.kind === 'check-result' && (e as { output: string }).output.includes('cannot find path'))).toBe(true)
  })
})

// ---- Plan-gate (#53) ----
function planHooks(decision: PlanDecision) {
  return {
    onSession: (): void => undefined,
    isCancelled: (): boolean => false,
    awaitPlanDecision: async (): Promise<PlanDecision> => decision
  }
}

describe('runTicketFlow — plan-gate (#53)', () => {
  it('gate OFF → never runs a plan turn (drain unchanged)', async () => {
    let planCalls = 0
    const seam: TicketSeam = {
      runTurn: async () => okTurn,
      runPlan: async () => ((planCalls++), okTurn),
      runCheck: async () => ({ passed: true, code: 0, timedOut: false }),
      runReview: async () => ({ approved: true, feedback: '' }),
      persistPlan: async () => undefined
    }
    const out = await runTicketFlow(ticket, cfg({ swapModels: false }), deps([]), seam, planHooks({ decision: 'approve' }))
    expect(planCalls).toBe(0)
    expect(out.terminal).toBe('review') // no reviewer/check → human review, unchanged
  })

  it('gate ON + approve → seeds the act turn with the plan, persists it, emits plan-ready', async () => {
    let seededPlan: string | undefined
    let persisted: string | undefined
    const events: LoopEvent[] = []
    const seam: TicketSeam = {
      runTurn: async (_t, _c, _d, _r, _h, approvedPlan) => ((seededPlan = approvedPlan), okTurn),
      runPlan: async () => ({ ...okTurn, text: 'PLAN: do X' }),
      runCheck: async () => ({ passed: true, code: 0, timedOut: false }),
      runReview: async () => ({ approved: true, feedback: '' }),
      persistPlan: async (_t, _c, plan) => void (persisted = plan)
    }
    const out = await runTicketFlow(ticket, cfg({ reviewPlans: true, swapModels: false }), deps(events), seam, planHooks({ decision: 'approve' }))
    expect(seededPlan).toBe('PLAN: do X')
    expect(persisted).toBe('PLAN: do X')
    expect(events.some((e) => e.kind === 'plan-ready' && (e as { plan: string }).plan === 'PLAN: do X')).toBe(true)
    expect(out.terminal).toBe('review')
  })

  it('gate ON + edited plan → the act turn gets the EDITED plan', async () => {
    let seededPlan: string | undefined
    const seam: TicketSeam = {
      runTurn: async (_t, _c, _d, _r, _h, approvedPlan) => ((seededPlan = approvedPlan), okTurn),
      runPlan: async () => ({ ...okTurn, text: 'ORIGINAL' }),
      runCheck: async () => ({ passed: true, code: 0, timedOut: false }),
      runReview: async () => ({ approved: true, feedback: '' }),
      persistPlan: async () => undefined
    }
    await runTicketFlow(ticket, cfg({ reviewPlans: true, swapModels: false }), deps([]), seam, planHooks({ decision: 'approve', editedPlan: 'EDITED PLAN' }))
    expect(seededPlan).toBe('EDITED PLAN')
  })

  it('gate ON + reject → review, no act turn, no persist', async () => {
    let turns = 0
    let persisted = false
    const seam: TicketSeam = {
      runTurn: async () => ((turns++), okTurn),
      runPlan: async () => ({ ...okTurn, text: 'PLAN' }),
      runCheck: async () => ({ passed: true, code: 0, timedOut: false }),
      runReview: async () => ({ approved: true, feedback: '' }),
      persistPlan: async () => void (persisted = true)
    }
    const out = await runTicketFlow(ticket, cfg({ reviewPlans: true, swapModels: false }), deps([]), seam, planHooks({ decision: 'reject' }))
    expect(out.terminal).toBe('review')
    expect(turns).toBe(0) // worktree never touched
    expect(persisted).toBe(false)
  })

  it('gate ON + a cancelled plan turn → review without awaiting a decision', async () => {
    let awaited = 0
    const seam: TicketSeam = {
      runTurn: async () => okTurn,
      runPlan: async () => ({ ...okTurn, stopReason: 'cancelled', text: '' }),
      runCheck: async () => ({ passed: true, code: 0, timedOut: false }),
      runReview: async () => ({ approved: true, feedback: '' }),
      persistPlan: async () => undefined
    }
    const hooks = {
      onSession: (): void => undefined,
      isCancelled: (): boolean => false,
      awaitPlanDecision: async (): Promise<PlanDecision> => ((awaited++), { decision: 'approve' })
    }
    const out = await runTicketFlow(ticket, cfg({ reviewPlans: true, swapModels: false }), deps([]), seam, hooks)
    expect(out.terminal).toBe('review')
    expect(awaited).toBe(0) // a cancelled plan turn short-circuits before the human gate
  })
})

describe('runTicketFlow — token accounting (W3c)', () => {
  it('sums prompt AND completion tokens into the cap, so output-heavy turns count', async () => {
    const events: LoopEvent[] = []
    const s = seam([true])
    s.runTurn = async () => ({ ...okTurn, promptTokens: 10, completionTokens: 990 })
    const out = await runTicketFlow(ticket, cfg({ reviewerConnectionId: 'rev', swapModels: false }), deps(events), s)
    expect(out.tokens).toBe(1000) // 10 prompt + 990 completion — prompt alone would report 10
  })

  it('missing completionTokens (older server) degrades to prompt-only counting', async () => {
    const events: LoopEvent[] = []
    const s = seam([true])
    s.runTurn = async () => ({ ...okTurn, promptTokens: 10 })
    const out = await runTicketFlow(ticket, cfg({ reviewerConnectionId: 'rev', swapModels: false }), deps(events), s)
    expect(out.tokens).toBe(10)
  })
})
