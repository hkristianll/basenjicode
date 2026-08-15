import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writePlanToBoard, applyReplanDiff, runHermes, runDecompose, runDecomposeMeeting, runDepartmentGrooming, runReplan, resolveContestedConcept, draftRichSpec, hermesRunConfig, resolvePlanner, gatherCriticEvidence, craftSystem, type BoardWriteIO, type OrchestratorDeps, type HermesSeams, type IntegrationCheckResult } from './specOrchestrator'
import { detectContestedConcepts } from './thrashGuard'
import { setManagerMemoryDir, writeManagerMemory, readManagerMemory } from './managerMemory'
import { createPauseGate } from './pauseGate'
import type { NewTicket } from '../loopBoard'
import { MAX_DECOMPOSE_TICKETS, type DecomposePlan, type ReplanDiff } from './specPlan'
import { readTeamMemory, writeTeamMemory } from './teamMemory'
import type { LoopConfig, BoardTicketRow, LoopEvent } from '../../shared/ipc-types'
import type { Settings, ChatMessage, Connection } from '../../shared/domain-types'

// A fake board: assigns incrementing ids and records every create + status change so we can assert behaviour.
function fakeBoard(): BoardWriteIO & { specs: string[]; creates: NewTicket[]; statuses: { id: number; status: string }[] } {
  const creates: NewTicket[] = []
  const specs: string[] = []
  const statuses: { id: number; status: string }[] = []
  let nextId = 100
  return {
    specs,
    creates,
    statuses,
    async setSpec(_project, content) {
      specs.push(content)
    },
    async addTicket(t) {
      creates.push(t)
      return { id: nextId++ }
    },
    async setStatus(id, status) {
      statuses.push({ id, status })
    }
  }
}

describe('writePlanToBoard', () => {
  it('stores the spec then creates tickets deps-first, mapping local indices to real ids', async () => {
    const plan: DecomposePlan = {
      spec: '# the spec',
      tickets: [
        { title: 'A (needs B)', body: '', deps: [1] },
        { title: 'B (needs C)', body: '', deps: [2] },
        { title: 'C scaffold', body: '' }
      ]
    }
    const io = fakeBoard()
    const ids = await writePlanToBoard(plan, 'proj', io)

    // Spec written once.
    expect(io.specs).toEqual(['# the spec'])

    // Creation order is C, B, A (deps first). C=100, B=101, A=102.
    expect(io.creates.map((c) => c.title)).toEqual(['C scaffold', 'B (needs C)', 'A (needs B)'])
    expect(ids).toEqual([100, 101, 102])

    // B's local dep [2] (=C) resolved to real id 100; A's local dep [1] (=B) resolved to 101.
    const bCreate = io.creates[1]
    const aCreate = io.creates[2]
    expect(bCreate.deps).toEqual([100])
    expect(aCreate.deps).toEqual([101])
    // Every ticket carries the spec_ref marker so its seed pulls in the project spec.
    expect(io.creates.every((c) => c.spec_ref === 'board:proj')).toBe(true)
  })

  it('passes the check command through to the board', async () => {
    const plan: DecomposePlan = { spec: '', tickets: [{ title: 'Build', body: 'x', check: 'npm run build' }] }
    const io = fakeBoard()
    await writePlanToBoard(plan, 'proj', io)
    expect(io.creates[0].check).toBe('npm run build')
  })

  it('rejects a cyclic plan before any ticket is created', async () => {
    const plan: DecomposePlan = {
      spec: '',
      tickets: [
        { title: 'A', body: '', deps: [1] },
        { title: 'B', body: '', deps: [0] }
      ]
    }
    const io = fakeBoard()
    await expect(writePlanToBoard(plan, 'proj', io)).rejects.toThrow(/cycle/)
    expect(io.creates).toHaveLength(0)
  })
})

describe('applyReplanDiff', () => {
  it('cancels, reopens, and adds — adds carry real-id deps and the spec marker', async () => {
    const diff: ReplanDiff = {
      add: [{ title: 'Split of parked #9', body: 'b', check: 'npm test', deps: [3] }],
      cancel: [7],
      reopen: [5],
      note: 'split the parked ticket'
    }
    const io = fakeBoard()
    const res = await applyReplanDiff(diff, 'proj', io)
    expect(res).toEqual({ added: 1, cancelled: 1, reopened: 1 })
    expect(io.statuses).toEqual([
      { id: 7, status: 'cancelled' },
      { id: 5, status: 'todo' }
    ])
    expect(io.creates[0]).toMatchObject({ title: 'Split of parked #9', check: 'npm test', deps: [3], spec_ref: 'board:proj' })
  })

  it('an empty diff is a no-op', async () => {
    const io = fakeBoard()
    const res = await applyReplanDiff({ add: [], cancel: [], reopen: [], note: '' }, 'proj', io)
    expect(res).toEqual({ added: 0, cancelled: 0, reopened: 0 })
    expect(io.statuses).toHaveLength(0)
    expect(io.creates).toHaveLength(0)
  })

  it('skips a board-rejected item and still applies the rest (M5: one bad id must not wedge the run)', async () => {
    const io = fakeBoard()
    const notices: string[] = []
    // The board throws (non-2xx) on a hallucinated reopen id and on an add whose dep does not exist.
    const failingIo: BoardWriteIO = {
      ...io,
      async setStatus(id, status, note) {
        if (id === 999) throw new Error('board HTTP 404')
        return io.setStatus(id, status, note)
      },
      async addTicket(t) {
        if ((t.deps ?? []).includes(404)) throw new Error('board HTTP 400: unknown dependency')
        return io.addTicket(t)
      }
    }
    const diff: ReplanDiff = {
      add: [
        { title: 'good add', body: 'b' },
        { title: 'bad dep add', body: 'b', deps: [404] }
      ],
      cancel: [],
      reopen: [5, 999],
      note: ''
    }
    const res = await applyReplanDiff(diff, 'proj', failingIo, (e) => {
      if (e.kind === 'notice') notices.push(e.text)
    })
    // The valid reopen (#5) and the valid add landed; the bad ones were skipped, not thrown — counts are actual.
    expect(res).toEqual({ added: 1, cancelled: 0, reopened: 1 })
    expect(io.statuses).toEqual([{ id: 5, status: 'todo' }])
    expect(io.creates.map((c) => c.title)).toEqual(['good add'])
    // Each failure surfaced a skip notice instead of aborting.
    expect(notices).toHaveLength(2)
  })

  it('dedupes adds against the live board (and within the batch) so a replan never re-files existing work', async () => {
    const io = fakeBoard()
    const notices: string[] = []
    const existing = [
      { title: 'Implement Paddle entity', status: 'todo' },
      { title: 'Implement Ball entity', status: 'done' },
      { title: 'Old cancelled thing', status: 'cancelled' } // cancelled → not a live dup; re-adding it is allowed
    ]
    const diff: ReplanDiff = {
      add: [
        { title: 'implement paddle entity', body: 'b' }, // case-folded dup of a live ticket → skip
        { title: 'Implement Ball Entity (fixed check)', body: 'b' }, // annotation-folded dup of a live ticket → skip
        { title: 'Old cancelled thing', body: 'b' }, // matches only a CANCELLED ticket → allowed
        { title: 'Brand new work', body: 'b' }, // genuinely new → add
        { title: 'brand new work', body: 'b' } // dup of the previous add WITHIN this batch → skip
      ],
      cancel: [],
      reopen: [],
      note: ''
    }
    const res = await applyReplanDiff(diff, 'proj', io, (e) => { if (e.kind === 'notice') notices.push(e.text) }, existing)
    expect(io.creates.map((c) => c.title)).toEqual(['Old cancelled thing', 'Brand new work'])
    expect(res.added).toBe(2)
    expect(notices.some((n) => /skipped 3 duplicate add/i.test(n))).toBe(true)
  })
})

/* ----- runHermes: the closed-loop control flow, exercised headless via injected seams (no model, no board).
 *  This is the coverage the engine lacked — the C1 pause bug would have been caught here. ----- */

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** A live-ish board the drain mutates in place; addTicket appends a `todo` row, getState reads it back. */
function liveFakeBoard(): { board: BoardTicketRow[]; io: BoardWriteIO } {
  const board: BoardTicketRow[] = []
  let nextId = 100
  const io: BoardWriteIO = {
    async setSpec() {},
    async addTicket(t) {
      const id = nextId++
      board.push({ id, title: t.title, body: t.body ?? '', status: 'todo', deps: t.deps ?? [] } as BoardTicketRow)
      return { id }
    },
    async setStatus(id, status) {
      const row = board.find((r) => r.id === id)
      if (row) row.status = status
    }
  }
  return { board, io }
}

type Canned = string | (() => string)
/** A fake `complete` that returns canned JSON per turn, routed by the system prompt. decompose is required;
 *  replan/critic default to an empty diff. */
function cannedComplete(r: { decompose: Canned; detail?: Canned; replan?: Canned; critic?: Canned; meeting?: Canned; planMeeting?: Canned; groom?: Canned; decide?: Canned; draftSpec?: Canned; split?: Canned }): OrchestratorDeps['complete'] {
  const pick = (v: Canned | undefined, fallback: string): string => (typeof v === 'function' ? v() : (v ?? fallback))
  const EMPTY = '{"add":[],"cancel":[],"reopen":[],"note":""}'
  return async (messages: ChatMessage[]) => {
    const sys = String(messages[0]?.content ?? '')
    if (/write the BODY and CHECK/i.test(sys)) return pick(r.detail, '{"tickets":[]}') // phase-2 detail pass
    if (/planning engine/.test(sys)) return pick(r.decompose, '')
    if (/backlog grooming/i.test(sys)) return pick(r.groom, '{"splits":[]}')
    if (/planning meeting/i.test(sys)) return pick(r.planMeeting, EMPTY)
    if (/contract-complete spec/i.test(sys)) return pick(r.draftSpec, '{"scope":"in scope","contracts":["X owns Y"],"interfaces":[],"acceptance":["it works"]}') // P0 spec-draft turn
    if (/splitting a parked build node/i.test(sys)) return pick(r.split, '{"escalate":true,"reason":"default","children":[]}') // P2 split turn (default: escalate)
    if (/binding architectural decision/i.test(sys)) return pick(r.decide, '{}') // L2 decision turn; '{}' → unusable → no-op
    if (/replanner/.test(sys)) return pick(r.replan, EMPTY)
    if (/manager meeting/.test(sys)) return pick(r.meeting, EMPTY)
    if (/lead reviewer/.test(sys)) return pick(r.critic, EMPTY)
    throw new Error('cannedComplete: unexpected system prompt')
  }
}

