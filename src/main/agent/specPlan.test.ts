import { describe, it, expect } from 'vitest'
import { extractJsonObject, parsePlan, orderForCreate, parseReplan, isReplanEmpty, allSettled, normalizeRole, departmentOf, filesOf, MAX_DECOMPOSE_TICKETS, type PlanTicket } from './specPlan'

describe('extractJsonObject', () => {
  it('returns a bare object unchanged', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}')
  })
  it('pulls the object out of ```json fences and prose', () => {
    const t = 'Here is the plan:\n```json\n{"spec":"x","tickets":[]}\n```\nDone.'
    expect(extractJsonObject(t)).toBe('{"spec":"x","tickets":[]}')
  })
  it('respects braces inside strings', () => {
    expect(extractJsonObject('{"body":"use a { brace }"}')).toBe('{"body":"use a { brace }"}')
  })
  it('returns null when there is no object', () => {
    expect(extractJsonObject('no json here')).toBeNull()
  })
})

describe('parsePlan', () => {
  it('parses a valid plan with defaults', () => {
    const plan = parsePlan('{"spec":"build it","tickets":[{"title":"Scaffold"}]}')
    expect(plan.spec).toBe('build it')
    expect(plan.tickets[0].body).toBe('') // defaulted
  })
  it('throws on non-JSON', () => {
    expect(() => parsePlan('totally not json')).toThrow(/no JSON object/)
  })
  it('throws on an empty ticket list', () => {
    expect(() => parsePlan('{"tickets":[]}')).toThrow(/at least one ticket/)
  })
  it('throws on a ticket missing a title', () => {
    expect(() => parsePlan('{"tickets":[{"body":"x"}]}')).toThrow(/title/)
  })
  it('R2: rejects an over-cap decompose so runDecompose re-prompts to merge (never truncates)', () => {
    const tickets = Array.from({ length: MAX_DECOMPOSE_TICKETS + 1 }, (_, i) => ({ title: `t${i}`, body: 'b' }))
    expect(() => parsePlan(JSON.stringify({ spec: 's', tickets }))).toThrow(/too many tickets/)
  })
  it('R2: accepts a plan exactly at the cap', () => {
    const tickets = Array.from({ length: MAX_DECOMPOSE_TICKETS }, (_, i) => ({ title: `t${i}`, body: 'b' }))
    expect(parsePlan(JSON.stringify({ spec: 's', tickets })).tickets).toHaveLength(MAX_DECOMPOSE_TICKETS)
  })
})

describe('orderForCreate', () => {
  const T = (deps?: number[]): PlanTicket => ({ title: 't', body: '', deps })

  it('keeps independent tickets in index order', () => {
    expect(orderForCreate([T(), T(), T()])).toEqual([0, 1, 2])
  })
  it('emits a dep before its dependent', () => {
    // ticket 0 depends on 1 which depends on 2 → create 2,1,0
    expect(orderForCreate([T([1]), T([2]), T()])).toEqual([2, 1, 0])
  })
  it('orders a diamond so both middles precede the join', () => {
    // 0:scaffold, 1->0, 2->0, 3->1,2
    const order = orderForCreate([T(), T([0]), T([0]), T([1, 2])])
    expect(order[0]).toBe(0)
    expect(order.indexOf(3)).toBeGreaterThan(order.indexOf(1))
    expect(order.indexOf(3)).toBeGreaterThan(order.indexOf(2))
  })
  it('throws on a self-dependency', () => {
    expect(() => orderForCreate([T([0])])).toThrow(/itself/)
  })
  it('throws on an out-of-range dep', () => {
    expect(() => orderForCreate([T([5])])).toThrow(/out-of-range/)
  })
  it('throws on a cycle', () => {
    expect(() => orderForCreate([T([1]), T([0])])).toThrow(/cycle/)
  })
})

