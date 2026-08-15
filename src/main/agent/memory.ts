import fs from 'node:fs'
import path from 'node:path'

/**
 * Tier-0 persistent project memory: a small, capped `.nordcode/memory.md` of durable facts that survives
 * across sessions (injected into the system prompt by prompt.ts; written via the remember/forget tools).
 *
 * Anti-bloat is the whole point — even a large store must never poison the prompt. Two layers:
 *   - the STORE is hard-capped on write (≤ MAX_ENTRIES, ≤ MAX_TOTAL_CHARS, each entry ≤ MAX_ENTRY_CHARS,
 *     deduped, oldest evicted FIFO) so the file can't balloon regardless of model behaviour;
 *   - the PROMPT only ever carries the top-k entries RELEVANT to the current task (see rankEntries/retrieve),
 *     so prompt cost stays flat (~k entries) no matter how many facts are stored.
 */
export const MAX_ENTRIES = 300
export const MAX_ENTRY_CHARS = 200
export const MAX_TOTAL_CHARS = 40000

const REL_PATH = path.join('.nordcode', 'memory.md')
const HEADER =
  '# Project memory\n<!-- Durable cross-session facts, one concise line each. Managed by the remember/forget tools; hand-editing is fine. -->\n\n'

function memFile(root: string): string {
  return path.join(root, REL_PATH)
}

/** Normalised key for dedup: trimmed, whitespace-collapsed, lowercased. */
function norm(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Approx stored size of an entry list (`- ` prefix + newline per line). */
function totalChars(entries: string[]): number {
  return entries.reduce((n, e) => n + e.length + 3, 0)
}

/**
 * Pure: fold a new fact into the entry list, enforcing dedup + both caps. Returns the new list and a
 * human note describing any dedup/eviction (so the tool can tell the model what happened).
 */
export function applyRemember(entries: string[], fact: string): { entries: string[]; note: string } {
  const clean = fact.trim().replace(/\s+/g, ' ')
  const key = norm(clean)
  // Dedup: drop any near-identical existing entry, then re-add at the end (most-recent-wins).
  const deduped = entries.filter((e) => norm(e) !== key)
  const wasDup = deduped.length !== entries.length
  const next = [...deduped, clean]

  let evicted = 0
  while (next.length > MAX_ENTRIES) {
    next.shift()
    evicted++
  }
  while (next.length > 1 && totalChars(next) > MAX_TOTAL_CHARS) {
    next.shift()
    evicted++
  }

  const notes: string[] = []
  if (wasDup) notes.push('updated an existing similar entry')
  if (evicted) notes.push(`memory was full — dropped ${evicted} oldest ${evicted === 1 ? 'entry' : 'entries'}`)
  return { entries: next, note: notes.join('; ') }
}

/** Pure: drop every entry whose text contains `query` (case-insensitive). */
export function applyForget(entries: string[], query: string): { entries: string[]; removed: string[] } {
  const q = query.trim().toLowerCase()
  if (!q) return { entries, removed: [] }
  const removed = entries.filter((e) => e.toLowerCase().includes(q))
  const kept = entries.filter((e) => !e.toLowerCase().includes(q))
  return { entries: kept, removed }
}

/** Read the entry lines (best-effort; missing/garbled file → no memory). */
export function readEntries(root: string): string[] {
  try {
    const text = fs.readFileSync(memFile(root), 'utf8')
    return text
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function writeEntries(root: string, entries: string[]): void {
  const body = entries.map((e) => `- ${e}`).join('\n')
  fs.mkdirSync(path.dirname(memFile(root)), { recursive: true })
  fs.writeFileSync(memFile(root), HEADER + body + (body ? '\n' : ''))
}

/** Tool entry point: validate length, fold in, persist. Never throws — returns a model-facing message. */
export function remember(root: string, fact: string): string {
  const clean = fact.trim().replace(/\s+/g, ' ')
  if (!clean) return 'ERROR: nothing to remember (empty fact).'
  if (clean.length > MAX_ENTRY_CHARS) {
    return `ERROR: that fact is ${clean.length} chars — keep each memory under ${MAX_ENTRY_CHARS} chars (one concise line). Shorten it or split it.`
  }
  try {
    const { entries, note } = applyRemember(readEntries(root), clean)
    writeEntries(root, entries)
    return `Remembered (${entries.length}/${MAX_ENTRIES})${note ? ` — ${note}` : ''}.`
  } catch (e) {
    return `ERROR: could not write project memory — ${e instanceof Error ? e.message : String(e)}`
  }
}

/** Tool entry point: drop matching entries, persist. */
export function forget(root: string, query: string): string {
  try {
    const { entries, removed } = applyForget(readEntries(root), query)
    if (!removed.length) return `No memory matched "${query}".`
    writeEntries(root, entries)
    return `Forgot ${removed.length} ${removed.length === 1 ? 'entry' : 'entries'}: ${removed.map((e) => `"${e.slice(0, 60)}"`).join(', ')}.`
  } catch (e) {
    return `ERROR: could not update project memory — ${e instanceof Error ? e.message : String(e)}`
  }
}

// Common words that carry no retrieval signal — dropped so scoring keys on the task's real terms.
const STOP = new Set([
  'the','and','for','with','that','this','from','into','your','have','has','was','are','not','but','you','its',
  'it','a','an','of','to','in','on','is','be','do','i','we','can','will','how','what','why','when','where'
])

function queryTerms(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t)))]
}

function matchScore(entry: string, terms: string[]): number {
  const e = entry.toLowerCase()
  return terms.reduce((n, t) => n + (e.includes(t) ? 1 : 0), 0)
}

/**
 * Pure: pick the ≤k entries most relevant to `query` for prompt injection. Scores by distinct query-term
 * overlap, breaking ties (and an empty/term-less query) by recency. The returned slice is in chronological
 * order so it reads naturally. This is what keeps the prompt flat as the store grows.
 */
export function rankEntries(entries: string[], query: string, k: number): string[] {
  if (!entries.length || k <= 0) return []
  const terms = queryTerms(query)
  if (!terms.length) return entries.slice(-k) // no signal → the most recent k
  return entries
    .map((e, i) => ({ e, score: matchScore(e, terms), i }))
    .sort((a, b) => b.score - a.score || b.i - a.i) // relevance, then recency
    .slice(0, k)
    .sort((a, b) => a.i - b.i) // restore chronological order for display
    .map((x) => x.e)
}

/** Retrieve the top-k relevant memories for the current task, plus the total stored (for a "N of M" hint). */
export function retrieve(root: string, query: string, k: number): { shown: string[]; total: number } {
  const entries = readEntries(root)
  return { shown: rankEntries(entries, query, k), total: entries.length }
}
