import { describe, it, expect } from 'vitest'
import { applyGroomSplits, parseGroomSplits } from './groom'
import { MAX_DECOMPOSE_TICKETS, type DecomposePlan, type PlanTicket } from './specPlan'

const plan = (tickets: PlanTicket[]): DecomposePlan => ({ spec: 's', tickets })

describe('parseGroomSplits', () => {
  it('parses a valid splits object', () => {
    const out = parseGroomSplits('{"splits":[{"index":2,"pieces":[{"title":"A","check":"npm test"},{"title":"B","check":"npm test"}]}]}')
    expect(out).toHaveLength(1)
    expect(out[0].index).toBe(2)
    expect(out[0].pieces).toHaveLength(2)
  })
  it('returns [] on malformed / missing JSON, or a split with < 2 pieces (best-effort)', () => {
    expect(parseGroomSplits('no json here')).toEqual([])
    expect(parseGroomSplits('{"splits":[{"index":1,"pieces":[{"title":"only one"}]}]}')).toEqual([])
  })
})

describe('applyGroomSplits', () => {
  it('splits an over-scoped LEAF — piece 0 reuses the index, the rest append, deps map correctly', () => {
    const p = plan([
      { title: 'Scaffold', body: '', role: 'implementation', deps: [] },
      { title: 'Expand test suite', body: '', role: 'testing', check: 'pytest', deps: [0] } // leaf (nothing depends on it)
    ])
    const res = applyGroomSplits(
      p,
      [
        {
          index: 1,
          pieces: [
            { title: 'test mesh_loader', check: 'pytest tests/test_mesh_loader.py' },
            { title: 'test slicer_core', check: 'pytest tests/test_slicer_core.py' },
            { title: 'enforce coverage', check: 'pytest --cov', deps: [0, 1] } // depends on the two test pieces
          ]
        }
      ],
      'testing'
    )
    expect(res.applied).toHaveLength(1)
    expect(res.skipped).toHaveLength(0)
    expect(res.plan.tickets).toHaveLength(4) // 2 original + 2 appended
    expect(res.plan.tickets[1].title).toBe('test mesh_loader') // piece 0 reused index 1
    expect(res.plan.tickets[1].deps).toEqual([0]) // inherited the original's external prerequisite
    expect(res.plan.tickets[3].title).toBe('enforce coverage')
    // intra-deps [0,1] → plan indices [1,2]; plus inherited external [0]
    expect([...(res.plan.tickets[3].deps ?? [])].sort((a, b) => a - b)).toEqual([0, 1, 2])
  })

  it('skips a NON-leaf ticket (something depends on it) — nothing orphaned', () => {
    const p = plan([
      { title: 'Foundation', body: '', role: 'implementation', deps: [] }, // depended on by 1
      { title: 'Feature', body: '', role: 'implementation', deps: [0] }
    ])
    const res = applyGroomSplits(p, [{ index: 0, pieces: [{ title: 'a' }, { title: 'b' }] }], 'implementation')
    expect(res.applied).toHaveLength(0)
    expect(res.skipped[0].reason).toMatch(/leaf/)
    expect(res.plan.tickets).toHaveLength(2)
  })

  it('skips a ticket from another department', () => {
    const p = plan([{ title: 'Docs sweep', body: '', role: 'docs', deps: [] }])
    const res = applyGroomSplits(p, [{ index: 0, pieces: [{ title: 'a' }, { title: 'b' }] }], 'testing')
    expect(res.applied).toHaveLength(0)
    expect(res.skipped[0].reason).toMatch(/department/)
  })

  it('skips a split that would exceed the ticket cap', () => {
    // One below the cap so a 3-piece split (net +2) tips over it — relative to the constant, not a hard-coded 40.
    const many: PlanTicket[] = Array.from({ length: MAX_DECOMPOSE_TICKETS - 1 }, (_, i) => ({ title: `t${i}`, body: '', role: 'testing', deps: [] }))
    const res = applyGroomSplits(plan(many), [{ index: 0, pieces: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] }], 'testing')
    expect(res.applied).toHaveLength(0)
    expect(res.skipped[0].reason).toMatch(/cap/)
  })
})
