import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoardRunner, depsInstallCommand, type BoardClient, type BoardTicket, type TicketOutcome, type TicketRunHooks } from './boardRunner'
import type { LoopConfig, LoopEvent, PlanDecision } from '../../shared/ipc-types'
import { buildSeedMessage, captureTurn } from './boardSeed'
import { decideTerminal } from './boardDecide'
import type { Emit } from './events'

function ticket(id: number): BoardTicket {
  return { id, title: `T${id}`, body: '', status: 'in_progress', project: 'p' }
}

function cfg(caps: Partial<LoopConfig['caps']> = {}, extra: Partial<LoopConfig> = {}): LoopConfig {
  return {
    cwd: '/x',
    connectionId: 'c',
    project: 'p',
    mode: 'auto',
    caps: { maxTickets: 100, maxTokens: 0, maxWallclockSec: 3600, maxConsecutiveFailures: 100, ...caps },
    ...extra
  }
}

// A runner with a fake board (claimNext driven by a queue) + collected events + recorded setStatus calls.
function harness(opts: {
  claims: BoardTicket[]
  summary?: { ready: number; in_progress: number; review: number }
  reviewIds?: number[]
}) {
  const events: LoopEvent[] = []
  const setStatusCalls: { id: number; status: string }[] = []
  const claims = [...opts.claims]
  const client: BoardClient = {
    claimNext: async () => claims.shift() ?? null,
    setStatus: async (id, status) => {
      setStatusCalls.push({ id, status })
    },
    summary: async () => opts.summary ?? { ready: 1, in_progress: 0, review: 0 },
    listReview: async () => opts.reviewIds ?? []
  }
  const runner = new BoardRunner()
  runner.makeClient = () => client
  runner.emit = (e) => events.push(e)
  runner.git = async () => ({ code: 0, stdout: '', stderr: '' }) // no real branch/commit during tests
  runner.writeIgnore = () => {} // no disk writes during tests
  runner.linkDeps = () => {} // no node_modules junction during tests
  runner.unlinkDeps = () => {} // no disk writes during tests
  runner.runCmd = async () => ({ code: 0, timedOut: false }) // no real npm install during tests
  runner.swapToReviewer = async () => {} // no real model swap during tests
  runner.runTicket = async (): Promise<TicketOutcome> => ({ terminal: 'review' })
  return { runner, events, setStatusCalls }
}

const startedIds = (events: LoopEvent[]): number[] =>
  events.filter((e) => e.kind === 'ticket-started').map((e) => (e as { id: number }).id)
const stopReason = (events: LoopEvent[]): string | undefined =>
  (events.find((e) => e.kind === 'stopped') as { reason: string } | undefined)?.reason