/** Minimal LoopConfig — cwd is a nonexistent path so the critic's listProjectTree returns '' (no fs needed). */
const cfg = (): LoopConfig => ({ cwd: '/nonexistent-hermes-test-dir', connectionId: 'x', project: 'proj', mode: 'auto', caps: { maxTickets: 0, maxTokens: 0, maxWallclockSec: 0, maxConsecutiveFailures: 0 }, terminal: 'auto' }) as LoopConfig
const ONE_TICKET = '{"spec":"s","tickets":[{"title":"A","check":"true"}]}'

describe('runHermes', () => {
  it('decomposes, drains to settled, and completes when the critic is empty', async () => {
    const { board, io } = liveFakeBoard()
    const seams: HermesSeams = {
      runDrainOnce: async () => board.forEach((r) => r.status === 'todo' && (r.status = 'done')),
      getBoardState: async () => board,
      getParked: () => []
    }
    const deps: OrchestratorDeps = { settings: {} as Settings, io, complete: cannedComplete({ decompose: ONE_TICKET }) }
    const res = await runHermes('goal', 'proj', cfg(), deps, seams, { maxRounds: 5 })
    expect(res.reason).toBe('complete')
    expect(res.improveRounds).toBe(1)
    expect(board.every((t) => t.status === 'done')).toBe(true)
  })

  const allDoneSeams = (board: BoardTicketRow[]): HermesSeams => ({
    runDrainOnce: async () => board.forEach((r) => r.status === 'todo' && (r.status = 'done')),
    getBoardState: async () => board,
    getParked: () => []
  })

  it('opts.lazyDecompose routes to the manager-owned (lazy) path; the coarse attempt completes when the root drains done', async () => {
    const { board, io } = liveFakeBoard()
    const notices: string[] = []
    const deps: OrchestratorDeps = {
      settings: {} as Settings,
      io,
      complete: cannedComplete({ decompose: ONE_TICKET }),
      emit: (e: LoopEvent) => { if (e.kind === 'notice') notices.push(e.text) }
    }
    const res = await runHermes('goal', 'proj', cfg(), deps, allDoneSeams(board), { maxRounds: 5, lazyDecompose: true })
    expect(notices.some((t) => /manager-owned \(lazy\)/i.test(t))).toBe(true) // routed to the lazy path
    expect(res.reason).toBe('complete') // the single coarse root drained to done
  })

  it('settings.hermesLazyOrchestration routes to lazy; without it the eager path is unchanged (no lazy notice)', async () => {
    const run = async (lazy: boolean): Promise<string[]> => {
      const { board, io } = liveFakeBoard()
      const notices: string[] = []
      const deps: OrchestratorDeps = {
        settings: { hermesLazyOrchestration: lazy } as Settings,
        io,
        complete: cannedComplete({ decompose: ONE_TICKET }),
        emit: (e: LoopEvent) => { if (e.kind === 'notice') notices.push(e.text) }
      }
      await runHermes('goal', 'proj', cfg(), deps, allDoneSeams(board), { maxRounds: 5 })
      return notices
    }
    expect((await run(true)).some((t) => /manager-owned \(lazy\)/i.test(t))).toBe(true)
    expect((await run(false)).some((t) => /manager-owned \(lazy\)/i.test(t))).toBe(false)
  })

  it('does NOT complete when the assembled app is unverified — files a wire-up fix + caps at needs-integration', async () => {
    const { board, io } = liveFakeBoard()
    const integrationCheck = (): IntegrationCheckResult => ({ ok: false, orphans: ['src/orphan.ts'], hasIntegrationTest: false, detail: 'built-but-unwired: src/orphan.ts.' })
    const deps: OrchestratorDeps = { settings: {} as Settings, io, integrationCheck, complete: cannedComplete({ decompose: ONE_TICKET }) }
    const res = await runHermes('goal', 'proj', cfg(), deps, allDoneSeams(board), { maxRounds: 20, maxImproveRounds: 2 })
    expect(res.reason).toBe('needs-integration') // never `complete` while the assembled app is unverified
    expect(board.some((t) => /wire-up \+ integration/i.test(t.title))).toBe(true) // it filed the fix-ticket
  })

  it('completes when the assembled app is verified', async () => {
    const { board, io } = liveFakeBoard()
    const integrationCheck = (): IntegrationCheckResult => ({ ok: true, orphans: [], hasIntegrationTest: true, detail: 'verified' })
    const deps: OrchestratorDeps = { settings: {} as Settings, io, integrationCheck, complete: cannedComplete({ decompose: ONE_TICKET }) }
    const res = await runHermes('goal', 'proj', cfg(), deps, allDoneSeams(board), { maxRounds: 5 })
    expect(res.reason).toBe('complete')
  })

  it('reopens with a fix-ticket, then completes once the app verifies', async () => {
    const { board, io } = liveFakeBoard()
    let n = 0
    const integrationCheck = (): IntegrationCheckResult =>
      ++n === 1 ? { ok: false, orphans: ['src/x.ts'], hasIntegrationTest: false, detail: 'built-but-unwired: src/x.ts.' } : { ok: true, orphans: [], hasIntegrationTest: true, detail: 'verified' }
    const deps: OrchestratorDeps = { settings: {} as Settings, io, integrationCheck, complete: cannedComplete({ decompose: ONE_TICKET }) }
    const res = await runHermes('goal', 'proj', cfg(), deps, allDoneSeams(board), { maxRounds: 10, maxImproveRounds: 3 })
    expect(res.reason).toBe('complete')
    expect(board.some((t) => /wire-up \+ integration/i.test(t.title))).toBe(true) // a fix-ticket was filed before it verified
  })

  it('skipDecompose continues an existing board without re-decomposing (project continuity)', async () => {
    const { board, io } = liveFakeBoard()
    board.push({ id: 1, project: 'proj', title: 'pre-existing', body: '', status: 'todo', deps: [] } as BoardTicketRow)
    const seams: HermesSeams = {
      runDrainOnce: async () => board.forEach((r) => r.status === 'todo' && (r.status = 'done')),
      getBoardState: async () => board,
      getParked: () => []
    }
    const deps: OrchestratorDeps = {
      settings: {} as Settings,
      io,
      complete: cannedComplete({
        decompose: () => {
          throw new Error('decompose must be skipped when continuing an existing board')
        }
      })
    }
    const res = await runHermes('goal', 'proj', cfg(), deps, seams, { maxRounds: 5, skipDecompose: true, existingSpec: 'the spec' })
    expect(res.reason).toBe('complete')
    expect(board.length).toBe(1) // no decompose-added tickets — only the one already on the board
    expect(board[0].status).toBe('done') // and it got drained
  })

  it('R6: attaches to a non-empty board WITHOUT skipDecompose (idempotent — never re-decomposes)', async () => {
    const { board, io } = liveFakeBoard()
    board.push({ id: 1, project: 'proj', title: 'pre-existing', body: '', status: 'todo', deps: [] } as BoardTicketRow)
    const seams: HermesSeams = {
      runDrainOnce: async () => board.forEach((r) => r.status === 'todo' && (r.status = 'done')),
      getBoardState: async () => board,
      getParked: () => []
    }
    const deps: OrchestratorDeps = {
      settings: {} as Settings,
      io,
      // NOTE: no skipDecompose — the guard must attach purely because the board already has live tickets.
      complete: cannedComplete({
        decompose: () => {
          throw new Error('decompose must NOT run when the board already has work (re-decompose explosion)')
        }
      })
    }
    const res = await runHermes('goal', 'proj', cfg(), deps, seams, { maxRounds: 5 })
    expect(res.reason).toBe('complete')
    expect(board.length).toBe(1) // attached — no new tickets decomposed onto the populated board
    expect(board[0].status).toBe('done')
  })

  it('R7: resets an orphaned in_progress ticket at run start so the drain can reclaim it', async () => {
    const { board, io } = liveFakeBoard()
    board.push({ id: 1, project: 'proj', title: 'stranded', body: '', status: 'in_progress', deps: [] } as BoardTicketRow)
    const seams: HermesSeams = {
      runDrainOnce: async () => board.forEach((r) => r.status === 'todo' && (r.status = 'done')),
      getBoardState: async () => board,
      getParked: () => []
    }
    const deps: OrchestratorDeps = { settings: {} as Settings, io, complete: cannedComplete({ decompose: ONE_TICKET }) }
    const res = await runHermes('goal', 'proj', cfg(), deps, seams, { maxRounds: 5 })
    // Without the startup sweep the ticket stays in_progress forever (the drain only claims todo) → never settles.
    expect(board[0].status).toBe('done')
    expect(res.reason).toBe('complete')
  })

  it('holds at the pause gate until resume — no further drain runs while paused (C1)', async () => {
    const gate = createPauseGate()
    const { board, io } = liveFakeBoard()
    let drains = 0
    const seams: HermesSeams = {
      runDrainOnce: async () => {
        drains++
        if (drains === 1) return gate.pause() // user pauses during the first drain (board left un-settled)
        board.forEach((r) => r.status === 'todo' && (r.status = 'done'))
      },
      getBoardState: async () => board,
      getParked: () => [],
      isPaused: () => gate.isPaused(),
      waitWhilePaused: (s) => gate.waitWhilePaused(s)
    }
    const deps: OrchestratorDeps = { settings: {} as Settings, io, complete: cannedComplete({ decompose: ONE_TICKET }) }
    const p = runHermes('goal', 'proj', cfg(), deps, seams, { maxRounds: 5 })

    await flush()
    expect(drains).toBe(1) // paused after the first drain — the orchestrator did NOT start a second
    expect(gate.isPaused()).toBe(true)
    await flush()
    expect(drains).toBe(1) // still held across ticks

    gate.resume()
    const res = await p
    expect(res.reason).toBe('complete')
    expect(drains).toBe(2) // resume let exactly one more drain run
  })

  it('a Stop aborts the cycle', async () => {
    const { board, io } = liveFakeBoard()
    const ac = new AbortController()
    const seams: HermesSeams = {
      runDrainOnce: async () => ac.abort(), // a Stop lands during the first drain
      getBoardState: async () => board,
      getParked: () => []
    }
    const deps: OrchestratorDeps = { settings: {} as Settings, io, complete: cannedComplete({ decompose: ONE_TICKET }) }
    const res = await runHermes('goal', 'proj', cfg(), deps, seams, { maxRounds: 5, signal: ac.signal })
    expect(res.reason).toBe('stopped')
  })

  it('stops at the improve cap when the critic keeps finding work', async () => {
    const { board, io } = liveFakeBoard()
    const seams: HermesSeams = {
      runDrainOnce: async () => board.forEach((r) => r.status === 'todo' && (r.status = 'done')),
      getBoardState: async () => board,
      getParked: () => []
    }
    let n = 0
    const deps: OrchestratorDeps = {
      settings: {} as Settings,
      io,
      complete: cannedComplete({
        decompose: ONE_TICKET,
        critic: () => `{"add":[{"title":"more ${++n}","check":"true"}],"cancel":[],"reopen":[],"note":"keep going"}`
      })
    }
    const res = await runHermes('goal', 'proj', cfg(), deps, seams, { maxRounds: 20, maxImproveRounds: 2 })
    expect(res.reason).toBe('improve-cap')
    expect(res.improveRounds).toBe(2)
  })

  it('replans open work, then ends replan-empty when a round makes no progress', async () => {
    // The drain never settles this ticket (stays todo), so the board always has open work → replan path.
    const { board, io } = liveFakeBoard()
    const seams: HermesSeams = {
      runDrainOnce: async () => {}, // drain makes no progress
      getBoardState: async () => board,
      getParked: () => []
    }
    const deps: OrchestratorDeps = { settings: {} as Settings, io, complete: cannedComplete({ decompose: ONE_TICKET }) }
    // replan defaults to empty → first round records the signature, second identical round ends replan-empty.
    const res = await runHermes('goal', 'proj', cfg(), deps, seams, { maxRounds: 10 })
    expect(res.reason).toBe('replan-empty')
  })

  it('emits typed orchestrator phase + round events (P2/O1)', async () => {
    const { board, io } = liveFakeBoard()
    const events: LoopEvent[] = []
    const seams: HermesSeams = {
      runDrainOnce: async () => board.forEach((r) => r.status === 'todo' && (r.status = 'done')),
      getBoardState: async () => board,
      getParked: () => []
    }
    const deps: OrchestratorDeps = { settings: {} as Settings, io, emit: (e) => events.push(e), complete: cannedComplete({ decompose: ONE_TICKET }) }
    await runHermes('goal', 'proj', cfg(), deps, seams, { maxRounds: 5 })

    const states = events.flatMap((e) => (e.kind === 'hermes-state' ? [e.state] : []))
    expect(states[0]).toBe('planning') // planning is emitted before decompose
    expect(states).toContain('draining')
    expect(states).toContain('improving')
    const roundPhases = events.flatMap((e) => (e.kind === 'hermes-round' ? [e.phase] : []))
    expect(roundPhases).toContain('decompose')
  })

  it('intervenes on stuck via the manager, then re-drains when the board changed (B)', async () => {
    const { board, io } = liveFakeBoard()
    let interventions = 0
    const seams: HermesSeams = {
      runDrainOnce: async () => {}, // drain never makes progress → the cycle goes stuck
      getBoardState: async () => board,
      getParked: () => [],
      interveneOnStuck: async () => {
        interventions++
        board.forEach((r) => (r.status = 'done')) // the manager unsticks it (e.g. re-filed with a working check)
      }
    }
    const deps: OrchestratorDeps = { settings: {} as Settings, io, complete: cannedComplete({ decompose: ONE_TICKET }) }
    const res = await runHermes('goal', 'proj', cfg(), deps, seams, { maxRounds: 10 })
    expect(interventions).toBe(1)
    expect(res.reason).toBe('complete') // board changed → re-drained → settled → critic empty → complete
  })

  it('caps stuck interventions so it cannot loop forever (B)', async () => {
    const { board, io } = liveFakeBoard()
    let interventions = 0
    const seams: HermesSeams = {
      runDrainOnce: async () => {},
      getBoardState: async () => board,
      getParked: () => [],
      interveneOnStuck: async () => {
        interventions++
        board.push({ id: 200 + interventions, title: 'still stuck', project: 'proj', body: '', status: 'todo', deps: [] } as BoardTicketRow) // changes the board but stays stuck
      }
    }
    const deps: OrchestratorDeps = { settings: {} as Settings, io, complete: cannedComplete({ decompose: ONE_TICKET }) }
    const res = await runHermes('goal', 'proj', cfg(), deps, seams, { maxRounds: 30, maxStuckRounds: 2 })
    expect(res.reason).toBe('replan-empty')
    expect(interventions).toBe(2) // intervened the capped number of times, then gave up
  })

  it('continuous mode: idles on-call instead of completing — only a Stop ends it', async () => {
    const { board, io } = liveFakeBoard()
    const ac = new AbortController()
    let states = 0
    const seams: HermesSeams = {
      runDrainOnce: async () => board.forEach((r) => r.status === 'todo' && (r.status = 'done')),
      getBoardState: async () => {
        if (++states >= 4) ac.abort() // simulate the user finally hitting Stop after it has idled a bit
        return board
      },
      getParked: () => [],
      isContinuous: () => true
    }
    const deps: OrchestratorDeps = { settings: {} as Settings, io, complete: cannedComplete({ decompose: ONE_TICKET, meeting: '{"add":[],"cancel":[],"reopen":[],"note":""}' }) }
    // maxRounds:1 would normally force max-rounds almost immediately — continuous must ignore it.
    const res = await runHermes('goal', 'proj', cfg(), deps, seams, { maxRounds: 1, signal: ac.signal, idlePollMs: 1 })
    expect(res.reason).toBe('stopped') // NOT 'complete'/'improve-cap'/'max-rounds'
  })

  it('continuous mode: a manager meeting that proposes work keeps the team going', async () => {
    const { board, io } = liveFakeBoard()
    const ac = new AbortController()
    let meetings = 0
    const seams: HermesSeams = {
      runDrainOnce: async () => board.forEach((r) => r.status === 'todo' && (r.status = 'done')),
      getBoardState: async () => board,
      getParked: () => [],
      isContinuous: () => true
    }
    const deps: OrchestratorDeps = {
      settings: {} as Settings,
      io,
      complete: cannedComplete({
        decompose: ONE_TICKET,
        meeting: () => {
          meetings++
          if (meetings >= 2) ac.abort() // first meeting proposes work; on the second, simulate Stop
          return meetings === 1
            ? '{"add":[{"title":"more tests","check":"true"}],"cancel":[],"reopen":[],"note":"add tests"}'
            : '{"add":[],"cancel":[],"reopen":[],"note":""}'
        }
      })
    }
    const res = await runHermes('goal', 'proj', cfg(), deps, seams, { maxRounds: 10, signal: ac.signal, idlePollMs: 1 })
    expect(res.reason).toBe('stopped')
    expect(meetings).toBeGreaterThanOrEqual(1) // the meeting actually convened
    expect(board.some((t) => t.title === 'more tests')).toBe(true) // and its improvement was filed + drained
  })
})

