// Per-team, per-project "lead memory" (team-leads feature, Phase 1). The team lead is a CONTEXT BUFFER: it
// holds its department's accumulated, non-obvious craft so per-ticket workers stay lean — the lead distills a
// tiny brief in, judges the work, and folds durable learnings back out here. One curated markdown per
// department under the work folder; capped, so the lead's own context stays bounded (over the cap it summarizes
// rather than appends). Pure fs + best-effort (a failed read/write degrades to "no memory", never throws), so
// it unit-tests headless; the model-bound brief/distill steps wire on top in later phases.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Department } from './specPlan'

/** Hard cap on a team's lead memory. Richer than a worker brief (only a distilled slice reaches a worker), but
 *  still bounded so the lead's context never balloons. Over this, the lead SUMMARIZES (rewrites tighter). */
export const TEAM_MEMORY_CAP = 4_000

function memoryPath(cwd: string, dept: Department): string {
  return join(cwd, '.nordcode', 'hermes', 'memory', `${dept}.md`)
}

/** Pull the inner text of a `<memory>…</memory>` block from a model response — the convention the reviewer AND
 *  the meeting leads use to emit updated team memory alongside their JSON. Returns the trimmed inner text, or
 *  null when there is no block (or it is empty). */
export function extractMemoryBlock(text: string): string | null {
  const m = text.match(/<memory>([\s\S]*?)<\/memory>/i)
  const inner = m?.[1]?.trim()
  return inner ? inner : null
}

/** A team's lead memory, or '' when none/unreadable (so an empty/missing store reads as "no memory yet"). */
export function readTeamMemory(cwd: string, dept: Department): string {
  try {
    const p = memoryPath(cwd, dept)
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  } catch {
    return ''
  }
}

/**
 * R11: strip junk a weak lead model tends to dump into its <memory> block BEFORE it becomes authoritative craft
 * injected into EVERY future worker's brief (boardSeed): code fences, diff file/hunk HEADERS, meta-instructions
 * ("rewrite everything"), and near-duplicate bullets. Conservative — only unambiguous junk is removed (a false
 * drop just leaves memory stale, which is safe; the status quo of poisoned memory compounding across a whole
 * department's tickets is worse). Crucially it must NEVER drop a markdown `- bullet` (the memory's own format),
 * so diff detection matches only `+++`/`---`/`@@` headers, never single `-`/`+` lines. Pure → tested.
 */
export function sanitizeTeamMemory(content: string): string {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const t = line.trim()
    if (/^```/.test(t)) continue // code fence (restated code)
    if (/^(\+\+\+|---)\s/.test(t) || /^@@ /.test(t)) continue // diff file/hunk HEADERS only (never a `- bullet`)
    if (/\b(rewrite everything|delete all|ignore (the )?(previous|prior)|start over|disregard (the )?(above|memory))\b/i.test(t)) continue
    const key = t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    if (key && seen.has(key)) continue // near-duplicate bullet
    if (key) seen.add(key)
    kept.push(line)
  }
  return kept.join('\n') // NOT trimmed — preserve the caller's trailing newline (round-trip fidelity)
}

/** Persist a team's lead memory (best-effort; sanitizes junk, then trims to the cap as a hard backstop). */
export function writeTeamMemory(cwd: string, dept: Department, content: string): void {
  const clean = sanitizeTeamMemory(content)
  if (!clean.trim()) return // nothing worth persisting → leave the existing memory unchanged
  try {
    mkdirSync(join(cwd, '.nordcode', 'hermes', 'memory'), { recursive: true })
    writeFileSync(memoryPath(cwd, dept), clean.slice(0, TEAM_MEMORY_CAP))
  } catch {
    /* best-effort: memory is an optimization, never block a ticket on a failed write */
  }
}

/** At/over the cap → the lead should SUMMARIZE (rewrite the memory tighter) on its next write, not append. */
export function isOverCap(content: string): boolean {
  return content.length >= TEAM_MEMORY_CAP
}
