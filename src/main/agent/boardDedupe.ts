// Find duplicate tickets — the SAME work re-filed many times (the re-file churn that ballooned the overnight
// boards to 76 extra copies of a single title). Pure so the grouping + keep-best decision is unit-tested; the
// caller (ipc `dedupeBoard`) applies the cancellations. CONSERVATIVE matching: a normalized title (lowercase,
// punctuation folded, a trailing "(…)" annotation dropped) so "Foo", "foo", and "Foo (Fixed Check)" collapse —
// but titles that differ by a real content word never merge, so distinct work is never cancelled.

export interface DedupeTicket {
  id: number
  title: string
  status: string
}

export interface DedupeGroup {
  /** The normalized-title key the group shares. */
  key: string
  /** The kept ticket's title (a representative for the group). */
  title: string
  /** The ticket KEPT — the most-advanced copy (done > review > in_progress > todo; ties → lowest id). */
  keepId: number
  /** The duplicate tickets to cancel (everything else in the group). */
  cancelIds: number[]
}

/** Normalize a title for duplicate detection. Folds case + punctuation and drops a TRAILING parenthetical
 *  annotation (e.g. "(Fixed Check)") — but never removes content words, which could merge distinct tickets. */
export function dedupeKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, '') // a trailing "(Fixed Check)" / "(Fix …)" marks the same ticket re-filed
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

const RANK: Record<string, number> = { done: 4, review: 3, in_progress: 2, todo: 1 }

/** Group live (non-cancelled) tickets by normalized title; for each group with >1, KEEP the most-advanced copy
 *  and cancel the rest. Returns only the groups that actually contain duplicates (so an empty result = clean). */
export function planBoardDedupe(tickets: DedupeTicket[]): DedupeGroup[] {
  const groups = new Map<string, DedupeTicket[]>()
  for (const t of tickets) {
    if (t.status === 'cancelled') continue
    const k = dedupeKey(t.title)
    if (!k) continue
    const g = groups.get(k)
    if (g) g.push(t)
    else groups.set(k, [t])
  }
  const out: DedupeGroup[] = []
  for (const [key, g] of groups) {
    if (g.length < 2) continue
    const keep = [...g].sort((a, b) => (RANK[b.status] ?? 0) - (RANK[a.status] ?? 0) || a.id - b.id)[0]
    out.push({ key, title: keep.title, keepId: keep.id, cancelIds: g.filter((t) => t.id !== keep.id).map((t) => t.id) })
  }
  return out
}