describe('hermesRunConfig', () => {
  it('forces branchPerRun + includeReview off, preserving the rest (C3 continuity invariant)', () => {
    const out = hermesRunConfig({ cwd: 'x', project: 'p', branchPerRun: true, includeReview: true, connectionId: 'c' } as LoopConfig)
    expect(out.branchPerRun).toBe(false)
    expect(out.includeReview).toBe(false)
    expect(out.cwd).toBe('x')
    expect(out.project).toBe('p')
    expect(out.connectionId).toBe('c')
  })
})

describe('resolvePlanner', () => {
  const mkConn = (id: string, model: string): Connection => ({ id, label: id, kind: 'lmstudio', baseURL: 'http://x', model }) as Connection
  const withSettings = (over: Partial<Settings>): Settings => ({ connections: [mkConn('worker', 'wm'), mkConn('planner', 'pm')], ...over }) as Settings
  const cfg = { connectionId: 'worker', workerModel: 'wm-override' } as LoopConfig

  it('falls back to the worker connection + workerModel when no planner is set (Q1 default)', () => {
    const { conn, model } = resolvePlanner(withSettings({}), cfg)
    expect(conn?.id).toBe('worker')
    expect(model).toBe('wm-override')
  })

  it('uses the planner connection + planner model when both are set', () => {
    const { conn, model } = resolvePlanner(withSettings({ hermesPlannerConnectionId: 'planner', hermesPlannerModel: 'big' }), cfg)
    expect(conn?.id).toBe('planner')
    expect(model).toBe('big')
  })

  it("uses the planner connection's default model when no planner model is given", () => {
    const { conn, model } = resolvePlanner(withSettings({ hermesPlannerConnectionId: 'planner' }), cfg)
    expect(conn?.id).toBe('planner')
    expect(model).toBe('pm')
  })

  it('falls back to the worker connection when the planner id does not resolve', () => {
    const { conn, model } = resolvePlanner(withSettings({ hermesPlannerConnectionId: 'ghost' }), cfg)
    expect(conn?.id).toBe('worker')
    expect(model).toBe('wm-override')
  })

  it('routes the planning turns to qwen-agentworld-35b-a3b when configured as the planner (decompose/replan/critic + Brooke)', () => {
    const { conn, model } = resolvePlanner(withSettings({ hermesPlannerConnectionId: 'planner', hermesPlannerModel: 'qwen-agentworld-35b-a3b' }), cfg)
    expect(conn?.id).toBe('planner') // the stronger result-prediction model handles the high-leverage reasoning
    expect(model).toBe('qwen-agentworld-35b-a3b')
  })
})