describe('BoardRunner outer loop', () => {
  it('drains all claimable tickets then stops board-green', async () => {
    const h = harness({ claims: [ticket(1), ticket(2), ticket(3)] })
    h.runner.start(cfg())
    await h.runner.loopDone
    expect(startedIds(h.events)).toEqual([1, 2, 3])
    expect(h.events.filter((e) => e.kind === 'ticket-done')).toHaveLength(3)
    expect(stopReason(h.events)).toBe('board-green')
  })

  it('stops immediately when the board is already green', async () => {
    const h = harness({ claims: [ticket(1)], summary: { ready: 0, in_progress: 0, review: 0 } })
    h.runner.start(cfg())
    await h.runner.loopDone
    expect(startedIds(h.events)).toEqual([])
    expect(stopReason(h.events)).toBe('board-green')
  })

  it('never runs a ticket returned from a different project', async () => {
    const foreign = { ...ticket(7), project: 'other-raid' }
    const h = harness({ claims: [foreign] })
    h.runner.start(cfg())
    await h.runner.loopDone
    expect(startedIds(h.events)).toEqual([])
    expect(h.setStatusCalls).toContainEqual({ id: 7, status: 'todo' })
    expect(stopReason(h.events)).toBe('error')
  })

  it('dead-ends board-green when only review tickets remain and includeReview is OFF (the bug)', async () => {
    // Nothing claimable, but two tickets sit in review. Default behaviour: finish without touching them.
    const h = harness({ claims: [], summary: { ready: 0, in_progress: 0, review: 2 }, reviewIds: [5, 6] })
    h.runner.start(cfg())
    await h.runner.loopDone
    expect(h.setStatusCalls.filter((c) => c.status === 'todo')).toEqual([])
    expect(stopReason(h.events)).toBe('board-green')
  })

  it('with includeReview ON, reopens review tickets (review → todo) then converges (each reopened once)', async () => {
    const h = harness({ claims: [], summary: { ready: 0, in_progress: 0, review: 2 }, reviewIds: [5, 6] })
    h.runner.start(cfg({}, { includeReview: true }))
    await h.runner.loopDone
    // Both review tickets reopened to todo exactly once — no infinite churn despite the static summary.
    const reopened = h.setStatusCalls.filter((c) => c.status === 'todo').map((c) => c.id)
    expect(reopened.sort()).toEqual([5, 6])
    expect(stopReason(h.events)).toBe('board-green')
  })

  it('honours the maxTickets cap', async () => {
    const h = harness({ claims: [ticket(1), ticket(2), ticket(3), ticket(4)] })
    h.runner.start(cfg({ maxTickets: 2 }))
    await h.runner.loopDone
    expect(startedIds(h.events)).toEqual([1, 2])
    expect(stopReason(h.events)).toBe('max-tickets')
  })

  it('stops after maxConsecutiveFailures; a success resets the counter', async () => {
    const a = harness({ claims: [ticket(1), ticket(2), ticket(3)] })
    a.runner.runTicket = async () => {
      throw new Error('boom')
    }
    a.runner.start(cfg({ maxConsecutiveFailures: 2 }))
    await a.runner.loopDone
    expect(a.events.filter((e) => e.kind === 'ticket-failed')).toHaveLength(2)
    expect(stopReason(a.events)).toBe('max-failures')

    let n = 0
    const b = harness({ claims: [ticket(1), ticket(2), ticket(3)] })
    b.runner.runTicket = async (): Promise<TicketOutcome> => {
      n++
      if (n === 1) throw new Error('x')
      return { terminal: 'done' }
    }
    b.runner.start(cfg({ maxConsecutiveFailures: 2 }))
    await b.runner.loopDone
    expect(stopReason(b.events)).toBe('board-green') // drained (1 fail + 2 done), counter reset prevented max-failures
  })

  it('stops on user request after the in-flight ticket settles', async () => {
    const h = harness({ claims: [ticket(1), ticket(2), ticket(3)] })
    h.runner.runTicket = async (t): Promise<TicketOutcome> => {
      if (t.id === 1) h.runner.stop()
      return { terminal: 'review' }
    }
    h.runner.start(cfg())
    await h.runner.loopDone
    expect(startedIds(h.events)).toEqual([1]) // #1 finishes, then the loop exits before claiming #2
    expect(stopReason(h.events)).toBe('user')
  })

  it('maps terminals to board status (done→done, park→todo)', async () => {
    const h = harness({ claims: [ticket(1), ticket(2)] })
    h.runner.runTicket = async (t): Promise<TicketOutcome> => ({ terminal: t.id === 1 ? 'done' : 'park' })
    h.runner.start(cfg())
    await h.runner.loopDone
    // park = status back to todo (+ a comment, ignored by the fake), and the id joins the parked set.
    expect(h.setStatusCalls).toEqual([
      { id: 1, status: 'done' },
      { id: 2, status: 'todo' }
    ])
  })

  it('R4: a park records its reason in parkReasons (surfaced to the replanner)', async () => {
    const h = harness({ claims: [ticket(1)] })
    h.runner.runTicket = async (): Promise<TicketOutcome> => ({ terminal: 'park', parkReason: 'check-broken: uses bash test -f' })
    h.runner.start(cfg())
    await h.runner.loopDone
    expect(h.runner.parkedIds.has(1)).toBe(true)
    expect(h.runner.parkReasons.get(1)).toBe('check-broken: uses bash test -f')
  })

  it('a re-claimed parked ticket is set aside (→review), and the drain keeps working other ready tickets', async () => {
    // The "stopped with work still left" bug: claim_next returns the lowest-id READY ticket, so a low-id PARKED
    // blocker (#1) gets handed back before an independent ready ticket (#2). The old code stopped the whole run on
    // that re-claim; #2 was never worked. Now #1 is set aside to review and the drain continues to #2.
    // Claim order mirrors reality: #1 (parks), then #1 again (re-claimed parked), then #2, then null.
    const h = harness({ claims: [ticket(1), ticket(1), ticket(2)] })
    h.runner.runTicket = async (t): Promise<TicketOutcome> => (t.id === 1 ? { terminal: 'park', parkReason: 'check failing' } : { terminal: 'review' })
    h.runner.start(cfg())
    await h.runner.loopDone
    // #2 got worked (it did NOT get starved by the parked #1), and the run ended board-green — not early.
    expect(startedIds(h.events)).toEqual([1, 2])
    expect(stopReason(h.events)).toBe('board-green')
    // #1: parked (→todo) on its first run, then set aside (→review) when re-claimed. #2 settled to review.
    expect(h.setStatusCalls).toEqual([
      { id: 1, status: 'todo' },
      { id: 1, status: 'review' },
      { id: 2, status: 'review' }
    ])
    expect(h.runner.parkedSetAside.has(1)).toBe(true)
  })

  it('auto-initializes a git repo when the workspace is not one, then branches', async () => {
    const h = harness({ claims: [ticket(1)] })
    const gitCalls: string[][] = []
    // Simulate a NON-repo: rev-parse --is-inside-work-tree fails (exit 128) until init runs.
    h.runner.git = async (_cwd, args) => {
      gitCalls.push(args)
      if (args[0] === 'rev-parse') return { code: 128, stdout: '', stderr: 'not a git repository' }
      return { code: 0, stdout: '', stderr: '' }
    }
    h.runner.start(cfg())
    await h.runner.loopDone
    const cmds = gitCalls.map((a) => a.join(' '))
    expect(cmds).toContain('init')
    expect(cmds.some((c) => c.startsWith('worktree add -b board/'))).toBe(true)
    expect(h.events.some((e) => e.kind === 'notice' && /initialized a git repository/.test((e as { text: string }).text))).toBe(true)
    expect(startedIds(h.events)).toEqual([1]) // run proceeded after auto-init
  })

  it('does not re-init when the workspace is already a git repo', async () => {
    const h = harness({ claims: [ticket(1)] })
    const gitCalls: string[][] = []
    h.runner.git = async (_cwd, args) => {
      gitCalls.push(args)
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'true', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    h.runner.start(cfg())
    await h.runner.loopDone
    expect(gitCalls.map((a) => a[0])).not.toContain('init')
    expect(startedIds(h.events)).toEqual([1])
  })

  it('isolates a Hermes raid nested in a FOREIGN repo by initializing its own repo (review-diff scoping)', async () => {
    const h = harness({ claims: [ticket(1)] })
    const gitCalls: string[][] = []
    h.runner.git = async (_cwd, args) => {
      gitCalls.push(args)
      // The raid (/x) sits INSIDE a foreign monorepo whose toplevel is /other — not the raid folder itself.
      if (args[0] === 'rev-parse') return { code: 0, stdout: '/other/monorepo', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    h.runner.start(cfg({}, { branchPerRun: false }))
    await h.runner.loopDone
    const cmds = gitCalls.map((a) => a.join(' '))
    expect(cmds).toContain('init') // re-rooted: a raid nested in a foreign repo gets its OWN repo so diffs scope to it
    expect(cmds.some((c) => c.startsWith('worktree'))).toBe(false) // branchPerRun:false → no worktree
    expect(h.events.some((e) => e.kind === 'notice' && /isolated git repo/.test((e as { text: string }).text))).toBe(true)
    expect(startedIds(h.events)).toEqual([1])
  })

  it('does NOT isolate when the Hermes raid is already its own repo root', async () => {
    const h = harness({ claims: [ticket(1)] })
    const gitCalls: string[][] = []
    h.runner.git = async (cwd, args) => {
      gitCalls.push(args)
      if (args[0] === 'rev-parse') return { code: 0, stdout: cwd, stderr: '' } // toplevel === cwd → already its own repo
      return { code: 0, stdout: '', stderr: '' }
    }
    h.runner.start(cfg({}, { branchPerRun: false }))
    await h.runner.loopDone
    expect(gitCalls.map((a) => a[0])).not.toContain('init')
    expect(startedIds(h.events)).toEqual([1])
  })

  it('aborts the run cleanly if git init fails', async () => {
    const h = harness({ claims: [ticket(1)] })
    h.runner.git = async (_cwd, args) => {
      if (args[0] === 'rev-parse') return { code: 128, stdout: '', stderr: '' }
      if (args[0] === 'init') return { code: -1, stdout: '', stderr: 'git missing' }
      return { code: 0, stdout: '', stderr: '' }
    }
    h.runner.start(cfg())
    await h.runner.loopDone
    expect(startedIds(h.events)).toEqual([]) // never claimed a ticket
    expect(stopReason(h.events)).toBe('error')
  })

  it('does NOT auto-init when git is unavailable (rev-parse -1, not 128)', async () => {
    const h = harness({ claims: [ticket(1)] })
    const gitCalls: string[][] = []
    h.runner.git = async (_cwd, args) => {
      gitCalls.push(args)
      if (args[0] === 'rev-parse') return { code: -1, stdout: '', stderr: '' } // git missing / timeout sentinel
      return { code: 0, stdout: '', stderr: '' }
    }
    h.runner.start(cfg())
    await h.runner.loopDone
    expect(gitCalls.map((a) => a[0])).not.toContain('init') // never nests a repo when git is merely unavailable
    expect(startedIds(h.events)).toEqual([])
    expect(stopReason(h.events)).toBe('error')
  })

  it('runs an existing repo in an isolated worktree (no re-init, no dirty-tree refusal)', async () => {
    const h = harness({ claims: [ticket(1)] })
    const gitCalls: string[][] = []
    h.runner.git = async (_cwd, args) => {
      gitCalls.push(args)
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { code: 0, stdout: 'true', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    h.runner.start(cfg())
    await h.runner.loopDone
    expect(gitCalls.map((a) => a[0])).not.toContain('init') // existing repo → no init
    expect(gitCalls.some((a) => a[0] === 'worktree' && a[1] === 'add')).toBe(true) // isolated via a worktree
    expect(startedIds(h.events)).toEqual([1]) // proceeds — a dirty tree no longer blocks (worktree branches off HEAD)
  })

  it('aborts cleanly if the worktree cannot be created', async () => {
    const h = harness({ claims: [ticket(1)] })
    h.runner.git = async (_cwd, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { code: 0, stdout: 'true', stderr: '' }
      if (args[0] === 'worktree') return { code: 1, stdout: '', stderr: 'fatal: worktree already exists' }
      return { code: 0, stdout: '', stderr: '' }
    }
    h.runner.start(cfg())
    await h.runner.loopDone
    expect(startedIds(h.events)).toEqual([])
    expect(stopReason(h.events)).toBe('error')
  })

  it('resume continues counters and reuses the run worktree (does not restart)', async () => {
    const worktreeAdds: string[] = []
    const h = harness({ claims: [ticket(1), ticket(2)] })
    h.runner.git = async (_cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'add') worktreeAdds.push(args.join(' '))
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { code: 0, stdout: 'true', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    h.runner.runTicket = async (): Promise<TicketOutcome> => {
      h.runner.pause() // pause during the first ticket
      return { terminal: 'review' }
    }
    h.runner.start(cfg())
    await h.runner.loopDone
    expect(startedIds(h.events)).toEqual([1]) // paused after #1

    h.runner.runTicket = async (): Promise<TicketOutcome> => ({ terminal: 'review' })
    h.runner.start(cfg()) // Resume
    await h.runner.loopDone
    expect(startedIds(h.events)).toEqual([1, 2]) // #2 ran after resume — counters continued, not reset to zero
    expect(worktreeAdds.length).toBe(1) // worktree created once on the first start, reused on resume
  })
})

// ---- Per-ticket lifecycle controls (#52): cancellation seam + skip/retry/pause ----
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
async function waitFor(cond: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) await tick()
  if (!cond()) throw new Error('waitFor: condition not met in time')
}

/** A runTicket whose turn registers a fake session and blocks until cancelled (Stop) or explicitly released. */
function controllable() {
  let cancelled = false
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const run = async (_t: BoardTicket, _c: LoopConfig, hooks: TicketRunHooks): Promise<TicketOutcome> => {
    hooks.onSession({ cancel: () => ((cancelled = true), release()) })
    await gate
    hooks.onSession(null)
    return { terminal: 'review' }
  }
  return { run, release: (): void => release(), wasCancelled: (): boolean => cancelled }
}

/** A runTicket that IMMEDIATELY enters the "settling" state — session already cleared (null) while the ticket
 *  is still currentTicket — then blocks, so a test can fire ticketAction in that TOCTOU window before the
 *  drain writes the terminal. Returns 'done' on release. */
function settling() {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let entered = false
  const run = async (_t: BoardTicket, _c: LoopConfig, hooks: TicketRunHooks): Promise<TicketOutcome> => {
    hooks.onSession({ cancel: () => undefined })
    hooks.onSession(null) // turn settled: currentSession null, but the drain hasn't cleared currentTicket yet
    entered = true
    await gate
    return { terminal: 'done' }
  }
  return { run, release: (): void => release(), entered: (): boolean => entered }
}

describe('BoardRunner per-ticket controls (#52)', () => {
  it('global Stop cancels the in-flight ticket turn (not just at the next boundary)', async () => {
    const h = harness({ claims: [ticket(1), ticket(2)] })
    const c = controllable()
    h.runner.runTicket = c.run
    h.runner.start(cfg())
    await waitFor(() => startedIds(h.events).includes(1))
    h.runner.stop()
    await h.runner.loopDone
    expect(c.wasCancelled()).toBe(true)
    expect(startedIds(h.events)).toEqual([1]) // #2 never claimed
    expect(stopReason(h.events)).toBe('user')
  })

  it('per-ticket stop aborts that ticket and the drain continues to the next', async () => {
    const h = harness({ claims: [ticket(1), ticket(2)] })
    const c = controllable()
    h.runner.runTicket = (t, cf, hooks) => (t.id === 1 ? c.run(t, cf, hooks) : Promise.resolve({ terminal: 'review' }))
    h.runner.start(cfg())
    await waitFor(() => startedIds(h.events).includes(1))
    await h.runner.ticketAction(1, 'stop')
    await h.runner.loopDone
    expect(c.wasCancelled()).toBe(true)
    expect(startedIds(h.events)).toEqual([1, 2]) // continued past the stopped ticket
    expect(stopReason(h.events)).toBe('board-green')
  })

  it('a ticket skipped mid-run is released to review and never started by the drain', async () => {
    const h = harness({ claims: [ticket(1), ticket(2)] })
    const c = controllable()
    // #1 blocks in-flight so #2 is still queued when we skip it.
    h.runner.runTicket = (t, cf, hooks) => (t.id === 1 ? c.run(t, cf, hooks) : Promise.resolve({ terminal: 'review' }))
    h.runner.start(cfg())
    await waitFor(() => startedIds(h.events).includes(1))
    await h.runner.ticketAction(2, 'skip') // #2 is queued, not in flight
    c.release() // let #1 finish; the drain then claims #2 and must skip it
    await h.runner.loopDone
    expect(startedIds(h.events)).toEqual([1]) // #2 skipped, never started
    expect(h.setStatusCalls).toContainEqual({ id: 2, status: 'review' })
  })

  it('ticketAction(skip) writes the queued ticket to review and records it', async () => {
    const h = harness({ claims: [] })
    const r = await h.runner.ticketAction(5, 'skip')
    expect(r.ok).toBe(true)
    expect(h.runner.skippedIds.has(5)).toBe(true)
    expect(h.setStatusCalls).toContainEqual({ id: 5, status: 'review' })
  })

  it('ticketAction(retry) re-queues a parked ticket (board → todo, clears the parked set)', async () => {
    const h = harness({ claims: [] })
    h.runner.parkedIds.add(7)
    const r = await h.runner.ticketAction(7, 'retry')
    expect(r.ok).toBe(true)
    expect(h.setStatusCalls).toContainEqual({ id: 7, status: 'todo' })
    expect(h.runner.parkedIds.has(7)).toBe(false)
  })

  it('ticketAction(pause) pauses the run after the in-flight ticket settles (no cancel)', async () => {
    const h = harness({ claims: [ticket(1), ticket(2)] })
    const c = controllable()
    h.runner.runTicket = (t, cf, hooks) => (t.id === 1 ? c.run(t, cf, hooks) : Promise.resolve({ terminal: 'review' }))
    h.runner.start(cfg())
    await waitFor(() => startedIds(h.events).includes(1))
    await h.runner.ticketAction(1, 'pause')
    c.release() // let #1 finish normally
    await h.runner.loopDone
    expect(c.wasCancelled()).toBe(false)
    expect(h.events.some((e) => e.kind === 'paused')).toBe(true)
    expect(startedIds(h.events)).toEqual([1]) // paused before claiming #2
  })

  it('emits run-stats carrying the live currentTicket while a ticket is in flight (drives the UI active state)', async () => {
    const h = harness({ claims: [ticket(1)] })
    const c = controllable()
    h.runner.runTicket = c.run
    h.runner.start(cfg())
    const liveActive = (): boolean =>
      h.events.some((e) => e.kind === 'run-stats' && (e as { status: { currentTicket?: number } }).status.currentTicket === 1)
    await waitFor(liveActive)
    expect(liveActive()).toBe(true) // without this the inline Stop + "working" badge + live diff never appear
    c.release()
    await h.runner.loopDone
  })

  it('stop/skip in the settle window (session null, ticket still current) does not clobber the terminal', async () => {
    const h = harness({ claims: [ticket(1)] })
    const s = settling()
    h.runner.runTicket = s.run
    h.runner.start(cfg())
    await waitFor(() => s.entered())
    const r = await h.runner.ticketAction(1, 'skip') // would have demoted the just-finished ticket pre-fix
    s.release()
    await h.runner.loopDone
    expect(r.ok).toBe(true)
    expect(h.runner.skippedIds.has(1)).toBe(false) // routed to cancelCurrent, NOT skipTicket
    expect(h.setStatusCalls.filter((c) => c.id === 1)).toEqual([{ id: 1, status: 'done' }]) // only the drain's terminal
  })

  it('skip refuses a ticket the drain already settled this run (no demotion of finished work)', async () => {
    const h = harness({ claims: [ticket(1)] })
    h.runner.runTicket = async () => ({ terminal: 'done' })
    h.runner.start(cfg())
    await h.runner.loopDone
    const r = await h.runner.ticketAction(1, 'skip') // stray click on the finished ticket
    expect(r.ok).toBe(false)
    expect(h.setStatusCalls.filter((c) => c.id === 1 && c.status === 'review')).toEqual([]) // never demoted to review
  })

  it('resolvePlan resolves an open plan-gate with the user verdict (#53)', async () => {
    const h = harness({ claims: [ticket(1)] })
    let decided: PlanDecision | null = null
    let gateOpen = false
    h.runner.runTicket = async (_t, _c, hooks) => {
      const p = hooks.awaitPlanDecision('PLAN') // sets pendingPlan synchronously
      gateOpen = true
      decided = await p
      return { terminal: 'review' }
    }
    h.runner.start(cfg())
    await waitFor(() => gateOpen)
    const r = h.runner.resolvePlan(1, { decision: 'approve', editedPlan: 'E' })
    await h.runner.loopDone
    expect(r.ok).toBe(true)
    expect(decided).toEqual({ decision: 'approve', editedPlan: 'E' })
  })

  it('a global Stop during a plan-gate resolves it as cancel — no hang (#53)', async () => {
    const h = harness({ claims: [ticket(1)] })
    let decided: PlanDecision | null = null
    let gateOpen = false
    h.runner.runTicket = async (_t, _c, hooks) => {
      const p = hooks.awaitPlanDecision('PLAN') // sets pendingPlan synchronously
      gateOpen = true
      decided = await p
      return { terminal: 'review' }
    }
    h.runner.start(cfg())
    await waitFor(() => gateOpen)
    h.runner.stop()
    await h.runner.loopDone
    expect(decided).toEqual({ decision: 'cancel' })
    expect(stopReason(h.events)).toBe('user')
  })
})

describe('T4 inner-loop helpers (boardSeed)', () => {
  it('seed = title + body, appends spec only when spec_ref AND spec are present', () => {
    // The seed STARTS with title+body; a lean-research directive is always appended (relevant-files optimization).
    expect(buildSeedMessage({ title: 'A', body: 'do it', spec_ref: null })).toMatch(/^A\n\ndo it/)
    expect(buildSeedMessage({ title: 'A', body: 'do it', spec_ref: null })).not.toContain('--- Spec')
    expect(buildSeedMessage({ title: 'A', body: '', spec_ref: null })).toMatch(/^A\n\n\(no description\)/)
    expect(buildSeedMessage({ title: 'A', body: 'b', spec_ref: 'SPEC.md' }, 'SPEC CONTENT')).toContain(
      '--- Spec (SPEC.md) ---\nSPEC CONTENT'
    )
    expect(buildSeedMessage({ title: 'A', body: 'b', spec_ref: 'SPEC.md' }, null)).not.toContain('--- Spec') // spec_ref but no spec content → no spec section
  })

  it('appends reviewer feedback only on a retry (RV3)', () => {
    expect(buildSeedMessage({ title: 'A', body: 'b', spec_ref: null })).not.toContain('Revision')
    const s = buildSeedMessage({ title: 'A', body: 'b', spec_ref: null }, null, { attempt: 2, feedback: 'add tests' })
    expect(s).toContain('--- Revision (attempt 2) ---')
    expect(s).toContain('add tests')
    // blank feedback → no revision section
    expect(buildSeedMessage({ title: 'A', body: 'b', spec_ref: null }, null, { attempt: 2, feedback: '   ' })).not.toContain('Revision')
  })

  it('appends the approved-plan section only when a non-blank plan is given (plan-gate #53)', () => {
    const s = buildSeedMessage({ title: 'A', body: 'b', spec_ref: null }, null, undefined, 'STEP 1\nSTEP 2')
    expect(s).toContain('--- Approved plan (follow it) ---')
    expect(s).toContain('STEP 1')
    expect(buildSeedMessage({ title: 'A', body: 'b', spec_ref: null }, null, undefined, '   ')).not.toContain('Approved plan')
    expect(buildSeedMessage({ title: 'A', body: 'b', spec_ref: null })).not.toContain('Approved plan')
  })

  it('captureTurn records the LAST usage promptTokens and the turn-done stopReason', async () => {
    const run = async (emit: Emit) => {
      emit({ type: 'usage', turnId: 't', promptTokens: 100, completionTokens: 40, contextLimit: 8000 })
      emit({ type: 'usage', turnId: 't', promptTokens: 250, completionTokens: 90, contextLimit: 8000 })
      emit({ type: 'turn-done', turnId: 't', stopReason: 'completed', editedFiles: 2 })
    }
    const r = await captureTurn('t', 7, run)
    expect(r.promptTokens).toBe(250)
    expect(r.completionTokens).toBe(90) // cumulative from the loop — last wins = turn total (W3c)
    expect(r.stopReason).toBe('completed')
    expect(r.editedFiles).toBe(2)
    expect(r.ticketId).toBe(7)
  })

  it('captureTurn keeps the last known completionTokens when a later usage omits it (older server)', async () => {
    const run = async (emit: Emit) => {
      emit({ type: 'usage', turnId: 't', promptTokens: 100, completionTokens: 40, contextLimit: 8000 })
      emit({ type: 'usage', turnId: 't', promptTokens: 250, contextLimit: 8000 })
      emit({ type: 'turn-done', turnId: 't', stopReason: 'completed' })
    }
    const r = await captureTurn('t', 7, run)
    expect(r.promptTokens).toBe(250)
    expect(r.completionTokens).toBe(40)
  })

  it('captureTurn coerces a thrown run to stopReason error', async () => {
    const r = await captureTurn('t', 1, async () => {
      throw new Error('boom')
    })
    expect(r.stopReason).toBe('error')
    expect(r.error).toBe('boom')
  })

  it('captureTurn forwards every inner event to the feed', async () => {
    const seen: string[] = []
    await captureTurn(
      't',
      1,
      async (emit) => {
        emit({ type: 'usage', turnId: 't', promptTokens: 1, contextLimit: 1 })
        emit({ type: 'turn-done', turnId: 't', stopReason: 'completed' })
      },
      (e) => seen.push(e.type)
    )
    expect(seen).toEqual(['usage', 'turn-done'])
  })
})

describe('T5 decideTerminal', () => {
  const pass = { passed: true, code: 0, timedOut: false }
  const fail1 = { passed: false, code: 1, timedOut: false }
  const timeout = { passed: false, code: null, timedOut: true }

  it('no check → review', () => {
    expect(decideTerminal({ attemptsSoFar: 1, maxAttempts: 3 })).toEqual({ kind: 'review' })
  })
  it('empty/whitespace check → review regardless of outcome', () => {
    expect(decideTerminal({ check: '   ', outcome: pass, attemptsSoFar: 1, maxAttempts: 3 })).toEqual({ kind: 'review' })
  })
  it('check passed → done', () => {
    expect(decideTerminal({ check: 'npm test', outcome: pass, attemptsSoFar: 1, maxAttempts: 3 })).toEqual({ kind: 'done' })
  })
  it('terminalMode "review" downgrades a passing check to review (always-gate)', () => {
    expect(decideTerminal({ check: 'npm test', outcome: pass, attemptsSoFar: 1, maxAttempts: 3, terminalMode: 'review' })).toEqual({ kind: 'review' })
  })
  it('terminalMode "auto" keeps a passing check as done', () => {
    expect(decideTerminal({ check: 'npm test', outcome: pass, attemptsSoFar: 1, maxAttempts: 3, terminalMode: 'auto' })).toEqual({ kind: 'done' })
  })
  it('check failed below cap → iterate to next attempt', () => {
    expect(decideTerminal({ check: 'npm test', outcome: fail1, attemptsSoFar: 1, maxAttempts: 3 })).toEqual({ kind: 'iterate', attempt: 2 })
  })
  it('check failed at cap → park, reason names the attempts + exit code', () => {
    const t = decideTerminal({ check: 'npm test', outcome: fail1, attemptsSoFar: 3, maxAttempts: 3 })
    expect(t.kind).toBe('park')
    if (t.kind === 'park') {
      expect(t.reason).toContain('3 attempts')
      expect(t.reason).toContain('exit 1')
    }
  })
  it('timeout iterates below cap and parks (with "timed out") at the cap', () => {
    expect(decideTerminal({ check: 'x', outcome: timeout, attemptsSoFar: 1, maxAttempts: 3 })).toMatchObject({ kind: 'iterate' })
    const t = decideTerminal({ check: 'x', outcome: timeout, attemptsSoFar: 3, maxAttempts: 3 })
    expect(t.kind).toBe('park')
    if (t.kind === 'park') expect(t.reason).toContain('timed out')
  })
  it('code null (spawn failure) is a fail, never done', () => {
    const t = decideTerminal({ check: 'x', outcome: { passed: false, code: null, timedOut: false }, attemptsSoFar: 1, maxAttempts: 3 })
    expect(t.kind).toBe('iterate')
  })
  it('check present but outcome undefined → throws', () => {
    expect(() => decideTerminal({ check: 'npm test', attemptsSoFar: 1, maxAttempts: 3 })).toThrow()
  })
})

describe('board check field → terminal path', () => {
  const pass = { passed: true, code: 0, timedOut: false }
  const fail = { passed: false, code: 1, timedOut: false }

  // A ticket WITH a non-empty check is treated as having a runnable, verifiable goal.
  it('non-empty check drives the verifiable path (done on pass)', () => {
    expect(decideTerminal({ check: 'npm test', outcome: pass, attemptsSoFar: 1, maxAttempts: 3 })).toEqual({ kind: 'done' })
  })
  it('non-empty check + failure below cap iterates; at the cap parks', () => {
    expect(decideTerminal({ check: 'npm test', outcome: fail, attemptsSoFar: 1, maxAttempts: 3 }).kind).toBe('iterate')
    expect(decideTerminal({ check: 'npm test', outcome: fail, attemptsSoFar: 3, maxAttempts: 3 }).kind).toBe('park')
  })
  // A ticket WITHOUT a check (undefined / empty / whitespace-only) is treated as no-check → review fallback.
  it.each([undefined, '', '   ', '\n\t'])('no runnable check (%j) → review', (check) => {
    expect(decideTerminal({ check, attemptsSoFar: 1, maxAttempts: 3 })).toEqual({ kind: 'review' })
  })
})
  it('never runs a ticket returned from a different project', async () => {
    const foreign = { ...ticket(7), project: 'other-raid' }
    const h = harness({ claims: [foreign] })
    h.runner.start(cfg())
    await h.runner.loopDone
    expect(startedIds(h.events)).toEqual([])
    expect(h.setStatusCalls).toContainEqual({ id: 7, status: 'todo' })
    expect(stopReason(h.events)).toBe('error')

  })

describe('BoardRunner parallel batch (parallelism > 1)', () => {
  const implT = (id: number, file: string): BoardTicket => ({
    id,
    title: `T${id}`,
    body: `**Department: implementation**\n**Files:** ${file}\n\nbuild it`,
    status: 'in_progress',
    project: 'p'
  })

  it('codes file-disjoint impl tickets concurrently, reviews each, merges approved → done', async () => {
    const h = harness({ claims: [implT(1, 'src/A.ts'), implT(2, 'src/B.ts')] })
    const gitCmds: string[] = []
    h.runner.git = async (_cwd, args) => {
      gitCmds.push(args.join(' '))
      return { code: 0, stdout: '', stderr: '' }
    }
    // runTicket default = code-only success ({terminal:'review'}); reviewTicket default = approve.
    h.runner.start(cfg({}, { branchPerRun: false, parallelism: 2 }))
    await h.runner.loopDone
    expect(gitCmds.filter((c) => c.startsWith('worktree add')).length).toBe(2) // one worktree per batched ticket
    // approved → graduate ONLY the declared file (scoped checkout), NOT a full merge (conflict-proof disjoint sets)
    expect(gitCmds.some((c) => c.startsWith('checkout') && c.includes('src/A.ts'))).toBe(true)
    expect(gitCmds.some((c) => c.startsWith('checkout') && c.includes('src/B.ts'))).toBe(true)
    expect(gitCmds.some((c) => c.includes('merge'))).toBe(false) // no full merge at all
    expect(h.setStatusCalls.filter((s) => s.status === 'done').map((s) => s.id).sort()).toEqual([1, 2])
    // INVARIANT: HEAD must be snapshotted BEFORE the worktrees fork, else they branch from an empty/stale baseline
    // and the coders open a project missing the prior tickets' scaffold (the real-run 36k-token rebuild loop).
    const snapshot = gitCmds.findIndex((c) => c.includes('pre-batch snapshot'))
    const firstWorktree = gitCmds.findIndex((c) => c.startsWith('worktree add'))
    expect(snapshot).toBeGreaterThanOrEqual(0)
    expect(snapshot).toBeLessThan(firstWorktree)
  })

  it('does ONE coder→reviewer swap for the whole batch, BEFORE any review (no 35B + reviewer co-resident)', async () => {
    const h = harness({ claims: [implT(1, 'src/A.ts'), implT(2, 'src/B.ts')] })
    const order: string[] = []
    h.runner.swapToReviewer = async () => {
      order.push('swap')
    }
    const approve = h.runner.reviewTicket
    h.runner.reviewTicket = async (t, c) => {
      order.push('review')
      return approve(t, c)
    }
    h.runner.start(cfg({}, { branchPerRun: false, parallelism: 2 }))
    await h.runner.loopDone
    expect(order.filter((x) => x === 'swap')).toHaveLength(1) // exactly ONE swap for the whole batch
    expect(order[0]).toBe('swap') // ...and it precedes the first review (coder freed before the reviewer loads)
    expect(order.filter((x) => x === 'review')).toHaveLength(2) // both reviewed after that single swap
  })

  it('re-queues a REJECTED batch ticket to todo and PERSISTS its feedback (no feedback lost)', async () => {
    const h = harness({ claims: [implT(1, 'src/A.ts'), implT(2, 'src/B.ts')] })
    h.runner.reviewTicket = async (t) => (t.id === 2 ? { approved: false, feedback: 'fix the edge case' } : { approved: true, feedback: '' })
    const saved: { id: number; feedback: string }[] = []
    h.runner.saveRejectionFeedback = (_cwd, id, _title, feedback) => {
      saved.push({ id, feedback })
    }
    h.runner.start(cfg({}, { branchPerRun: false, parallelism: 2 }))
    await h.runner.loopDone
    expect(h.setStatusCalls.find((s) => s.id === 1)?.status).toBe('done') // approved → merged
    expect(h.setStatusCalls.filter((s) => s.id === 2).some((s) => s.status === 'todo')).toBe(true) // rejected → re-queued
    expect(saved).toEqual([{ id: 2, feedback: 'fix the edge case' }]) // feedback preserved for the sequential revise
  })

  it('graduates the declared file even on a REJECT-then-approve mix without ever full-merging', async () => {
    const h = harness({ claims: [implT(1, 'src/A.ts'), implT(2, 'src/B.ts')] })
    const gitCmds: string[] = []
    h.runner.git = async (_cwd, args) => {
      gitCmds.push(args.join(' '))
      return { code: 0, stdout: '', stderr: '' }
    }
    h.runner.reviewTicket = async (t) => (t.id === 1 ? { approved: true, feedback: '' } : { approved: false, feedback: 'redo' })
    h.runner.start(cfg({}, { branchPerRun: false, parallelism: 2 }))
    await h.runner.loopDone
    expect(gitCmds.some((c) => c.startsWith('checkout') && c.includes('src/A.ts'))).toBe(true) // #1 approved → graduated
    expect(gitCmds.some((c) => c.includes('merge'))).toBe(false) // never a full merge
    expect(h.setStatusCalls.find((s) => s.id === 1)?.status).toBe('done')
  })

  it('parallelism=1 (default) never batches — the sequential path is untouched', async () => {
    const h = harness({ claims: [implT(1, 'src/A.ts'), implT(2, 'src/B.ts')] })
    const gitCmds: string[] = []
    h.runner.git = async (_cwd, args) => {
      gitCmds.push(args.join(' '))
      return { code: 0, stdout: '', stderr: '' }
    }
    h.runner.start(cfg({}, { branchPerRun: false })) // no parallelism → 1
    await h.runner.loopDone
    expect(gitCmds.some((c) => c.startsWith('worktree add'))).toBe(false) // no worktrees = no parallel path
    expect(startedIds(h.events).sort()).toEqual([1, 2]) // ran sequentially via the normal path
  })
})

describe('depsInstallCommand (ensureDeps env-prep)', () => {
  const mk = (setup: (dir: string) => void): string => {
    const dir = mkdtempSync(join(tmpdir(), 'deps-test-'))
    setup(dir)
    return dir
  }

  it('npm install when there is a package.json and no node_modules', () => {
    const dir = mk((d) => writeFileSync(join(d, 'package.json'), '{}'))
    try { expect(depsInstallCommand(dir)).toBe('npm install') } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('null when node_modules already exists (nothing to do)', () => {
    const dir = mk((d) => {
      writeFileSync(join(d, 'package.json'), '{}')
      mkdirSync(join(d, 'node_modules'))
    })
    try { expect(depsInstallCommand(dir)).toBeNull() } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('null when there is no package.json (not a JS project)', () => {
    const dir = mk(() => {})
    try { expect(depsInstallCommand(dir)).toBeNull() } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('picks the package manager from the lockfile', () => {
    const pnpm = mk((d) => {
      writeFileSync(join(d, 'package.json'), '{}')
      writeFileSync(join(d, 'pnpm-lock.yaml'), '')
    })
    const yarn = mk((d) => {
      writeFileSync(join(d, 'package.json'), '{}')
      writeFileSync(join(d, 'yarn.lock'), '')
    })
    try {
      expect(depsInstallCommand(pnpm)).toBe('pnpm install')
      expect(depsInstallCommand(yarn)).toBe('yarn install')
    } finally {
      rmSync(pnpm, { recursive: true, force: true })
      rmSync(yarn, { recursive: true, force: true })
    }
  })
})
