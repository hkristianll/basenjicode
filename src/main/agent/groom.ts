// Department-lead BACKLOG GROOMING: a dept manager right-sizes its own draft tickets before any worker runs,
// SPLITTING an over-scoped "sweep" ticket (expand the whole test suite, enforce coverage, build the entire
// frontend) into focused, one-session pieces. This is the pure transform; specOrchestrator.runDepartmentGrooming
// drives the LLM lead and applies it. CONSERVATIVE: only LEAF tickets (nothing depends on them) are split, so no
// dependency is ever orphaned — and over-scoped sweeps are almost always leaves (terminal work).
import { z } from 'zod'
import { extractJsonObject, normalizeRole, MAX_DECOMPOSE_TICKETS, type DecomposePlan, type PlanTicket, type Department } from './specPlan'

const groomPieceSchema = z.object({
  title: z.string().trim().min(1, 'a split piece needs a title'),
  body: z.string().default(''),
  check: z.string().optional(),
  /** 0-based indices INTO this split's own pieces (e.g. a final "enforce coverage" piece depends on the test pieces). */
  deps: z.array(z.number().int()).optional()
})
const groomSplitSchema = z.object({
  /** Local index (into the draft plan's tickets) of the over-scoped ticket to split. */
  index: z.number().int(),
  pieces: z.array(groomPieceSchema).min(2, 'a split must produce at least 2 pieces')
})
const groomDiffSchema = z.object({ splits: z.array(groomSplitSchema).default([]) })

/** Public shapes (body optional — the parser fills it via the schema default; callers/tests can omit it). */
export interface GroomPiece {
  title: string
  body?: string
  check?: string
  /** 0-based indices INTO this split's own pieces. */
  deps?: number[]
}
export interface GroomSplit {
  index: number
  pieces: GroomPiece[]
}

/** Parse a department lead's grooming output into split operations. Best-effort — returns [] on any malformed
 *  output, so a bad grooming turn simply leaves the tickets un-split (no harm). */
export function parseGroomSplits(text: string): GroomSplit[] {
  try {
    const json = extractJsonObject(text)
    if (!json) return []
    const res = groomDiffSchema.safeParse(JSON.parse(json))
    return res.success ? res.data.splits : []
  } catch {
    return []
  }
}

export interface GroomResult {
  plan: DecomposePlan
  applied: { index: number; title: string; pieceCount: number }[]
  skipped: { index: number; reason: string }[]
}

/**
 * Apply a department lead's SPLITS to the draft plan. LEAF-safe (only splits tickets nothing depends on, so no
 * dependency is orphaned), cap-respecting (never past MAX_DECOMPOSE_TICKETS), and scoped to `dept` (a lead can only
 * split its own tickets). piece[0] REUSES the original index (so existing indices stay stable — no re-wiring); the
 * rest are appended. Every piece inherits the original ticket's external deps (its prerequisites) plus its own
 * intra-piece deps (0-based into the split's pieces). Pure → unit-tested.
 */
export function applyGroomSplits(plan: DecomposePlan, splits: GroomSplit[], dept: Department): GroomResult {
  const tickets: PlanTicket[] = plan.tickets.map((t) => ({ ...t, deps: [...(t.deps ?? [])] }))
  // Indices something depends on (computed from the ORIGINAL plan) → NOT leaves, never split.
  const dependedOn = new Set<number>()
  for (const t of plan.tickets) for (const d of t.deps ?? []) dependedOn.add(d)

  const applied: GroomResult['applied'] = []
  const skipped: GroomResult['skipped'] = []
  for (const sp of splits) {
    const i = sp.index
    if (i < 0 || i >= plan.tickets.length) { skipped.push({ index: i, reason: 'no such ticket' }); continue }
    const orig = plan.tickets[i]
    if (normalizeRole(orig.role) !== dept) { skipped.push({ index: i, reason: 'not this department' }); continue }
    if (dependedOn.has(i)) { skipped.push({ index: i, reason: 'other tickets depend on it (not a leaf)' }); continue }
    if (tickets.length + (sp.pieces.length - 1) > MAX_DECOMPOSE_TICKETS) { skipped.push({ index: i, reason: 'would exceed the ticket cap' }); continue }

    // piece 0 reuses index i; pieces 1..N claim appended indices.
    const at: number[] = sp.pieces.map((_, k) => (k === 0 ? i : -1))
    for (let k = 1; k < sp.pieces.length; k++) {
      at[k] = tickets.length
      tickets.push({ title: '', body: '', role: dept, deps: [] }) // placeholder, filled below
    }
    const external = orig.deps ?? [] // prerequisites every piece still needs
    sp.pieces.forEach((p, k) => {
      const intra = (p.deps ?? []).filter((d) => d >= 0 && d < sp.pieces.length).map((d) => at[d])
      tickets[at[k]] = {
        title: p.title.trim(),
        body: p.body ?? '',
        check: p.check,
        role: dept,
        deps: [...new Set([...external, ...intra])].filter((d) => d !== at[k]) // dedup, no self-dep
      }
    })
    applied.push({ index: i, title: orig.title, pieceCount: sp.pieces.length })
  }
  return { plan: { spec: plan.spec, tickets }, applied, skipped }
}
