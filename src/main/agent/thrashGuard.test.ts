import { describe, it, expect } from 'vitest'
import {
  basenameToken,
  conceptTokens,
  groupConcepts,
  detectContestedConcepts,
  createParkTracker,
  isDuplicateAdd,
  RE_PARK_THRESHOLD,
  CLUSTER_SIZE_THRESHOLD,
  type TicketLike
} from './thrashGuard'

// The real godkveld overnight board (Blackjack CLI): a clean original plan (one entity per file) PLUS the
// deck-exhaustion cluster the run thrashed on for ~2 hours. Used across the suite as a realistic fixture.
const CLEAN: TicketLike[] = [
  { id: 1244, title: 'Implement Card module' },
  { id: 1246, title: 'Implement Deck module (shuffle + deal)' },
  { id: 1248, title: 'Implement Hand module (scoring with soft aces)' },
  { id: 1250, title: 'Implement Rules module (dealer hits on 16, stands on 17, blackjack pays 3:2)' },
  { id: 1252, title: 'Implement Betting module (chips/payouts)' },
  { id: 1254, title: 'Implement Player module' },
  { id: 1256, title: 'Implement Dealer module (hit/stand strategy)' },
  { id: 1258, title: 'Implement Game module (plays one full round)' },
  { id: 1260, title: 'Implement CLI entry point (interactive terminal game)' },
  { id: 1262, title: 'Create README and usage documentation' }
]

const DECK_CLUSTER: TicketLike[] = [
  { id: 1265, title: 'Implement deck auto-reset when empty' },
  { id: 1266, title: 'Fix Deck module: expose dealCard() returning null when empty' },
  { id: 1268, title: 'Remove deck auto-reset from Deck module; handle empty deck in CLI/Game by creating new Deck instance' },
  { id: 1269, title: 'Handle empty deck in Game/CLI by creating new Deck instance when dealCard returns null' },
  { id: 1270, title: 'Handle empty deck in CLI by creating new Deck instance when dealCard returns null' },
  { id: 1271, title: 'Remove deck auto-reset logic from Deck module and update Deck tests' }
]

const GODKVELD = [...CLEAN, ...DECK_CLUSTER]

const conceptWith = (concepts: ReturnType<typeof detectContestedConcepts>, id: number) =>
  concepts.find((c) => c.ticketIds.includes(id))

// The non-original (replan/critic-added) godkveld tickets — the whole deck cluster was added after decompose.
const ADDED_IDS = DECK_CLUSTER.map((t) => t.id)

describe('basenameToken', () => {
  it('reduces a path to the module token, dropping dir, .spec/.test and extension', () => {
    expect(basenameToken('src/deck.ts')).toBe('deck')
    expect(basenameToken('src/deck.spec.ts')).toBe('deck')
    expect(basenameToken('src/deck.test.ts')).toBe('deck')
    expect(basenameToken('src\\scenes\\GameScene.tsx')).toBe('gamescene')
  })
})

describe('conceptTokens', () => {
  it('keeps domain words, drops template boilerplate', () => {
    const toks = conceptTokens({ id: 1, title: 'Implement Deck module (shuffle + deal)' })
    expect(toks).toContain('deck')
    expect(toks).toContain('shuffle')
    expect(toks).toContain('deal')
    expect(toks).not.toContain('implement')
    expect(toks).not.toContain('module')
  })

  it('pulls module tokens from declared **Files:** and from code paths named in the body prose', () => {
    const banner = conceptTokens({ id: 1, title: 'Wire it up', body: '**Files:** src/deck.ts, src/cli.ts' })
    expect(banner).toContain('deck')
    expect(banner).toContain('cli')

    const prose = conceptTokens({ id: 2, title: 'Remove auto-reset', body: 'Ensure the Deck module (src/deck.ts) does not auto-reset.' })
    expect(prose).toContain('deck')
    expect(prose).toContain('auto')
    expect(prose).toContain('reset')
  })
})

describe('groupConcepts', () => {
  it('clusters the six thrashing deck tickets into ONE concept', () => {
    const groups = groupConcepts(GODKVELD)
    const deckGroup = groups.find((g) => g.ticketIds.includes(1268))!
    expect(deckGroup).toBeTruthy()
    for (const id of [1265, 1266, 1268, 1269, 1270, 1271]) expect(deckGroup.ticketIds).toContain(id)
    expect(deckGroup.tokens[0]).toBe('deck') // most-frequent token leads the label
  })

  it('does NOT sweep the clean, distinct modules into the deck concept', () => {
    const groups = groupConcepts(GODKVELD)
    const deckGroup = groups.find((g) => g.ticketIds.includes(1268))!
    // Card / Hand / Betting / CLI-entry / Game-impl are their own concerns — they must not be in the deck fight.
    for (const id of [1244, 1248, 1252, 1258, 1260]) expect(deckGroup.ticketIds).not.toContain(id)
  })

  it('returns [] for an empty board', () => {
    expect(groupConcepts([])).toEqual([])
  })
})