describe('parseReplan', () => {
  it('parses a diff with defaults for omitted arrays', () => {
    const d = parseReplan('{"reopen":[5],"note":"re-engage stuck work"}')
    expect(d.reopen).toEqual([5])
    expect(d.add).toEqual([])
    expect(d.cancel).toEqual([])
    expect(d.note).toBe('re-engage stuck work')
  })
  it('parses adds with real-id deps', () => {
    const d = parseReplan('{"add":[{"title":"Split A","check":"npm test","deps":[3]}]}')
    expect(d.add[0].title).toBe('Split A')
    expect(d.add[0].deps).toEqual([3])
  })
  it('throws on non-JSON', () => {
    expect(() => parseReplan('nope')).toThrow(/no JSON object/)
  })
})

describe('isReplanEmpty', () => {
  it('true when nothing changes (end the cycle)', () => {
    expect(isReplanEmpty({ add: [], cancel: [], reopen: [], note: 'all good' })).toBe(true)
  })
  it('false when there is any work', () => {
    expect(isReplanEmpty({ add: [], cancel: [9], reopen: [], note: '' })).toBe(false)
  })
})

describe('normalizeRole', () => {
  it('defaults empty/missing to implementation', () => {
    expect(normalizeRole(undefined)).toBe('implementation')
    expect(normalizeRole('')).toBe('implementation')
    expect(normalizeRole('   ')).toBe('implementation')
  })
  it('passes through exact departments', () => {
    expect(normalizeRole('testing')).toBe('testing')
    expect(normalizeRole('Architecture')).toBe('architecture')
  })
  it('maps fuzzy/synonym roles to a department', () => {
    expect(normalizeRole('qa')).toBe('testing')
    expect(normalizeRole('designer')).toBe('design')
    expect(normalizeRole('UI')).toBe('design')
    expect(normalizeRole('ux')).toBe('design')
    expect(normalizeRole('frontend')).toBe('design')
    expect(normalizeRole('code review')).toBe('review')
    expect(normalizeRole('writer')).toBe('docs')
  })
  it('falls back to implementation for unknown roles', () => {
    expect(normalizeRole('frobnicator')).toBe('implementation')
  })
})

describe('departmentOf', () => {
  it('parses the department banner and normalizes it', () => {
    expect(departmentOf('**Department: review** — You are the REVIEW team…\n\nAudit X')).toBe('review')
    expect(departmentOf('**Department: QA**\n\nbody')).toBe('testing') // normalized
  })
  it('returns null when there is no banner', () => {
    expect(departmentOf('just a plain ticket body')).toBeNull()
    expect(departmentOf(undefined)).toBeNull()
  })
})

describe('filesOf', () => {
  it('parses the Files banner into a clean path list (the parallel-batch disjointness key)', () => {
    expect(filesOf('**Department: implementation**\n**Files:** src/entities/Paddle.ts, src/entities/Paddle.test.ts\n\nbody')).toEqual([
      'src/entities/Paddle.ts',
      'src/entities/Paddle.test.ts'
    ])
    expect(filesOf('**Files:** `src/scenes/GameScene.ts`')).toEqual(['src/scenes/GameScene.ts']) // backticks stripped
  })
  it('returns [] when no Files banner is present', () => {
    expect(filesOf('**Department: docs**\n\njust a body')).toEqual([])
    expect(filesOf(undefined)).toEqual([])
  })
})

describe('allSettled', () => {
  it('true when every ticket is done or cancelled', () => {
    expect(allSettled([{ status: 'done' }, { status: 'cancelled' }])).toBe(true)
  })
  it('false when any ticket is still actionable', () => {
    expect(allSettled([{ status: 'done' }, { status: 'review' }])).toBe(false)
    expect(allSettled([{ status: 'todo' }])).toBe(false)
  })
  it('false for an empty board (nothing to be done means nothing was decomposed)', () => {
    expect(allSettled([])).toBe(false)
  })
})
