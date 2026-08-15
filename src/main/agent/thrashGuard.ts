// L2 self-healing — concept-level THRASH detection (pure, model-free, headless-testable).
//
// The orchestrator already has a stuck-guard (`stuckRounds`/`lastSig`) but it watches the BOARD SIGNATURE —
// it trips only when the board stops changing. The godkveld overnight run thrashed for ~2 hours with a board
// that changed EVERY round (tickets added, parked, released, reopened) over one undecided question ("what
// happens when the deck runs out?"). The signature kept moving, so the guard never fired: the team looked busy
// while making no real progress.
//
// This module detects that pattern at the CONCEPT level instead of the board level: it clusters the run's
// tickets by what they're ABOUT (shared declared files + significant title tokens) and flags a concept as
// CONTESTED when the run is visibly fighting it — a ticket re-parking, the replan piling on near-duplicate
// tickets, or a ticket cancelled as "contradicts the architecture". The orchestrator (impure, in
// specOrchestrator.ts) feeds events here and, on a contested concept, rules once with a Decision Record instead
// of relitigating. Everything in THIS file is a pure function over plain data so it unit-tests without Electron,
// a board, or a model.
import { filesOf } from './specPlan'

/** A ticket re-parking this many times (a re-park = it parked AGAIN after a reopen/release) marks its concept
 *  contested — healthy work parks at most once before the team converges. */
export const RE_PARK_THRESHOLD = 2
/** This many replan/critic-ADDED tickets piling onto one concept across rounds is churn, not planning. The
 *  ORIGINAL decompose's tickets don't count — only post-decompose adds — so a clean plan with 3 deck tickets
 *  (impl/test/integration) never trips this. */
export const CLUSTER_SIZE_THRESHOLD = 3
/** Two tickets whose concept-token sets overlap at least this much (Jaccard) are treated as near-duplicates. */
export const DUP_TITLE_JACCARD = 0.5
/** Two tickets join the same concept when their token sets overlap at least this much. Low enough that the
 *  godkveld deck cluster stays connected through its weakest spanning link (~0.5), high enough that distinct
 *  modules sharing one or two glue words (the original CLI ticket's "cli"+"game") stay apart. */
export const LINK_JACCARD = 0.3

/** Minimal ticket shape the detector needs — works for a BoardTicketRow or any {id,title,body}. */
export interface TicketLike {
  id: number
  title: string
  body?: string | null
}

/** The per-run friction aggregates the detector needs. The orchestrator computes these from data it already
 *  has each round: park EPISODES from `createParkTracker` (the one stateful bit), churn from "which ids aren't
 *  in the original decompose", and contradiction-cancels from cancel reasons. */
export interface RunSignals {
  /** ticketId → number of distinct park EPISODES (re-entries into the parked set), not raw park-state samples. */
  parkEpisodes: Record<number, number>
  /** Tickets created AFTER the initial decompose (replan/critic churn). Cluster members in this set count
   *  toward the pile-on signal; the original plan's tickets never do. */
  addedIds?: number[]
  /** Tickets cancelled citing an architecture/contradiction conflict (the explicit "we're fighting a
   *  decision" signal). */
  contradictionIds?: number[]
}

/** Counts distinct park EPISODES across a run. A ticket that simply STAYS parked across rounds is one episode;
 *  it only counts again when it leaves the parked set (released/reopened) and re-enters — that re-entry is the
 *  thrash signal the board-signature guard misses. Driven once per round with the current parked set. */
export function createParkTracker(): {
  observe(parkedIds: number[]): void
  forget(ids: number[]): void
  episodes(): Record<number, number>
} {
  let current = new Set<number>()
  const counts = new Map<number, number>()
  return {
    observe(parkedIds: number[]): void {
      const next = new Set(parkedIds)
      for (const id of next) if (!current.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1)
      current = next
    },
    /** Drop park history for tickets whose concept has just been DECIDED (cancelled/superseded) — their friction
     *  is resolved, so it must not keep the concept flagged contested on later rounds. */
    forget(ids: number[]): void {
      for (const id of ids) {
        counts.delete(id)
        current.delete(id)
      }
    },
    episodes: (): Record<number, number> => Object.fromEntries(counts)
  }
}