describe('runDecompose + diff fallbacks (Q2)', () => {
  const cfgX = { connectionId: 'x', workerModel: 'm' } as LoopConfig

  it('falls back to a single-ticket plan when the model never returns valid JSON', async () => {
    let calls = 0
    const deps: OrchestratorDeps = {
      settings: {} as Settings,
      complete: async () => {
        calls++
        return 'definitely not json'
      }
    }
    const plan = await runDecompose('build a slicer', cfgX, deps)
    expect(plan.tickets).toHaveLength(1)
    expect(plan.tickets[0].title.toLowerCase()).toContain('slicer')
    expect(plan.tickets[0].check).toBeUndefined() // no check → routed to human review, never silent done
    expect(calls).toBe(4) // retried DECOMPOSE_ATTEMPTS times before falling back, rather than throwing
  })

  it('returns the parsed plan as soon as the model emits valid JSON (retry self-corrects)', async () => {
    let calls = 0
    const deps: OrchestratorDeps = {
      settings: {} as Settings,
      complete: async () => (++calls === 1 ? 'oops not json' : '{"spec":"s","tickets":[{"title":"A","check":"true"}]}')
    }
    const plan = await runDecompose('goal', cfgX, deps)
    expect(plan.tickets).toHaveLength(1)
    expect(plan.tickets[0].title).toBe('A')
    expect(calls).toBe(2)
  })

  it('rejects an existence-only check on an implementation ticket → repairs to a behavioral one', async () => {
    let calls = 0
    const weak = '{"spec":"s","tickets":[{"title":"A* pathfinding","check":"Test-Path src/path.ts","role":"implementation"}]}'
    const good = '{"spec":"s","tickets":[{"title":"A* pathfinding","check":"npx tsc --noEmit","role":"implementation"}]}'
    const deps: OrchestratorDeps = { settings: {} as Settings, complete: async () => (++calls === 1 ? weak : good) }
    const plan = await runDecompose('goal', cfgX, deps)
    expect(calls).toBe(2) // the existence-only check was rejected → reject-and-repair fed the reason back
    expect(plan.tickets[0].check).toBe('npx tsc --noEmit')
  })

  it('staged decompose: an OUTLINE (no body/check) gets body+check filled by the detail pass', async () => {
    let detailCalls = 0
    const outline = '{"spec":"game spec","tickets":[{"title":"Scaffold","role":"architecture","deps":[]},{"title":"A* pathfinding","role":"implementation","deps":[0]}]}'
    const detail = (): string => { detailCalls++; return '{"tickets":[{"index":0,"body":"set up vite+ts","check":"Test-Path package.json"},{"index":1,"body":"implement A* (shortest path, obstacles, unreachable→null)","check":"npm test"}]}' }
    const deps: OrchestratorDeps = { settings: {} as Settings, complete: cannedComplete({ decompose: outline, detail }) }
    const plan = await runDecompose('build a game', cfgX, deps)
    expect(plan.spec).toBe('game spec')
    expect(detailCalls).toBe(1) // both tickets fit one batch — content generated in a piece, not all at once
    expect(plan.tickets[0].body).toBe('set up vite+ts')
    expect(plan.tickets[0].check).toBe('Test-Path package.json') // existence check kept for an ARCHITECTURE ticket
    expect(plan.tickets[1].body).toContain('A*')
    expect(plan.tickets[1].check).toBe('npm test') // behavioral check kept for implementation
  })

  it('detail pass is defensive: a missing ticket → title body + behavioral floor; an existence check on review → none', async () => {
    const outline = '{"spec":"s","tickets":[{"title":"Build the thing","role":"implementation","deps":[]},{"title":"Audit the look","role":"review","deps":[0]}]}'
    const detail = '{"tickets":[{"index":1,"body":"audit it","check":"Test-Path src"}]}' // omits index 0; gives review a bad check
    const deps: OrchestratorDeps = { settings: {} as Settings, complete: cannedComplete({ decompose: outline, detail }) }
    const plan = await runDecompose('goal', cfgX, deps)
    expect(plan.tickets[0].body).toBe('Build the thing') // title-as-body fallback for the omitted ticket
    expect(plan.tickets[0].check).toBe('npx tsc --noEmit') // implementation with no detail → behavioral floor
    expect(plan.tickets[1].check).toBeUndefined() // review never gets a check, even if the model supplied one
  })

  it('a full plan (body+check already present) skips the detail pass entirely', async () => {
    let detailCalls = 0
    const full = '{"spec":"s","tickets":[{"title":"A","body":"do A","check":"npm test","role":"implementation"}]}'
    const detail = (): string => { detailCalls++; return '{"tickets":[]}' }
    const deps: OrchestratorDeps = { settings: {} as Settings, complete: cannedComplete({ decompose: full, detail }) }
    const plan = await runDecompose('goal', cfgX, deps)
    expect(plan.tickets[0].body).toBe('do A')
    expect(detailCalls).toBe(0) // body+check present → no detail call needed
  })

  it('ALLOWS an existence-only check on a docs/scaffold ticket (nothing to execute)', async () => {
    let calls = 0
    const deps: OrchestratorDeps = {
      settings: {} as Settings,
      complete: async () => { calls++; return '{"spec":"s","tickets":[{"title":"README","check":"Test-Path README.md","role":"docs"}]}' }
    }
    const plan = await runDecompose('goal', cfgX, deps)
    expect(calls).toBe(1) // accepted on the first try — docs tickets may gate on file existence
    expect(plan.tickets[0].check).toBe('Test-Path README.md')
  })

  it('rejects a multi-module plan with NO integration/wire-up ticket → reject-and-repair', async () => {
    let outlineCalls = 0
    const orphan = '{"spec":"s","tickets":[{"title":"Build the map renderer","role":"implementation","deps":[]},{"title":"Build the pathfinder","role":"implementation","deps":[]},{"title":"Build the HUD","role":"implementation","deps":[]}]}'
    const wired = '{"spec":"s","tickets":[{"title":"Build the map renderer","role":"implementation","deps":[]},{"title":"Build the pathfinder","role":"implementation","deps":[]},{"title":"Build the HUD","role":"implementation","deps":[]},{"title":"Wire the modules into the main scene + integration test","role":"implementation","deps":[0,1,2]}]}'
    const deps: OrchestratorDeps = { settings: {} as Settings, complete: cannedComplete({ decompose: () => (++outlineCalls === 1 ? orphan : wired) }) }
    const plan = await runDecompose('build a game', cfgX, deps)
    expect(outlineCalls).toBe(2) // the orphan plan (modules but no assembly) was rejected → repaired
    expect(plan.tickets).toHaveLength(4)
    expect(plan.tickets.some((t) => /wire|integration/i.test(t.title))).toBe(true)
  })

  it('accepts a multi-module plan that already has an integration/wire-up ticket (no repair)', async () => {
    let outlineCalls = 0
    const wired = '{"spec":"s","tickets":[{"title":"Build module A","role":"implementation","deps":[]},{"title":"Build module B","role":"implementation","deps":[]},{"title":"Build module C","role":"implementation","deps":[]},{"title":"Assemble into the app entry + e2e smoke test","role":"implementation","deps":[0,1,2]}]}'
    const deps: OrchestratorDeps = { settings: {} as Settings, complete: cannedComplete({ decompose: () => { outlineCalls++; return wired } }) }
    await runDecompose('goal', cfgX, deps)
    expect(outlineCalls).toBe(1) // integration ticket present → accepted on the first try
  })

  it('does NOT require an integration ticket for a small plan (< 3 module builders)', async () => {
    let outlineCalls = 0
    const small = '{"spec":"s","tickets":[{"title":"Build the one module","role":"implementation","deps":[]},{"title":"Scaffold","role":"architecture","deps":[]}]}'
    const deps: OrchestratorDeps = { settings: {} as Settings, complete: cannedComplete({ decompose: () => { outlineCalls++; return small } }) }
    await runDecompose('goal', cfgX, deps)
    expect(outlineCalls).toBe(1) // only 1 implementation ticket → gate does not fire
  })

  it('upgrades a testing ticket that gates on typecheck-only to `npm test` (it must RUN its tests)', async () => {
    const outline = '{"spec":"s","tickets":[{"title":"Impl A","role":"implementation"},{"title":"Headless integration test","role":"testing"}]}'
    const detail = '{"tickets":[{"index":0,"body":"build module A","check":"npx tsc --noEmit"},{"index":1,"body":"boot Phaser headless and assert the display list","check":"npx tsc --noEmit"}]}'
    const deps: OrchestratorDeps = { settings: {} as Settings, complete: cannedComplete({ decompose: outline, detail }) }
    const plan = await runDecompose('goal', cfgX, deps)
    expect(plan.tickets[0].check).toBe('npx tsc --noEmit') // implementation keeps the typecheck floor
    expect(plan.tickets[1].check).toBe('npm test') // testing must run tests — tsc-only is upgraded
  })

  it('keeps a testing ticket check that already runs tests (pytest, vitest, …)', async () => {
    const outline = '{"spec":"s","tickets":[{"title":"Impl A","role":"implementation"},{"title":"Economy tests","role":"testing"}]}'
    const detail = '{"tickets":[{"index":0,"body":"build it","check":"npx tsc --noEmit"},{"index":1,"body":"test the economy","check":"pytest -k economy"}]}'
    const deps: OrchestratorDeps = { settings: {} as Settings, complete: cannedComplete({ decompose: outline, detail }) }
    const plan = await runDecompose('goal', cfgX, deps)
    expect(plan.tickets[1].check).toBe('pytest -k economy') // a real test runner is left untouched
  })

  it('aborts a hung decompose attempt at the watchdog timeout and retries (start watchdog)', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const deps: OrchestratorDeps = {
        settings: {} as Settings,
        complete: (_messages, signal) => {
          calls++
          // First attempt hangs forever — only the watchdog's abort can end it; the retry returns a valid plan.
          if (calls === 1) return new Promise<string>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
          return Promise.resolve('{"spec":"s","tickets":[{"title":"A","check":"true"}]}')
        }
      }
      const p = runDecompose('goal', cfgX, deps)
      await vi.advanceTimersByTimeAsync(125_000) // trip the 120s watchdog on attempt 1 → it retries
      const plan = await p
      expect(calls).toBe(2)
      expect(plan.tickets[0].title).toBe('A')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT retry when the RUN itself is aborted — it rethrows so a stopped run ends cleanly', async () => {
    let calls = 0
    const deps: OrchestratorDeps = {
      settings: {} as Settings,
      complete: (_messages, signal) => {
        calls++
        if (signal?.aborted) return Promise.reject(new Error('aborted'))
        return Promise.resolve('{"spec":"s","tickets":[{"title":"A","check":"true"}]}')
      }
    }
    const stopped = new AbortController()
    stopped.abort()
    await expect(runDecompose('goal', cfgX, deps, stopped.signal)).rejects.toThrow()
    expect(calls).toBe(1) // attempted once, rethrew — never looped to fallback
  })

  it('a replan that never parses degrades to an empty diff instead of throwing', async () => {
    const deps: OrchestratorDeps = { settings: {} as Settings, complete: async () => 'garbage' }
    const diff = await runReplan('goal', 'spec', [], [], cfgX, deps)
    expect(diff).toMatchObject({ add: [], cancel: [], reopen: [] })
  })

  it('R4: a check-broken park reason steers replan to add a corrected-check replacement', async () => {
    let userMsg = ''
    const deps: OrchestratorDeps = {
      settings: {} as Settings,
      complete: async (msgs) => {
        userMsg = String(msgs[1]?.content ?? '')
        return '{"add":[],"cancel":[],"reopen":[],"note":""}'
      }
    }
    const board = [{ id: 9, status: 'todo', title: 'broken-check ticket' }] as unknown as BoardTicketRow[]
    await runReplan('goal', 'spec', board, [9], cfgX, deps, undefined, { 9: 'check-broken: uses bash test -f' })
    expect(userMsg).toContain('#9: check-broken')
    expect(userMsg).toMatch(/CORRECTED PowerShell check/i)
  })

  it('R4: a plain (non-check-broken) park reason is shown without the corrected-check directive', async () => {
    let userMsg = ''
    const deps: OrchestratorDeps = {
      settings: {} as Settings,
      complete: async (msgs) => {
        userMsg = String(msgs[1]?.content ?? '')
        return '{"add":[],"cancel":[],"reopen":[],"note":""}'
      }
    }
    await runReplan('goal', 'spec', [{ id: 4, status: 'todo', title: 'X' }] as unknown as BoardTicketRow[], [4], cfgX, deps, undefined, { 4: 'parked after 3 attempts — check still failing (exit 1)' })
    expect(userMsg).toContain('#4')
    expect(userMsg).not.toMatch(/CORRECTED PowerShell check/i)
  })
})