describe('detectContestedConcepts', () => {
  it('flags the deck concept — and only it — on the godkveld signals', () => {
    // The real run: #1268 parked repeatedly, #1265 cancelled as contradicting the architecture, and the
    // replan piled #1266/1268/1269/1270/1271 onto the same concept.
    const contested = detectContestedConcepts(GODKVELD, {
      parkEpisodes: { 1268: 3 },
      addedIds: ADDED_IDS,
      contradictionIds: [1265]
    })
    expect(contested).toHaveLength(1)
    const c = contested[0]!
    expect(c.ticketIds).toContain(1268)
    expect(c.maxTicketParks).toBe(3)
    expect(c.cancelledContradiction).toBe(true)
    expect(c.addedCount).toBeGreaterThanOrEqual(CLUSTER_SIZE_THRESHOLD)
    expect(c.reason).toMatch(/parked|piled|contradict/)
  })

  it('stays silent on a healthy run — distinct tickets, at most one park each, no contradiction', () => {
    expect(detectContestedConcepts(GODKVELD, { parkEpisodes: { 1248: 1 }, addedIds: [1252] })).toEqual([])
  })

  it('trips on a single ticket that re-parks past the threshold, with no other signal', () => {
    const c = conceptWith(detectContestedConcepts(GODKVELD, { parkEpisodes: { 1268: RE_PARK_THRESHOLD } }), 1268)
    expect(c?.contested).toBe(true)
    expect(c?.maxTicketParks).toBe(RE_PARK_THRESHOLD)
  })

  it('does not treat a one-time park as contested', () => {
    expect(detectContestedConcepts(GODKVELD, { parkEpisodes: { 1268: 1 } })).toEqual([])
  })

  it('does not flag pile-on below the cluster threshold', () => {
    // Only two added tickets touching the concept — churn, but not yet thrash.
    expect(detectContestedConcepts(GODKVELD, { parkEpisodes: {}, addedIds: [1269, 1270] })).toEqual([])
  })
})

describe('createParkTracker', () => {
  it('counts a sustained park as ONE episode, and a re-entry as a new episode', () => {
    const t = createParkTracker()
    t.observe([1268]) // parks
    t.observe([1268]) // still parked — same episode
    t.observe([1268])
    expect(t.episodes()).toEqual({ 1268: 1 })
    t.observe([]) // released (drain handed it to the sequential path / a reopen)
    t.observe([1268]) // re-parks — the thrash signal
    expect(t.episodes()).toEqual({ 1268: 2 })
  })

  it('tracks several tickets independently', () => {
    const t = createParkTracker()
    t.observe([1268, 1271])
    t.observe([1271]) // 1268 released, 1271 still parked
    t.observe([1268]) // 1268 re-parks
    expect(t.episodes()).toEqual({ 1268: 2, 1271: 1 })
  })
})

describe('isDuplicateAdd', () => {
  const open: TicketLike[] = DECK_CLUSTER

  it('flags a near-verbatim restatement (#1269 ≈ #1270)', () => {
    const r = isDuplicateAdd(
      { title: 'Handle empty deck in CLI by creating new Deck instance when dealCard returns null' },
      [{ id: 1269, title: 'Handle empty deck in Game/CLI by creating new Deck instance when dealCard returns null' }]
    )
    expect(r.duplicate).toBe(true)
    expect(r.ofId).toBe(1269)
  })

  it('flags the same intent worded differently (#1268 ≈ #1271)', () => {
    const r = isDuplicateAdd(
      { title: 'Remove deck auto-reset logic from Deck module and update Deck tests' },
      [{ id: 1268, title: 'Remove deck auto-reset from Deck module; handle empty deck in CLI/Game by creating new Deck instance' }]
    )
    expect(r.duplicate).toBe(true)
    expect(r.ofId).toBe(1268)
  })

  it('does NOT flag a genuinely different ticket as a duplicate', () => {
    const r = isDuplicateAdd({ title: 'Implement Hand module (scoring with soft aces)' }, open)
    expect(r.duplicate).toBe(false)
  })

  it('catches a concise restatement that shares the declared file + key terms', () => {
    const r = isDuplicateAdd(
      { title: 'Make Deck return null on empty', files: ['src/deck.ts'] },
      [{ id: 1266, title: 'Fix Deck module: expose dealCard() returning null when empty' }]
    )
    expect(r.duplicate).toBe(true)
    expect(r.ofId).toBe(1266)
  })
})