/** A cluster of tickets that are all about the same thing, with the friction it has accumulated. */
export interface Concept {
  /** A short human label built from the cluster's strongest tokens (e.g. "deck+auto+reset"). */
  label: string
  ticketIds: number[]
  tokens: string[]
  /** Sum of park events across the cluster. */
  parkTotal: number
  /** The most times any single ticket in the cluster parked (the re-park signal). */
  maxTicketParks: number
  /** A ticket in the cluster was cancelled citing an architecture/contradiction conflict. */
  cancelledContradiction: boolean
  /** Replan/critic-ADDED tickets in the cluster (the pile-on signal). */
  addedCount: number
  contested: boolean
  /** Why it tripped — a sentence fed to the decision turn and the user notice. '' when not contested. */
  reason: string
}

// Boilerplate that carries no concept meaning: ticket-template verbs/nouns + common English. Stripped before
// clustering so two tickets only link on DOMAIN words ("deck", "empty", "reset"), not "implement"/"module".
const STOPWORDS = new Set([
  // template verbs
  'implement', 'fix', 'test', 'tests', 'testing', 'add', 'adds', 'remove', 'removes', 'handle', 'handles',
  'update', 'updates', 'create', 'creates', 'creating', 'expose', 'exposes', 'ensure', 'ensures', 'make',
  'makes', 'build', 'builds', 'setup', 'verify', 'detect', 'detects', 'return', 'returns', 'support',
  'wire', 'wires', 'wireup', 'refactor', 'cover', 'covers',
  // template nouns
  'module', 'modules', 'instance', 'instances', 'logic', 'entry', 'point', 'team', 'ticket', 'project',
  'code', 'file', 'files', 'method', 'methods', 'class', 'function', 'functions', 'feature', 'scaffold',
  'behavior', 'behaviour', 'usage', 'documentation',
  // generic glue (length>=3 so the length filter doesn't catch them)
  'the', 'and', 'for', 'that', 'this', 'new', 'any', 'all', 'its', 'with', 'when', 'from', 'into', 'via',
  'not', 'use', 'uses', 'using', 'per', 'are', 'was', 'has', 'have', 'each', 'one', 'two', 'full', 'proper'
])

const CODE_EXT = /\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|rb)$/i
const SPEC_TEST = /\.(?:spec|test)(?=\.[a-z]+$)/i

/** Reduce a path to its concept token: `src/deck.spec.ts` → `deck`, `src/cli.ts` → `cli`. So impl, spec and
 *  test files of the same module all collapse to one token. */
export function basenameToken(path: string): string {
  const base = (path.split(/[\\/]/).pop() ?? path).trim()
  return base.replace(SPEC_TEST, '').replace(CODE_EXT, '').toLowerCase()
}

function wordTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
}

/** Find code-path-like strings anywhere in a ticket (title or body prose), not just the `**Files:**` banner —
 *  replan-added tickets often name `src/deck.ts` in prose without a formal banner. */
function pathTokens(t: TicketLike): string[] {
  const text = `${t.title}\n${t.body ?? ''}`
  const paths = text.match(/[\w./\\-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|rb)\b/gi) ?? []
  return paths.map(basenameToken)
}

/** The set of concept tokens a ticket is "about" — significant title words + declared-file basenames +
 *  any code paths named in its body. Used both to cluster tickets and to compare two for duplication. */