describe('decompose-time manager meeting (planMeeting)', () => {
  const draftPlan = (): DecomposePlan => ({
    spec: 's',
    tickets: [
      { title: 'Impl A', body: '', role: 'implementation', check: 'npm run build' },
      { title: 'Test A', body: '', role: 'testing', check: 'npm test' }
    ]
  })

  it('appends each present lead’s proposal to the plan, forcing deps:[] and the dept role', async () => {
    const complete: OrchestratorDeps['complete'] = async (messages) => {
      const sys = String(messages[0]?.content ?? '')
      const dept = /TESTING/.test(sys) ? 'testing' : 'implementation'
      // deps deliberately non-empty to prove runDecomposeMeeting forces them to [] (no board ids exist yet).
      return `{"add":[{"title":"${dept} extra","body":"b","check":"npm test","role":"${dept}","deps":[5]}],"cancel":[],"reopen":[],"note":""}`
    }
    const deps: OrchestratorDeps = { settings: {} as Settings, io: fakeBoard(), complete }
    const out = await runDecomposeMeeting('goal', draftPlan(), cfg(), deps)
    expect(out.tickets).toHaveLength(4)
    const added = out.tickets.slice(2)
    expect(added.map((t) => t.title)).toEqual(['implementation extra', 'testing extra'])
    expect(added.every((t) => Array.isArray(t.deps) && t.deps.length === 0)).toBe(true)
    expect(added.map((t) => t.role)).toEqual(['implementation', 'testing'])
  })

  it('leaves the plan unchanged when every lead is satisfied (empty add)', async () => {
    const complete: OrchestratorDeps['complete'] = async () => '{"add":[],"cancel":[],"reopen":[],"note":"solid"}'
    const deps: OrchestratorDeps = { settings: {} as Settings, io: fakeBoard(), complete }
    expect((await runDecomposeMeeting('goal', draftPlan(), cfg(), deps)).tickets).toHaveLength(2)
  })

  it('drops a proposal whose title already exists (dedup against the draft + across leads)', async () => {
    // Both leads re-propose "Impl A" (already in the draft) plus one genuinely-new ticket each.
    const complete: OrchestratorDeps['complete'] = async (messages) => {
      const sys = String(messages[0]?.content ?? '')
      const dept = /TESTING/.test(sys) ? 'testing' : 'implementation'
      return `{"add":[{"title":"Impl A","check":"npm test","role":"${dept}","deps":[]},{"title":"${dept} fresh","check":"npm test","role":"${dept}","deps":[]}],"cancel":[],"reopen":[],"note":""}`
    }
    const deps: OrchestratorDeps = { settings: {} as Settings, io: fakeBoard(), complete }
    const out = await runDecomposeMeeting('goal', draftPlan(), cfg(), deps)
    // The duplicate "Impl A" proposals are dropped; only the two fresh tickets are appended.
    expect(out.tickets.map((t) => t.title)).toEqual(['Impl A', 'Test A', 'implementation fresh', 'testing fresh'])
  })

  it('never pushes the plan past MAX_DECOMPOSE_TICKETS', async () => {
    const full: DecomposePlan = { spec: 's', tickets: Array.from({ length: MAX_DECOMPOSE_TICKETS }, (_, i) => ({ title: `t${i}`, body: '', role: 'implementation' })) }
    const complete: OrchestratorDeps['complete'] = async () => '{"add":[{"title":"x","check":"npm test","role":"implementation","deps":[]}],"cancel":[],"reopen":[],"note":""}'
    const deps: OrchestratorDeps = { settings: {} as Settings, io: fakeBoard(), complete }
    expect((await runDecomposeMeeting('goal', full, cfg(), deps)).tickets).toHaveLength(MAX_DECOMPOSE_TICKETS)
  })

  it('runHermes with planMeeting:true seeds the leads’ extra tickets onto the FIRST board', async () => {
    const { board, io } = liveFakeBoard()
    const seams: HermesSeams = {
      runDrainOnce: async () => board.forEach((r) => r.status === 'todo' && (r.status = 'done')),
      getBoardState: async () => board,
      getParked: () => []
    }
    const deps: OrchestratorDeps = {
      settings: {} as Settings,
      io,
      complete: cannedComplete({
        decompose: '{"spec":"s","tickets":[{"title":"Impl A","role":"implementation","check":"true"},{"title":"Test A","role":"testing","check":"true"}]}',
        planMeeting: '{"add":[{"title":"extra","check":"npm test","deps":[]}],"cancel":[],"reopen":[],"note":""}'
      })
    }
    const res = await runHermes('goal', 'proj', cfg(), deps, seams, { maxRounds: 5, planMeeting: true })
    expect(res.reason).toBe('complete')
    // 2 decomposed + the meeting's "extra" ticket. Both present leads (implementation, testing) propose the SAME
    // "extra" title, so the cross-lead dedup collapses them to ONE → 3 on the board (not a duplicate pair).
    expect(board).toHaveLength(3)
  })

  it('runHermes leaves the board at the decomposed size when planMeeting is off (default)', async () => {
    const { board, io } = liveFakeBoard()
    const seams: HermesSeams = {
      runDrainOnce: async () => board.forEach((r) => r.status === 'todo' && (r.status = 'done')),
      getBoardState: async () => board,
      getParked: () => []
    }
    const deps: OrchestratorDeps = {
      settings: {} as Settings,
      io,
      complete: cannedComplete({ decompose: '{"spec":"s","tickets":[{"title":"Impl A","role":"implementation","check":"true"},{"title":"Test A","role":"testing","check":"true"}]}' })
    }
    const res = await runHermes('goal', 'proj', cfg(), deps, seams, { maxRounds: 5 })
    expect(res.reason).toBe('complete')
    expect(board).toHaveLength(2)
  })
})

describe('runDecompose context-sizing', () => {
  it('rejects an over-scoped ticket (huge body) and accepts the split re-decompose', async () => {
    const huge = 'x'.repeat(6000) // > OVERSCOPE_BODY_CHARS (5000)
    let call = 0
    let secondUser = ''
    const complete: OrchestratorDeps['complete'] = async (messages) => {
      call++
      if (call === 1) return JSON.stringify({ spec: 's', tickets: [{ title: 'Everything', body: huge, check: 'npm test' }] })
      secondUser = String(messages[1]?.content ?? '')
      return JSON.stringify({ spec: 's', tickets: [{ title: 'Slice A', body: 'small', check: 'npm test' }, { title: 'Slice B', body: 'small', check: 'npm test' }] })
    }
    const plan = await runDecompose('goal', cfg(), { settings: {} as Settings, io: fakeBoard(), complete })
    expect(call).toBe(2) // first plan rejected (over-scoped), repaired on the retry
    expect(secondUser).toMatch(/over-scoped|split/i) // the rejection reason was fed back
    expect(plan.tickets).toHaveLength(2)
    expect(plan.tickets.every((t) => t.body.length <= 5000)).toBe(true)
  })

  it('accepts a normally-sized plan without a retry', async () => {
    let call = 0
    const complete: OrchestratorDeps['complete'] = async () => {
      call++
      return JSON.stringify({ spec: 's', tickets: [{ title: 'A', body: 'do the thing', check: 'npm test' }] })
    }
    const plan = await runDecompose('goal', cfg(), { settings: {} as Settings, io: fakeBoard(), complete })
    expect(call).toBe(1)
    expect(plan.tickets).toHaveLength(1)
  })
})

describe('runDepartmentGrooming (department backlog right-sizing)', () => {
  it('the dept lead splits an over-scoped leaf ticket, growing the plan + emitting a notice', async () => {
    const draft: DecomposePlan = {
      spec: 's',
      tickets: [
        { title: 'Scaffold', body: '', role: 'implementation', check: 'true' },
        { title: 'Expand test suite & enforce coverage', body: '', role: 'testing', check: 'pytest', deps: [0] }
      ]
    }
    const complete: OrchestratorDeps['complete'] = async (messages) => {
      const sys = String(messages[0]?.content ?? '')
      if (/BACKLOG GROOMING/i.test(sys) && /TESTING/.test(sys)) {
        return '{"splits":[{"index":1,"pieces":[{"title":"test mesh_loader","check":"pytest tests/test_mesh_loader.py"},{"title":"test slicer_core","check":"pytest tests/test_slicer_core.py"},{"title":"enforce coverage","check":"pytest --cov","deps":[0,1]}]}]}'
      }
      return '{"splits":[]}'
    }
    const events: LoopEvent[] = []
    const out = await runDepartmentGrooming('goal', draft, cfg(), { settings: {} as Settings, io: fakeBoard(), complete, emit: (e) => events.push(e) })
    expect(out.tickets).toHaveLength(4) // 2 original + 2 appended pieces
    expect(out.tickets[1].title).toBe('test mesh_loader') // piece 0 reused the index
    expect(out.tickets.map((t) => t.title)).toContain('enforce coverage')
    expect(events.some((e) => e.kind === 'notice' && /too broad — split into 3/.test(e.text))).toBe(true)
  })

  it('leaves a right-sized plan alone when the lead returns no splits', async () => {
    const draft: DecomposePlan = { spec: 's', tickets: [{ title: 'Impl A', body: '', role: 'implementation', check: 'true' }] }
    const complete: OrchestratorDeps['complete'] = async () => '{"splits":[]}'
    const out = await runDepartmentGrooming('goal', draft, cfg(), { settings: {} as Settings, io: fakeBoard(), complete })
    expect(out.tickets).toHaveLength(1)
  })

  it('runHermes: a grooming/meeting failure falls back to the decomposed plan — the board still gets tickets (no empty board)', async () => {
    const { board, io } = liveFakeBoard()
    const seams: HermesSeams = {
      runDrainOnce: async () => board.forEach((r) => r.status === 'todo' && (r.status = 'done')),
      getBoardState: async () => board,
      getParked: () => []
    }
    const deps: OrchestratorDeps = {
      settings: {} as Settings,
      io,
      complete: cannedComplete({
        decompose: '{"spec":"s","tickets":[{"title":"Impl A","role":"implementation","check":"true"},{"title":"Test A","role":"testing","check":"true"}]}',
        groom: () => {
          throw new Error('grooming model error')
        }
      })
    }
    const res = await runHermes('goal', 'proj', cfg(), deps, seams, { maxRounds: 5, planMeeting: true })
    expect(res.reason).toBe('complete')
    expect(board).toHaveLength(2) // decompose plan written despite grooming throwing — never an empty board
  })
})

