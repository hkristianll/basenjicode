#!/usr/bin/env node
// Read the per-turn stop instrumentation (turns.jsonl, written by src/main/agent/turnStats.ts) and print
// a histogram of WHY chat turns end — the raw signal for diagnosing "fumbles and stops without completion".
//
// Usage:
//   node scripts/turn-histogram.mjs                 # default log location, all turns
//   node scripts/turn-histogram.mjs <path.jsonl>    # explicit file
//   node scripts/turn-histogram.mjs --board         # only Mission/board worker turns
//   node scripts/turn-histogram.mjs --chat          # only interactive chat turns
//
// The interesting bars: done_after_nudge (model quit mid-task, only stopped when the nudge budget ran out)
// vs done_clean (genuinely finished). A tall done_after_nudge with autoContinues maxed = raise MAX_AUTO_CONTINUE.
// The BY SURFACE split answers "does Mission struggle where chat doesn't?" — a board column heavy in
// oscillation / stuck_* / circuit_breaker vs a clean chat column is the autonomous-tuning brittleness.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const DEFAULT = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'NordCode', 'logs', 'turns.jsonl')
const argv = process.argv.slice(2)
const surfaceFilter = argv.includes('--board') ? 'board' : argv.includes('--chat') ? 'chat' : null
const file = argv.find((a) => !a.startsWith('--')) || DEFAULT
const isBoard = (r) => r.board === true // undefined (pre-instrumentation) counts as chat

if (!fs.existsSync(file)) {
  console.error(`No turns.jsonl at: ${file}`)
  console.error('Run some NordCode chat sessions first, or pass the path explicitly.')
  process.exit(1)
}

const allRows = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  })
  .filter(Boolean)

if (!allRows.length) {
  console.error('turns.jsonl is empty.')
  process.exit(0)
}

// Apply the surface filter (if any) to everything downstream; the BY SURFACE section below always reports the
// full split so you see both columns regardless of the filter.
const rows = surfaceFilter ? allRows.filter((r) => (surfaceFilter === 'board') === isBoard(r)) : allRows
if (!rows.length) {
  console.error(`No ${surfaceFilter} turns in ${file} (${allRows.length} total).`)
  process.exit(0)
}

const pct = (n) => `${((100 * n) / rows.length).toFixed(1)}%`
const bar = (n, max) => '█'.repeat(Math.round((40 * n) / max))

// --- detail histogram ---
const byDetail = {}
for (const r of rows) byDetail[r.detail] = (byDetail[r.detail] || 0) + 1
const sorted = Object.entries(byDetail).sort((a, b) => b[1] - a[1])
const max = sorted[0][1]

console.log(`\n${rows.length} turns${surfaceFilter ? ` (${surfaceFilter} only, of ${allRows.length})` : ''}  —  ${file}\n`)
console.log('WHY TURNS END (fine sub-reason):')
for (const [detail, n] of sorted) {
  console.log(`  ${detail.padEnd(20)} ${String(n).padStart(5)}  ${pct(n).padStart(6)}  ${bar(n, max)}`)
}

// --- the nudge signal: is the completion-forcing guard firing and failing? ---
const nudgedTurns = rows.filter((r) => r.autoContinues > 0)
const afterNudge = byDetail['done_after_nudge'] || 0
const cleanDone = byDetail['done_clean'] || 0
console.log('\nCOMPLETION-NUDGE SIGNAL:')
console.log(`  turns where the unfinished-nudge fired : ${nudgedTurns.length}  (${pct(nudgedTurns.length)})`)
console.log(`  done_after_nudge vs done_clean         : ${afterNudge} vs ${cleanDone}`)
console.log(`  edit→write_file steer fired            : ${rows.filter((r) => r.nudgedRewrite).length}`)
console.log(`  empty-args steer fired                 : ${rows.filter((r) => r.nudgedEmptyArgs).length}`)

// --- Scout premise: does the cheap relevant-file scorer actually miss where workers go? ---
const measuredReads = rows.filter((r) => typeof r.readsOutsideRelevantFiles === 'number')
if (measuredReads.length) {
  const outside = measuredReads.reduce((sum, r) => sum + r.readsOutsideRelevantFiles, 0)
  const guilty = measuredReads.filter((r) => r.readsOutsideRelevantFiles > 0).length
  console.log('\nSCOUT PREMISE (unique read_file targets outside the relevant-file seed):')
  console.log(`  measured board turns                 : ${measuredReads.length}`)
  console.log(`  turns with any outside read          : ${guilty}  (${((100 * guilty) / measuredReads.length).toFixed(1)}%)`)
  console.log(`  outside reads total / per turn       : ${outside} / ${(outside / measuredReads.length).toFixed(2)}`)
}

// --- coarse buckets, for reference against the UI's StopReason ---
const byStop = {}
for (const r of rows) byStop[r.stopReason] = (byStop[r.stopReason] || 0) + 1
console.log('\nCOARSE StopReason (what the UI shows):')
for (const [s, n] of Object.entries(byStop).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s.padEnd(20)} ${String(n).padStart(5)}  ${pct(n)}`)
}

// --- BY SURFACE: Mission/board vs chat (always on the FULL set, so both columns show under any filter) ---
const board = allRows.filter(isBoard)
const chat = allRows.filter((r) => !isBoard(r))
if (board.length && chat.length) {
  // The details that signify autonomous brittleness rather than a clean finish.
  const STRUGGLE = ['oscillation', 'stuck_edit', 'stuck_empty_args', 'stuck_repeat_fail', 'loop_identical_ok', 'circuit_breaker', 'truncated_midtool', 'max_completions']
  const share = (set, pred) => (set.length ? `${((100 * set.filter(pred).length) / set.length).toFixed(0)}%` : '—')
  const struggle = (r) => STRUGGLE.includes(r.detail)
  console.log('\nBY SURFACE (does Mission struggle where chat does not?):')
  console.log(`  ${'surface'.padEnd(8)} ${'turns'.padStart(6)}  ${'struggle'.padStart(9)}  ${'done_after_nudge'.padStart(16)}  ${'warnContinues>0'.padStart(15)}`)
  for (const [name, set] of [['board', board], ['chat', chat]]) {
    console.log(
      `  ${name.padEnd(8)} ${String(set.length).padStart(6)}  ${share(set, struggle).padStart(9)}  ${share(set, (r) => r.detail === 'done_after_nudge').padStart(16)}  ${share(set, (r) => (r.warnContinues || 0) > 0).padStart(15)}`
    )
  }
}

// --- per-model split (different models fumble differently) ---
const models = [...new Set(rows.map((r) => r.model).filter(Boolean))]
if (models.length > 1) {
  console.log('\nBY MODEL (done_after_nudge share = how often it quits mid-task):')
  for (const m of models) {
    const mr = rows.filter((r) => r.model === m)
    const an = mr.filter((r) => r.detail === 'done_after_nudge').length
    console.log(`  ${m.padEnd(34)} ${String(mr.length).padStart(4)} turns  done_after_nudge ${((100 * an) / mr.length).toFixed(0)}%`)
  }
}
console.log()