export function conceptTokens(t: TicketLike): Set<string> {
  const out = new Set<string>()
  for (const w of wordTokens(t.title)) out.add(w)
  for (const f of filesOf(t.body)) out.add(basenameToken(f))
  for (const p of pathTokens(t)) if (p) out.add(p)
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** Cluster tickets into concepts: two tickets join the same concept when their token sets overlap by at least
 *  LINK_JACCARD. Pairwise similarity (not single-shared-token) so a concept that DOMINATES the board — a
 *  deck-heavy run where most tickets mention "deck" — still clusters correctly, while distinct modules that
 *  happen to share one boilerplate-survivor word stay apart. Union-find; O(n²) is fine for board-sized inputs. */
export function groupConcepts(tickets: TicketLike[]): { ticketIds: number[]; tokens: string[] }[] {
  const n = tickets.length
  if (n === 0) return []
  const tokenSets = tickets.map(conceptTokens)

  // Union-find by ticket index.
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) parent[i] = parent[parent[i]]!, (i = parent[i]!)
    return i
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  // Link every pair whose token overlap clears the threshold.
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) if (jaccard(tokenSets[i]!, tokenSets[j]!) >= LINK_JACCARD) union(i, j)

  // Collect components.
  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    const arr = groups.get(r) ?? []
    arr.push(i)
    groups.set(r, arr)
  }
  return [...groups.values()].map((idxs) => {
    const ids = idxs.map((i) => tickets[i]!.id)
    // Rank the cluster's tokens by frequency within the cluster for a stable, descriptive label.
    const freq = new Map<string, number>()
    for (const i of idxs) for (const tok of tokenSets[i]!) freq.set(tok, (freq.get(tok) ?? 0) + 1)
    const tokens = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t)
    return { ticketIds: ids, tokens }
  })
}

/** Inspect the run's friction signals against the current tickets and return the CONTESTED concepts — the
 *  ones the run is fighting. Empty when the run is healthy. Each contested concept is a candidate for a
 *  Decision Record. */
export function detectContestedConcepts(tickets: TicketLike[], signals: RunSignals): Concept[] {
  const groups = groupConcepts(tickets)

  const parkByTicket = signals.parkEpisodes
  const addedTickets = new Set(signals.addedIds ?? [])
  const contradictionTickets = new Set(signals.contradictionIds ?? [])

  const concepts: Concept[] = groups.map((g) => {
    const maxTicketParks = g.ticketIds.reduce((m, id) => Math.max(m, parkByTicket[id] ?? 0), 0)
    const parkTotal = g.ticketIds.reduce((s, id) => s + (parkByTicket[id] ?? 0), 0)
    const addedCount = g.ticketIds.filter((id) => addedTickets.has(id)).length
    const cancelledContradiction = g.ticketIds.some((id) => contradictionTickets.has(id))

    const reasons: string[] = []
    if (maxTicketParks >= RE_PARK_THRESHOLD) reasons.push(`a ticket parked ${maxTicketParks}× without converging`)
    if (addedCount >= CLUSTER_SIZE_THRESHOLD) reasons.push(`${addedCount} overlapping tickets were piled onto it`)
    if (cancelledContradiction) reasons.push('a ticket was cancelled as contradicting the architecture')

    return {
      label: g.tokens.slice(0, 3).join('+') || `#${g.ticketIds[0]}`,
      ticketIds: g.ticketIds,
      tokens: g.tokens,
      parkTotal,
      maxTicketParks,
      cancelledContradiction,
      addedCount,
      contested: reasons.length > 0,
      reason: reasons.join('; ')
    }
  })

  return concepts.filter((c) => c.contested)
}

/** Before the orchestrator commits a replan/critic ADD, check whether it merely restates an already-open
 *  ticket (the #1268≈#1271 / #1269≈#1270 duplication godkveld produced). Returns the id it duplicates, if any,
 *  so the caller can skip or merge instead of piling on. Done/cancelled tickets are NOT candidates — only
 *  still-open work can be a true duplicate of new work. */
export function isDuplicateAdd(
  candidate: { title: string; body?: string | null; files?: string[] },
  openTickets: TicketLike[]
): { duplicate: boolean; ofId?: number; similarity: number } {
  const cand = conceptTokens({ id: -1, title: candidate.title, body: candidate.body })
  for (const f of candidate.files ?? []) cand.add(basenameToken(f))

  let ofId: number | undefined
  let best = 0
  for (const t of openTickets) {
    const sim = jaccard(cand, conceptTokens(t))
    if (sim > best) {
      best = sim
      ofId = t.id
    }
  }
  return best >= DUP_TITLE_JACCARD ? { duplicate: true, ofId, similarity: best } : { duplicate: false, similarity: best }
}