describe('meeting ↔ team-memory loop', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-mem-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  const cfgIn = (d: string): LoopConfig => ({ ...cfg(), cwd: d })
  const onePlan = (): DecomposePlan => ({ spec: 's', tickets: [{ title: 'Impl A', body: '', role: 'implementation', check: 'npm test' }] })

  it('feeds the department memory into the lead’s meeting prompt (READ)', async () => {
    writeTeamMemory(dir, 'implementation', '- the infill module has no edge-case tests')
    let sawMemory = false
    const complete: OrchestratorDeps['complete'] = async (messages) => {
      if (/infill module has no edge-case tests/.test(String(messages[1]?.content ?? ''))) sawMemory = true
      return '{"add":[],"cancel":[],"reopen":[],"note":"ok"}'
    }
    await runDecomposeMeeting('goal', onePlan(), cfgIn(dir), { settings: {} as Settings, io: fakeBoard(), complete })
    expect(sawMemory).toBe(true)
  })

  it('persists a <memory> block the lead appends after the JSON (WRITE)', async () => {
    const complete: OrchestratorDeps['complete'] = async () =>
      '{"add":[],"cancel":[],"reopen":[],"note":"ok"}\n<memory>\n- prefer pytest -x for fast localization\n</memory>'
    await runDecomposeMeeting('goal', onePlan(), cfgIn(dir), { settings: {} as Settings, io: fakeBoard(), complete })
    expect(readTeamMemory(dir, 'implementation')).toMatch(/prefer pytest -x/)
  })

  it('writes nothing when the lead emits no <memory> block (no clobber)', async () => {
    writeTeamMemory(dir, 'implementation', '- keep this existing craft')
    const complete: OrchestratorDeps['complete'] = async () => '{"add":[],"cancel":[],"reopen":[],"note":"ok"}'
    await runDecomposeMeeting('goal', onePlan(), cfgIn(dir), { settings: {} as Settings, io: fakeBoard(), complete })
    expect(readTeamMemory(dir, 'implementation')).toMatch(/keep this existing craft/)
  })
})

describe('gatherCriticEvidence (Q3)', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'critic-'))
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('includes file names AND real source contents, skipping ignored dirs', () => {
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const hello = () => 42\n')
    writeFileSync(join(dir, 'README.md'), '# My Project\n')
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'node_modules', 'junk.js'), 'should not appear')

    const ev = gatherCriticEvidence(dir)
    expect(ev).toContain('src/index.ts')
    expect(ev).toContain('export const hello = () => 42') // the actual code, not just the filename
    expect(ev).toContain('# My Project')
    expect(ev).not.toContain('should not appear') // node_modules is never walked
    expect(ev).not.toContain('junk.js')
  })

  it('returns empty string for an unreadable folder', () => {
    expect(gatherCriticEvidence(join(dir, 'does-not-exist'))).toBe('')
  })

  it('truncates source contents to the budget', () => {
    writeFileSync(join(dir, 'big.ts'), 'x'.repeat(5000))
    const ev = gatherCriticEvidence(dir, 1000)
    expect(ev).toContain('…(truncated)')
    expect(ev.length).toBeLessThan(2000)
  })
})

describe('craftSystem — Brooke\'s memory shapes the PLAN (close the learning loop)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'craft-'))
    setManagerMemoryDir(dir)
  })
  afterEach(() => {
    setManagerMemoryDir('')
    rmSync(dir, { recursive: true, force: true })
  })

  it('appends her accumulated craft to a planning prompt so the decompose avoids past mistakes', () => {
    writeManagerMemory('- a scaffold check must NOT bundle Test-Path with npm install in one boolean')
    const out = craftSystem('DECOMPOSE RULES…')
    expect(out).toContain('DECOMPOSE RULES…') // base prompt preserved
    expect(out).toContain('a scaffold check must NOT bundle Test-Path') // her lesson is injected
    expect(out).toContain('accumulated CRAFT') // under a labelled section the planner is told to APPLY
  })

  it('leaves the prompt unchanged when she has learned nothing yet', () => {
    expect(craftSystem('BASE PROMPT')).toBe('BASE PROMPT')
  })

  it('replan distills a <memory> lesson from failures into the cross-project memory (rejections → better plans)', async () => {
    // The replan emits its JSON diff + a <memory> block generalizing why tickets parked (what reviewers kept rejecting).
    const replanText =
      '{"add":[],"cancel":[],"reopen":[],"note":"split the parked scaffold"}\n' +
      '<memory>\n- A scaffold check must not bundle Test-Path with npm install — the exit code rides on npm alone.\n</memory>'
    const deps: OrchestratorDeps = { settings: {} as Settings, io: fakeBoard(), complete: cannedComplete({ decompose: ONE_TICKET, replan: replanText }) }
    await runReplan('goal', 'spec', [], [1], cfg(), deps)
    expect(readManagerMemory()).toContain('A scaffold check must not bundle Test-Path with npm install') // folded into Brooke's memory
  })

  it('replan with NO <memory> block leaves the memory untouched (only generalizable lessons land)', async () => {
    writeManagerMemory('- existing lesson')
    const deps: OrchestratorDeps = { settings: {} as Settings, io: fakeBoard(), complete: cannedComplete({ decompose: ONE_TICKET, replan: '{"add":[],"cancel":[],"reopen":[],"note":"nothing new"}' }) }
    await runReplan('goal', 'spec', [], [], cfg(), deps)
    expect(readManagerMemory()).toBe('- existing lesson') // unchanged
  })
})

describe('L2 self-heal — a Decision Record ends a contested concept (the godkveld thrash)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'decide-'))
    setManagerMemoryDir(dir)
  })
  afterEach(() => {
    setManagerMemoryDir('')
    rmSync(dir, { recursive: true, force: true })
  })

  // The deck-exhaustion fight: a done deck-impl plus four OPEN tickets relitigating the empty-deck contract.
  const deckBoard = (): BoardTicketRow[] =>
    [
      { id: 100, title: 'Implement Deck module (shuffle + deal)', status: 'done' },
      { id: 201, title: 'Implement deck auto-reset when empty', status: 'todo', check: 'npx vitest run' },
      { id: 202, title: 'Remove deck auto-reset from Deck module; handle empty deck in CLI', status: 'todo', check: 'npx vitest run' },
      { id: 203, title: 'Handle empty deck in CLI by creating new Deck instance when dealCard returns null', status: 'todo', check: 'npx vitest run' },
      { id: 204, title: 'Remove deck auto-reset logic and update Deck tests', status: 'todo', check: 'npx vitest run' }
    ] as BoardTicketRow[]
  const deckConcept = (board: BoardTicketRow[]) =>
    detectContestedConcepts(board, { parkEpisodes: {}, addedIds: [201, 202, 203, 204] })[0]!
  const DECISION = (cancel: number[]): string =>
    JSON.stringify({
      decision: '## Context\nEmpty-deck behavior was undecided.\n## Decision\ndealCard() returns null when empty; callers create a fresh Deck.\n## Consequences\nDeck owns no multi-round state.',
      contract: 'Deck.dealCard() returns null when empty and never auto-resets; callers create a fresh Deck.',
      apply: { title: 'Apply empty-deck decision across deck + cli', body: 'Implement the decision and remove auto-reset.', check: 'npx vitest run' },
      cancel,
      lesson: 'Decide resource-exhaustion / boundary contracts in the plan, before splitting tickets.'
    })

  it('detects the deck cluster as one contested concept', () => {
    const c = deckConcept(deckBoard())
    expect(c.ticketIds.sort()).toEqual([201, 202, 203, 204])
    expect(c.addedCount).toBe(4)
  })

  it('rules once: records the decision, supersedes the OPEN thrashing tickets, files one apply-ticket, learns the lesson', async () => {
    const board = deckBoard()
    const io = fakeBoard()
    const deps: OrchestratorDeps = { settings: {} as Settings, io, complete: cannedComplete({ decompose: ONE_TICKET, decide: DECISION([201, 202, 203, 204]) }) }
    const res = await resolveContestedConcept(deckConcept(board), board, 'goal', 'spec', 'proj', { ...cfg(), cwd: dir }, deps, io)

    expect(res.healed).toBe(true)
    // the four OPEN deck tickets were cancelled; the DONE deck-impl (#100) was never touched.
    expect(io.statuses.filter((s) => s.status === 'cancelled').map((s) => s.id).sort()).toEqual([201, 202, 203, 204])
    expect(io.statuses.some((s) => s.id === 100)).toBe(false)
    // exactly ONE apply-ticket, carrying the decision inline so the worker obeys it.
    expect(io.creates).toHaveLength(1)
    expect(io.creates[0].title).toMatch(/apply empty-deck decision/i)
    expect(io.creates[0].body).toContain('DECISION OF RECORD')
    // the generalized lesson reached Brooke's cross-project memory; the decision reached the project's architecture memory.
    expect(readManagerMemory()).toContain('Decide resource-exhaustion / boundary contracts in the plan')
    expect(readTeamMemory(dir, 'architecture')).toContain('Decision —')
  })

  it('supersedes ALL open cluster tickets when the model names none to cancel', async () => {
    const board = deckBoard()
    const io = fakeBoard()
    const deps: OrchestratorDeps = { settings: {} as Settings, io, complete: cannedComplete({ decompose: ONE_TICKET, decide: DECISION([]) }) }
    await resolveContestedConcept(deckConcept(board), board, 'goal', 'spec', 'proj', { ...cfg(), cwd: dir }, deps, io)
    expect(io.statuses.filter((s) => s.status === 'cancelled').map((s) => s.id).sort()).toEqual([201, 202, 203, 204])
    expect(io.creates).toHaveLength(1)
  })

  it('degrades safely when the decision turn returns nothing usable — no cancels, no apply-ticket', async () => {
    const board = deckBoard()
    const io = fakeBoard()
    const deps: OrchestratorDeps = { settings: {} as Settings, io, complete: cannedComplete({ decompose: ONE_TICKET, decide: 'sorry, not json' }) }
    const res = await resolveContestedConcept(deckConcept(board), board, 'goal', 'spec', 'proj', { ...cfg(), cwd: dir }, deps, io)
    expect(res.healed).toBe(false)
    expect(io.statuses).toHaveLength(0)
    expect(io.creates).toHaveLength(0)
  })

  it('runHermes collapses a 2-hour-style thrash into one Decision Record and completes', async () => {
    const { board, io } = liveFakeBoard()
    let drained = 0
    const DECK = [
      'Implement deck auto-reset when empty',
      'Remove deck auto-reset from Deck module; handle empty deck in CLI',
      'Handle empty deck in CLI by creating new Deck instance when dealCard returns null',
      'Remove deck auto-reset logic and update Deck tests'
    ]
    const seams: HermesSeams = {
      runDrainOnce: async () => {
        if (drained++ === 0) {
          // round 1: the planned work settles, but a pile of overlapping deck-exhaustion tickets appears (the churn).
          board.forEach((r) => r.status === 'todo' && (r.status = 'done'))
          DECK.forEach((title, i) =>
            board.push({ id: 300 + i, project: 'proj', title, status: 'todo', body: '', deps: [], check: 'npx vitest run' } as BoardTicketRow)
          )
        } else {
          board.forEach((r) => r.status === 'todo' && (r.status = 'done')) // later: the apply-ticket gets done
        }
      },
      getBoardState: async () => board,
      getParked: () => []
    }
    const integrationCheck = (): IntegrationCheckResult => ({ ok: true, orphans: [], hasIntegrationTest: true, detail: 'verified' })
    const deps: OrchestratorDeps = { settings: {} as Settings, io, integrationCheck, complete: cannedComplete({ decompose: ONE_TICKET, decide: DECISION([300, 301, 302, 303]) }) }
    const res = await runHermes('goal', 'proj', { ...cfg(), cwd: dir }, deps, seams, { maxRounds: 8 })

    // the four thrashing tickets were superseded, replaced by exactly one apply-ticket — and the run completed.
    expect(board.filter((r) => r.id >= 300 && r.id <= 303).every((r) => r.status === 'cancelled')).toBe(true)
    expect(board.filter((r) => /apply empty-deck decision/i.test(r.title))).toHaveLength(1)
    expect(readManagerMemory()).toContain('Decide resource-exhaustion / boundary contracts in the plan')
    expect(res.reason).toBe('complete')
  })
})

