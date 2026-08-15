// Parallel-batch selection for the Hermes drain. Given a set of READY tickets (which are, by definition, mutually
// independent — a ready ticket's deps are all done), pick the largest set that can safely be CODED CONCURRENTLY in
// separate git worktrees: only IMPLEMENTATION tickets that declare DISJOINT files (so their worktrees merge back
// without conflict). Everything else — non-impl roles, tickets with no declared files (can't prove disjoint), and
// tickets that share a file with the batch — runs sequentially on the existing path. Pure (no I/O) → unit-tested;
// the drain owns the worktree/merge effects.
import { departmentOf, filesOf } from './specPlan'

export interface BatchableTicket {
  id: number
  body?: string | null
}

/** Normalize a declared path so "./src/A.ts", "src/A.ts" and "src\A.ts" compare equal (Windows-insensitive). */
function normPath(f: string): string {
  return f
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/** Eligible for the PARALLEL code batch only when it's an IMPLEMENTATION ticket (the coder layer) AND it declares
 *  the file(s) it owns. Without declared files we can't prove disjointness, so it runs sequentially (safe default).
 *  Design/review/testing/docs/architecture tickets are never batched here — they're a different model or touch
 *  shared structure. */
export function isBatchable(t: BatchableTicket): boolean {
  return departmentOf(t.body) === 'implementation' && filesOf(t.body).length > 0
}

/**
 * Greedily select the largest FILE-DISJOINT set of batchable implementation tickets (capped at `max`) from
 * `tickets` (already mutually independent). A ticket whose declared files overlap one already in the batch — or that
 * isn't batchable — falls to `rest` (sequential). A would-be batch of fewer than 2 collapses to all-sequential
 * (there's nothing to parallelize). Order is preserved so the caller's priority ordering is respected.
 */
export function selectParallelBatch(tickets: BatchableTicket[], max: number): { batch: BatchableTicket[]; rest: BatchableTicket[] } {
  if (max <= 1) return { batch: [], rest: tickets }
  const batch: BatchableTicket[] = []
  const rest: BatchableTicket[] = []
  const taken = new Set<string>()
  for (const t of tickets) {
    if (batch.length >= max || !isBatchable(t)) {
      rest.push(t)
      continue
    }
    const files = filesOf(t.body).map(normPath)
    if (files.some((f) => taken.has(f))) {
      rest.push(t) // shares a file with the batch → must serialize
      continue
    }
    files.forEach((f) => taken.add(f))
    batch.push(t)
  }
  if (batch.length < 2) return { batch: [], rest: tickets } // a "batch" of one is just sequential
  return { batch, rest }
}
