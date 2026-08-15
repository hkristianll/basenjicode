import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Per-turn stop instrumentation. One JSON line per finished chat turn, appended to
 * %APPDATA%/<app>/logs/turns.jsonl — the raw signal for diagnosing "fumbles and stops
 * without completion". The coarse 4-value StopReason collapses ~17 distinct exit points;
 * `detail` is the fine sub-reason, and `autoContinues` records whether the unfinished-nudge
 * guard actually fired. Mirrors logger.ts: lazy path resolve, never throws.
 */

let statsFile: string | null = null

function resolveFile(): string {
  if (!statsFile) {
    const dir = app.getPath('logs')
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* ignore */
    }
    statsFile = path.join(dir, 'turns.jsonl')
  }
  return statsFile
}

/** Fine sub-reason for a turn ending — distinguishes the cases the 4-value StopReason buckets hide. */
export type StopDetail =
  | 'done_clean' // model finished, no nudge was needed
  | 'done_after_nudge' // unfinished-nudge fired ≥1×, then the loop accepted the stop — the prime "fumble" suspect
  | 'truncated_text' // no-tool-call reply cut off at the output-token limit
  | 'truncated_midtool' // tool-call batch cut off mid-arguments (not executed)
  | 'empty_response' // model returned nothing
  | 'stuck_edit' // edit_file kept failing after the write_file steer
  | 'stuck_empty_args' // non-edit tool called with empty args after a nudge
  | 'stuck_repeat_fail' // same failing call 3× or 8 failures in a turn
  | 'loop_identical_ok' // same successful call with identical args 3× (no progress)
  | 'oscillation' // model alternated between two prose responses
  // ── Hermes-parity typed-recovery terminals (W1/W4/W6): the turn ended only after a recovery path
  //    spent its whole budget. Their presence (vs done_after_nudge) shows which weak-model failure mode
  //    finally ended the turn. The mid-turn recovery COUNTERS below show recoveries that succeeded. ──
  | 'thinking_prefill_exhausted' // thinking-only replies (no visible content) never resolved after prefill retries
  | 'empty_after_tool' // model stayed empty after a tool call despite the "process the results" nudge
  | 'truly_empty' // empty replies never resolved after the empty-response retries
  | 'circuit_breaker' // warn-and-continue tripped the high hard-stop threshold (genuinely stuck)
  | 'stall_retry_exhausted' // the model went silent and bounded stall-retries didn't recover
  | 'truncated_toolcall' // the model kept emitting a cut-off (unclosed) text tool call — couldn't be executed
  | 'stall' // LM Studio went silent (90s watchdog)
  | 'conn_error' // connection / completion error
  | 'max_completions' // per-turn model-call ceiling hit (retry/nudge/compaction multiplied)
  | 'max_turns' // reached the tool-round step limit
  | 'cancelled' // user pressed Stop
  | 'no_model' // no model selected
  | 'busy' // turn rejected — session already processing

export interface TurnStat {
  turnId: string
  stopReason: string // the coarse bucket emitted to the UI
  detail: StopDetail | string // the fine sub-reason
  finishReason: string // last model finish_reason this turn
  turns: number // tool rounds reached
  completions: number // total model calls this turn (incl. retries/compaction/nudge)
  autoContinues: number // how many times the unfinished-nudge fired (0 = guard never triggered)
  nudgedRewrite: boolean // edit→write_file steer fired
  nudgedEmptyArgs: boolean // empty-args steer fired
  compactions: number // auto-compactions this turn
  toolCalls: number // total tool calls executed this turn
  editedFiles: number // files this turn touched
  // ── Hermes-parity recovery counters (W1/W4/W6). Optional so older call sites stay valid; each counts how
  //    many times that recovery FIRED this turn — non-zero on a turn that still completed cleanly is the
  //    signal that the cascade is doing its job (recovering instead of bailing). ──
  thinkingPrefills?: number // thinking-only reply → prefilled its own reasoning and continued
  emptyAfterToolNudges?: number // empty-after-tool → "process the results and continue" nudge
  trulyEmptyRetries?: number // empty reply → retried the completion
  truncatedToolRetries?: number // cut-off text tool call → nudged to re-issue smaller
  postCompactNudges?: number // forced "re-orient and continue" nudges after a compaction (false-done guard)
  warnContinues?: number // a repeat/oscillation guard warned but let the loop continue (didn't bail)
  stallRetries?: number // a stalled stream was retried instead of ending the turn
  streamResumes?: number // mid-stream transport drops recovered by the resumable-stream path (W1a)
  model?: string
  // True for a Mission/board per-ticket WORKER turn (session id `loop-<ticket>-…`), false for an interactive
  // chat turn. Lets the histogram split "Mission struggle" from chat without guessing by model name — the two
  // share the same AgentSession engine but run under very different (more brittle) autonomous tuning.
  board?: boolean
}

/** Append one turn's stop record. Self-contained + never throws (telemetry must not break a turn). */
export function recordTurn(s: TurnStat): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...s }) + '\n'
  try {
    fs.appendFileSync(resolveFile(), line)
  } catch {
    /* telemetry must never throw */
  }
}