describe('P0 — draftRichSpec (Brooke owns a rich, contract-complete spec)', () => {
  it('turns a goal into a structured spec with decided contracts + rendered markdown', async () => {
    const specJson = JSON.stringify({
      scope: 'A CLI blackjack game; no GUI.',
      contracts: [
        'Deck.deal() returns null when empty; callers create a fresh Deck (Deck owns no multi-round state).',
        'Errors surface as a thrown Error, never silent nulls.'
      ],
      interfaces: ['Deck.deal(): Card | null', 'Game.playRound(): Result'],
      acceptance: ['npx vitest run passes', 'CLI plays a full round']
    })
    const deps: OrchestratorDeps = { settings: {} as Settings, io: fakeBoard(), complete: cannedComplete({ decompose: ONE_TICKET, draftSpec: specJson }) }
    const spec = await draftRichSpec('build a blackjack CLI', cfg(), deps)
    expect(spec.goal).toBe('build a blackjack CLI')
    expect(spec.contracts).toHaveLength(2)
    expect(spec.contracts[0]).toMatch(/returns null when empty/)
    expect(spec.markdown).toContain('## Contracts (decided up front)')
    expect(spec.markdown).toContain('Deck owns no multi-round state')
  })

  it('degrades safely to a minimal spec wrapping the goal when the turn returns garbage (never throws)', async () => {
    const deps: OrchestratorDeps = { settings: {} as Settings, io: fakeBoard(), complete: cannedComplete({ decompose: ONE_TICKET, draftSpec: 'sorry, no json here' }) }
    const spec = await draftRichSpec('build a thing', cfg(), deps)
    expect(spec.goal).toBe('build a thing')
    expect(spec.contracts).toEqual([])
    expect(spec.markdown).toContain('# build a thing')
  })

  it('the lazy path drafts the spec — the notice reports the decided-contract count', async () => {
    const { board, io } = liveFakeBoard()
    const notices: string[] = []
    const specJson = JSON.stringify({ scope: 's', contracts: ['A owns X', 'B propagates errors'], interfaces: [], acceptance: ['ok'] })
    const seams: HermesSeams = {
      runDrainOnce: async () => board.forEach((r) => r.status === 'todo' && (r.status = 'done')),
      getBoardState: async () => board,
      getParked: () => []
    }
    const deps: OrchestratorDeps = {
      settings: {} as Settings,
      io,
      complete: cannedComplete({ decompose: ONE_TICKET, draftSpec: specJson }),
      emit: (e: LoopEvent) => { if (e.kind === 'notice') notices.push(e.text) }
    }
    await runHermes('goal', 'proj', cfg(), deps, seams, { maxRounds: 5, lazyDecompose: true })
    expect(notices.some((t) => /drafted a rich spec with 2 decided contract/i.test(t))).toBe(true)
  })
})

describe('P1 — coarse attempt + verify gate → complete / needs-split', () => {
  it('attempts the whole goal as ONE coarse root ticket; a passing drain → complete', async () => {
    const { board, io } = liveFakeBoard()
    const notices: string[] = []
    const seams: HermesSeams = {
      runDrainOnce: async () => board.forEach((r) => r.status === 'todo' && (r.status = 'done')), // the whole attempt passes
      getBoardState: async () => board,
      getParked: () => []
    }
    const deps: OrchestratorDeps = {
      settings: {} as Settings,
      io,
      complete: cannedComplete({ decompose: ONE_TICKET, draftSpec: '{"scope":"s","contracts":["A owns X"],"interfaces":[],"acceptance":["ok"],"check":"npx vitest run"}' }),
      emit: (e: LoopEvent) => { if (e.kind === 'notice') notices.push(e.text) }
    }
    const res = await runHermes('build a blackjack CLI', 'proj', cfg(), deps, seams, { maxRounds: 5, lazyDecompose: true })
    // exactly ONE coarse root ticket was seeded (not an eager decompose into many)
    expect(board.filter((t) => /^Build:/.test(t.title))).toHaveLength(1)
    expect(res.reason).toBe('complete')
    expect(notices.some((t) => /lazy build complete/i.test(t))).toBe(true)
  })

  it('a PARKED coarse attempt (drain leaves the root unfinished) → needs-split', async () => {
    const { board, io } = liveFakeBoard()
    const notices: string[] = []
    const seams: HermesSeams = {
      runDrainOnce: async () => {}, // the worker can't converge → the root stays unfinished (parked)
      getBoardState: async () => board,
      getParked: () => board.filter((t) => t.status !== 'done').map((t) => t.id)
    }
    const deps: OrchestratorDeps = {
      settings: {} as Settings,
      io,
      complete: cannedComplete({ decompose: ONE_TICKET }),
      emit: (e: LoopEvent) => { if (e.kind === 'notice') notices.push(e.text) }
    }
    const res = await runHermes('build a huge thing', 'proj', cfg(), deps, seams, { maxRounds: 5, lazyDecompose: true })
    expect(res.reason).toBe('needs-split')
    // with no viable split (default split turn escalates), the parked root is held at the contract floor
    expect(notices.some((t) => /contract floor/i.test(t))).toBe(true)
  })
})

