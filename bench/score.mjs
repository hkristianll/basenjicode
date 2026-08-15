const BREAKER_DETAILS = new Set([
  'circuit_breaker',
  'stuck_edit',
  'stuck_empty_args',
  'stuck_repeat_fail',
  'loop_identical_ok',
  'oscillation',
  'validation_failure'
])

const asRecords = (value) => (Array.isArray(value) ? value : value ? [value] : [])
const asLines = (value) => (Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/))

function timestampOf(line) {
  const match = String(line).match(/^\[([^\]]+)]/)
  if (!match) return undefined
  const value = Date.parse(match[1])
  return Number.isFinite(value) ? value : undefined
}

function numberField(line, name) {
  const match = String(line).match(new RegExp(`(?:^|\\s)${name}=([0-9]+(?:\\.[0-9]+)?)`))
  return match ? Number(match[1]) : undefined
}

function rounded(value) {
  return Math.round(value * 100) / 100
}

/** Pure telemetry scorer. It performs no I/O and accepts parsed turns rows, scoped main.log lines, and checks. */
export function scoreRun(turnsRecord, logLines, checkResults) {
  const records = asRecords(turnsRecord)
  const lines = asLines(logLines).filter(Boolean)
  const checks = Array.isArray(checkResults) ? checkResults : []

  const turns = records.reduce((sum, record) => sum + (Number(record?.turns) || 0), 0)
  const breakerFires = records.filter((record) => BREAKER_DETAILS.has(String(record?.detail ?? ''))).length
  const warnContinues = records.reduce((sum, record) => sum + (Number(record?.warnContinues) || 0), 0)
  const summarizedReasoning = lines
    .map((line) => numberField(line, 'reasoningChars'))
    .filter((value) => value !== undefined)
  const reasoningChars = summarizedReasoning.length
    ? summarizedReasoning.reduce((sum, value) => sum + value, 0)
    : lines.reduce((sum, line) => sum + (numberField(line, 'reasoning') ?? 0), 0)

  const summarizedErrors = lines
    .map((line) => numberField(line, 'toolErrors'))
    .filter((value) => value !== undefined)
  const toolErrors = summarizedErrors.length
    ? summarizedErrors.reduce((sum, value) => sum + value, 0)
    : lines.filter((line) => /BENCH tool-result\s+ok=false|tool-result.*\bok=false\b/i.test(line)).length

  const highContextTimes = lines
    .filter((line) => /\bturn=\d+/.test(line) && (numberField(line, 'prompt_tokens') ?? 0) > 50_000)
    .map(timestampOf)
    .filter((value) => value !== undefined)
  const highContextGaps = highContextTimes.slice(1).map((time, index) => (time - highContextTimes[index]) / 1000)
  const avgTurnGapAtHighCtx = highContextGaps.length
    ? rounded(highContextGaps.reduce((sum, value) => sum + value, 0) / highContextGaps.length)
    : null

  const timestamps = [
    ...lines.map(timestampOf),
    ...records.map((record) => {
      const value = Date.parse(String(record?.ts ?? ''))
      return Number.isFinite(value) ? value : undefined
    })
  ].filter((value) => value !== undefined)
  const wallClockSec = timestamps.length >= 2 ? rounded((Math.max(...timestamps) - Math.min(...timestamps)) / 1000) : 0

  return {
    turns,
    wallClockSec,
    toolErrors,
    breakerFires,
    warnContinues,
    reasoningChars,
    avgTurnGapAtHighCtx,
    completionChecksPassed: checks.length > 0 && checks.every((check) => check?.passed === true)
  }
}
