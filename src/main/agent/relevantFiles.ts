// Point a per-ticket worker at the files it actually needs, so it stops reading the WHOLE codebase before doing a
// focused task (the "20k tokens of research before writing a line" problem). Done SERVER-SIDE (no LLM, no model
// swap, doesn't consume the worker's context): score each source file by how many of the ticket's terms appear in
// its path/content, return the top few. The seed lists these as "start here", and a lean-research directive tells
// the worker to read only what it needs. Cheap to compute (the same I/O the worker would otherwise do, but once and
// off the worker's context budget).
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.nordcode', '.venv', '__pycache__', '.pytest_cache', '.ruff_cache', 'assets'])
const SRC_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|css|scss|html|json|md|yml|yaml)$/i
// Stopwords + generic ticket verbs/nouns that carry no file signal — drop them so scoring keys on real identifiers.
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'into', 'from', 'at', 'by', 'as', 'is', 'be',
  'create', 'add', 'implement', 'build', 'wire', 'write', 'verify', 'fix', 'update', 'make', 'set', 'setup', 'use',
  'using', 'support', 'handle', 'new', 'that', 'this', 'works', 'work', 'its', 'these', 'those', 'via', 'per', 'each',
  'all', 'also', 'then', 'when', 'where', 'which', 'etc', 'logic', 'system', 'feature', 'file', 'files', 'code',
  'project', 'tests', 'test', 'passes', 'pass', 'ensure', 'should', 'must', 'so', 'it', 'main' // 'main' is too generic on its own; an explicit "main.js" still matches
])

/** Significant terms from a ticket's title+body: explicit filenames mentioned (e.g. "traffic.js") plus content
 *  words ≥3 chars with stopwords removed. Pure → unit-tested. */
export function ticketTerms(title: string, body: string): string[] {
  const text = `${title}\n${body || ''}`
  const files = [...text.matchAll(/[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|css|scss|html|json)\b/gi)].map((m) => m[0].toLowerCase())
  const words = [...text.toLowerCase().matchAll(/[a-z][a-z0-9_]{2,}/g)].map((m) => m[0]).filter((w) => !STOP.has(w))
  return [...new Set([...files, ...words])]
}

/** Score one file against the ticket terms: a term in the PATH is a strong signal (×5), a term in the CONTENT a
 *  weak one (×1). Pure → unit-tested. */
export function scoreFile(relPath: string, content: string, terms: string[]): number {
  const p = relPath.toLowerCase()
  const c = content.toLowerCase()
  let score = 0
  for (const t of terms) {
    if (p.includes(t)) score += 5
    else if (c.includes(t)) score += 1
  }
  return score
}

/** The source files most relevant to a ticket, ranked, capped to `max`. Reads file contents (capped per file)
 *  SERVER-SIDE — this never enters the worker's LLM context; it only produces a short "start here" list. */
export function pickRelevantFiles(cwd: string, ticket: { title: string; body?: string }, max = 6): string[] {
  const terms = ticketTerms(ticket.title, ticket.body ?? '')
  if (!terms.length) return []
  const scored: { path: string; score: number }[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || scored.length > 400) return
    let entries: string[]
    try {
      entries = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const e of entries) {
      if (e.startsWith('.') || SKIP_DIRS.has(e)) continue
      const full = join(dir, e)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        walk(full, depth + 1)
        continue
      }
      if (!SRC_EXT.test(e)) continue
      const rel = relative(cwd, full).replace(/\\/g, '/')
      let content = ''
      try {
        content = readFileSync(full, 'utf8').slice(0, 20_000)
      } catch {
        content = ''
      }
      const score = scoreFile(rel, content, terms)
      if (score > 0) scored.push({ path: rel, score })
    }
  }
  walk(cwd, 0)
  return scored.sort((a, b) => b.score - a.score).slice(0, max).map((s) => s.path)
}

/** Unique read_file targets outside the scorer's seed list — the one metric that gates a richer Scout index. */
export function countReadsOutsideRelevantFiles(cwd: string, absoluteReads: Iterable<string>, relevantFiles: Iterable<string>): number {
  const normalize = (value: string): string => {
    const path = value.replace(/\\/g, '/').replace(/^\.\//, '')
    return process.platform === 'win32' ? path.toLowerCase() : path
  }
  const relevant = new Set([...relevantFiles].map(normalize))
  const outside = new Set<string>()
  for (const absolute of absoluteReads) {
    const rel = normalize(relative(cwd, absolute))
    if (!rel.startsWith('../') && !relevant.has(rel)) outside.add(rel)
  }
  return outside.size
}