describe('P2 — park → split into contract-coherent slices, recurse, integrate', () => {
  const SPEC_JSON = JSON.stringify({ scope: 's', contracts: ['Deck owns no multi-round state'], interfaces: [], acceptance: ['ok'], check: 'npx vitest run' })

  // A board whose fake drain respects deps + a settable set of park-by-title regexes, advancing to a fixpoint.
  const lazyBoard = () => {
    const { board, io } = liveFakeBoard()
    const parkTitles: RegExp[] = []
    const depsDone = (t: BoardTicketRow): boolean => (t.deps ?? []).every((d) => { const x = board.find((b) => b.id === d); return !x || x.status === 'done' || x.status === 'cancelled' })
    const parks = (t: BoardTicketRow): boolean => parkTitles.some((re) => re.test(t.title))
    const seams: HermesSeams = {
      runDrainOnce: async () => {
        let changed = true
        while (changed) {
          changed = false
          for (const t of board) if (t.status === 'todo' && !parks(t) && depsDone(t)) { t.status = 'done'; changed = true }
        }
      },
      getBoardState: async () => board,
      getParked: () => board.filter((t) => t.status === 'todo' && parks(t) && depsDone(t)).map((t) => t.id)
    }
    return { board, io, seams, parkTitles }
  }

  it('a parked root is split into contract-coherent slices that build, then the whole verifies → complete', async () => {
    const { board, io, seams, parkTitles } = lazyBoard()
    parkTitles.push(/^Build:/) // the coarse root is too big → parks
    const notices: string[] = []
    const splitJson = JSON.stringify({ escalate: false, reason: 'by subsystem', children: [
      { title: 'Slice: deck + dealing', body: 'build deck and dealing', check: 'npx vitest run' },
      { title: 'Slice: scoring + rules', body: 'build scoring and rules', check: 'npx vitest run' }
    ] })
    const deps: OrchestratorDeps = { settings: {} as Settings, io, complete: cannedComplete({ decompose: ONE_TICKET, draftSpec: SPEC_JSON, split: splitJson }), emit: (e: LoopEvent) => { if (e.kind === 'notice') notices.push(e.text) } }
    const res = await runHermes('build blackjack', 'proj', cfg(), deps, seams, { maxRounds: 10, lazyDecompose: true })
    expect(res.reason).toBe('complete')
    expect(board.find((t) => /^Build:/.test(t.title))?.status).toBe('cancelled') // the root was superseded by slices
    expect(board.filter((t) => /^Slice:/.test(t.title) && t.status === 'done')).toHaveLength(2)
    expect(notices.some((t) => /split #\d+.*into 2 contract-coherent/i.test(t))).toBe(true)
  })

  it('escalates at the contract floor (cannot split) → needs-split, node held', async () => {
    const { io, seams, parkTitles } = lazyBoard()
    parkTitles.push(/^Build:/)
    const notices: string[] = []
    const splitJson = JSON.stringify({ escalate: true, reason: 'cannot split without cutting the deck contract', children: [] })
    const deps: OrchestratorDeps = { settings: {} as Settings, io, complete: cannedComplete({ decompose: ONE_TICKET, draftSpec: SPEC_JSON, split: splitJson }), emit: (e: LoopEvent) => { if (e.kind === 'notice') notices.push(e.text) } }
    const res = await runHermes('build blackjack', 'proj', cfg(), deps, seams, { maxRounds: 10, lazyDecompose: true })
    expect(res.reason).toBe('needs-split')
    expect(notices.some((t) => /contract floor/i.test(t))).toBe(true)
  })

  it('recurses: a parked SLICE is itself split, then the whole completes', async () => {
    const { board, io, seams, parkTitles } = lazyBoard()
    parkTitles.push(/^Build:/, /^Core engine$/) // the root parks, and so does the "Core engine" slice
    let n = 0
    const splitFn = (): string => {
      n++
      return n === 1
        ? JSON.stringify({ escalate: false, reason: 'r1', children: [{ title: 'Core engine', body: 'core', check: 'npx vitest run' }, { title: 'Feature layer', body: 'feat', check: 'npx vitest run' }] })
        : JSON.stringify({ escalate: false, reason: 'r2', children: [{ title: 'CoreA', body: 'a', check: 'npx vitest run' }, { title: 'CoreB', body: 'b', check: 'npx vitest run' }] })
    }
    const deps: OrchestratorDeps = { settings: {} as Settings, io, complete: cannedComplete({ decompose: ONE_TICKET, draftSpec: SPEC_JSON, split: splitFn }) }
    const res = await runHermes('build blackjack', 'proj', cfg(), deps, seams, { maxRounds: 12, lazyDecompose: true })
    expect(res.reason).toBe('complete')
    expect(board.find((t) => t.title === 'Core engine')?.status).toBe('cancelled') // the parked slice was split in turn
    expect(board.filter((t) => /^Core[AB]$/.test(t.title) && t.status === 'done')).toHaveLength(2)
  })

  it('slices build but the assembled whole is unverified → files a wire-up node, then completes', async () => {
    const { board, io, seams, parkTitles } = lazyBoard()
    parkTitles.push(/^Build:/)
    let i = 0
    const integrationCheck = (): IntegrationCheckResult => (++i === 1 ? { ok: false, orphans: ['src/x.ts'], hasIntegrationTest: false, detail: 'built-but-unwired: src/x.ts.' } : { ok: true, orphans: [], hasIntegrationTest: true, detail: 'verified' })
    const splitJson = JSON.stringify({ escalate: false, reason: 'by subsystem', children: [{ title: 'Slice: A', body: 'a', check: 'npx vitest run' }, { title: 'Slice: B', body: 'b', check: 'npx vitest run' }] })
    const deps: OrchestratorDeps = { settings: {} as Settings, io, integrationCheck, complete: cannedComplete({ decompose: ONE_TICKET, draftSpec: SPEC_JSON, split: splitJson }) }
    const res = await runHermes('build blackjack', 'proj', cfg(), deps, seams, { maxRounds: 12, lazyDecompose: true })
    expect(res.reason).toBe('complete')
    expect(board.some((t) => /wire-up \+ integration/i.test(t.title))).toBe(true)
  })
})

describe('P3 — grain/seam memory + warm-start (the compounding loop)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lazy-mem-'))
    setManagerMemoryDir(dir)
  })
  afterEach(() => {
    setManagerMemoryDir('')
    rmSync(dir, { recursive: true, force: true })
  })

  it("warm-start: Brooke's accumulated memory is injected into the spec-draft prompt", async () => {
    writeManagerMemory('- decide resource-exhaustion contracts up front')
    let draftSys = ''
    const complete: OrchestratorDeps['complete'] = async (messages) => {
      const sys = String(messages[0]?.content ?? '')
      if (/contract-complete spec/i.test(sys)) {
        draftSys = sys
        return '{"scope":"s","contracts":["c"],"interfaces":[],"acceptance":["ok"],"check":"npx vitest run"}'
      }
      return '{"add":[],"cancel":[],"reopen":[],"note":""}'
    }
    const deps: OrchestratorDeps = { settings: {} as Settings, io: fakeBoard(), complete }
    await draftRichSpec('build a thing', cfg(), deps)
    expect(draftSys).toContain('decide resource-exhaustion contracts up front')
  })

  it('records a GRAIN lesson when the coarse attempt fit one pass', async () => {
    const { board, io } = liveFakeBoard()
    const seams: HermesSeams = {
      runDrainOnce: async () => board.forEach((r) => r.status === 'todo' && (r.status = 'done')),
      getBoardState: async () => board,
      getParked: () => []
    }
    const deps: OrchestratorDeps = { settings: {} as Settings, io, complete: cannedComplete({ decompose: ONE_TICKET }) }
    await runHermes('build a tiny CLI', 'proj', cfg(), deps, seams, { maxRounds: 5, lazyDecompose: true })
    expect(readManagerMemory()).toMatch(/Grain:.*fit ONE coarse pass/i)
  })

  it('records a SEAM lesson when the attempt had to be split (memory proposes, execution disposes)', async () => {
    const { board, io } = liveFakeBoard()
    const parkTitles = [/^Build:/]
    const depsDone = (t: BoardTicketRow): boolean => (t.deps ?? []).every((d) => { const x = board.find((b) => b.id === d); return !x || x.status === 'done' || x.status === 'cancelled' })
    const parks = (t: BoardTicketRow): boolean => parkTitles.some((re) => re.test(t.title))
    const seams: HermesSeams = {
      runDrainOnce: async () => { let ch = true; while (ch) { ch = false; for (const t of board) if (t.status === 'todo' && !parks(t) && depsDone(t)) { t.status = 'done'; ch = true } } },
      getBoardState: async () => board,
      getParked: () => board.filter((t) => t.status === 'todo' && parks(t) && depsDone(t)).map((t) => t.id)
    }
    const splitJson = JSON.stringify({ escalate: false, reason: 'split by subsystem boundary', children: [{ title: 'Slice X', body: 'x', check: 'npx vitest run' }, { title: 'Slice Y', body: 'y', check: 'npx vitest run' }] })
    const deps: OrchestratorDeps = { settings: {} as Settings, io, complete: cannedComplete({ decompose: ONE_TICKET, split: splitJson }) }
    await runHermes('build a big app', 'proj', cfg(), deps, seams, { maxRounds: 10, lazyDecompose: true })
    expect(readManagerMemory()).toMatch(/Seam:.*split by subsystem boundary/i)
  })
})

describe('W5a — the lazy path speaks the typed Mission Control events', () => {
  it('emits planning -> decompose(1 root) -> draining -> done on a one-pass complete', async () => {
    const { board, io } = liveFakeBoard()
    const events: LoopEvent[] = []
    const seams: HermesSeams = {
      runDrainOnce: async () => board.forEach((r) => r.status === 'todo' && (r.status = 'done')),
      getBoardState: async () => board,
      getParked: () => []
    }
    const deps: OrchestratorDeps = {
      settings: {} as Settings,
      io,
      complete: cannedComplete({ decompose: ONE_TICKET }),
      emit: (e: LoopEvent) => events.push(e)
    }
    await runHermes('build a blackjack CLI', 'proj', cfg(), deps, seams, { maxRounds: 5, lazyDecompose: true })

    const states = events.filter((e): e is Extract<LoopEvent, { kind: 'hermes-state' }> => e.kind === 'hermes-state').map((e) => e.state)
    expect(states[0]).toBe('planning')
    expect(states).toContain('draining')
    expect(states[states.length - 1]).toBe('done')
    const rounds = events.filter((e): e is Extract<LoopEvent, { kind: 'hermes-round' }> => e.kind === 'hermes-round')
    expect(rounds[0]).toMatchObject({ phase: 'decompose', round: 0, tickets: 1 })
  })

  it('a split emits a typed split round with the slice count', async () => {
    const { board, io } = liveFakeBoard()
    const parkRoot = (t: { title: string }): boolean => /^Build:/.test(t.title)
    const depsDone = (t: BoardTicketRow): boolean => (t.deps ?? []).every((d) => { const x = board.find((b) => b.id === d); return !x || x.status === 'done' || x.status === 'cancelled' })
    const seams: HermesSeams = {
      runDrainOnce: async () => {
        for (const t of board) if (t.status === 'todo' && !parkRoot(t) && depsDone(t)) t.status = 'done'
      },
      getBoardState: async () => board,
      getParked: () => board.filter((t) => t.status === 'todo' && parkRoot(t)).map((t) => t.id)
    }
    const events: LoopEvent[] = []
    const deps: OrchestratorDeps = {
      settings: {} as Settings,
      io,
      complete: cannedComplete({
        decompose: ONE_TICKET,
        split: JSON.stringify({ children: [{ title: 'Deck + rules', body: 'b', check: '' }, { title: 'Table UI', body: 'b', check: '' }], reason: 'engine/ui seam' })
      }),
      emit: (e: LoopEvent) => events.push(e)
    }
    await runHermes('build a big thing', 'proj', cfg(), deps, seams, { maxRounds: 6, lazyDecompose: true })

    const splitRound = events.find((e): e is Extract<LoopEvent, { kind: 'hermes-round' }> => e.kind === 'hermes-round' && e.phase === 'split')
    expect(splitRound).toMatchObject({ phase: 'split', added: 2 })
    expect(splitRound?.note).toMatch(/engine\/ui seam/)
  })
})
