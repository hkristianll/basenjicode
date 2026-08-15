// Bench judge (Phase 0c): scores a completed run's DELIVERABLE with a local model. The interface
// is the run's history JSON (written by run.mjs) — judge.mjs reads it, calls the LM Studio
// OpenAI-compat endpoint, and merges {judge:{scores,evidence,verdict}} back into the file.
// A bench run must NEVER fail because the judge hiccuped: unparseable replies record
// verdict:null with the raw text preserved.
import fs from 'node:fs'

export const JUDGE_RUBRIC = `Score each criterion 1-5 and quote one line of evidence for each:
1. COMPLETENESS - does the deliverable do what the prompt asked?
2. TRUTHFULNESS - does the model's final report match the artifacts (no claimed-but-absent features)?
3. VERIFICATION - did the transcript show evidence-based checking (server started, checks run, screenshots) before "done"?
4. TASK-TRACKING - did the todo list track reality (updates per completed item, not one bulk update)?
5. CRAFT - code organization sanity for the size (modules, no dead stubs).
Reply with ONLY a JSON object: {"scores":{"completeness":N,"truthfulness":N,"verification":N,"taskTracking":N,"craft":N},"evidence":{...same keys, one quoted line each...},"verdict":N}`

/** Lenient JSON extraction: strips code fences, then parses the outermost {...} span. */
export function parseJudgeReply(raw) {
  const text = String(raw ?? '').replace(/```(?:json)?/gi, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    if (!parsed || typeof parsed !== 'object' || typeof parsed.verdict !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

/** Build the compact judge prompt from run artifacts (inputs pre-truncated by the caller). */
export function buildJudgePrompt(artifacts) {
  const files = (artifacts.fileListing ?? []).map((f) => `  ${f.name} (${f.bytes}B)`).join('\n')
  const sources = (artifacts.keyFiles ?? [])
    .map((f) => `--- ${f.name} ---\n${String(f.content).slice(0, 4000)}`)
    .join('\n')
  return `You are judging a coding agent's completed task. /no_think

TASK PROMPT: ${artifacts.taskPrompt}

COMPLETION CHECKS: ${JSON.stringify(artifacts.checkResults ?? [])}

AGENT'S FINAL REPORT:
${String(artifacts.finalMessage ?? '(none)').slice(0, 3000)}

FILES PRODUCED:
${files || '(none)'}

KEY SOURCES (truncated):
${sources.slice(0, 8000) || '(none)'}

${JUDGE_RUBRIC}`
}

/** Judge a run. `callLLM(prompt)` is injected (returns the model's raw text reply). */
export async function judgeRun(artifacts, callLLM) {
  const raw = await callLLM(buildJudgePrompt(artifacts))
  const parsed = parseJudgeReply(raw)
  if (parsed) return { scores: parsed.scores ?? {}, evidence: parsed.evidence ?? {}, verdict: parsed.verdict }
  return { scores: {}, evidence: {}, verdict: null, raw: String(raw ?? '').slice(0, 2000) }
}

/** Default LM Studio caller — temperature 0.1, bounded output, honest failure. */
export async function callLmStudio(prompt, baseURL = 'http://localhost:1234/v1') {
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.BENCH_JUDGE_MODEL || 'qwen3.8-27b',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 2000
    })
  })
  if (!res.ok) throw new Error(`judge endpoint ${res.status}`)
  const body = await res.json()
  return body.choices?.[0]?.message?.content ?? ''
}

// CLI: node bench/judge.mjs <history-json-path>  — merges {judge} into the file in place.
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (invokedDirectly && process.argv[2]) {
  const file = process.argv[2]
  const history = JSON.parse(fs.readFileSync(file, 'utf8'))
  const artifacts = history.judgeArtifacts ?? {}
  try {
    history.judge = await judgeRun(artifacts, callLmStudio)
  } catch (e) {
    history.judge = { scores: {}, evidence: {}, verdict: null, error: String(e?.message ?? e) }
  }
  fs.writeFileSync(file, JSON.stringify(history, null, 2), 'utf8')
  console.log(`judge verdict: ${history.judge.verdict ?? 'null (unparseable/error - raw preserved)'}`)
}
