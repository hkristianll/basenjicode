import fs from 'node:fs'
import path from 'node:path'

/**
 * Per-MODEL capability profiles (Phase 1-pre). Connection flags describe what the USER wants;
 * the profile describes what the MODEL can do — so a model swap on the same connection stops
 * inheriting stale mechanics (the qwen3.6 /no_think config silently no-opping on qwen3.8 was
 * the motivating incident, 2026-08-14).
 *
 * Three layers, strongest first: explicit per-connection user value > LEARNED overlay (facts the
 * harness observed at runtime, persisted to userData/modelProfiles.json) > SEEDED registry
 * (pattern-matched known families) > fallback.
 */
export interface ModelProfile {
  thinking: 'always' | 'controllable' | 'none'
  noThinkHonored: boolean
  toolCallChannel: 'text' | 'native'
  /** Absent for non-thinking models where effort is meaningless. */
  defaultEffort?: 'off' | 'low' | 'medium' | 'high'
  provenance: 'seeded' | 'learned' | 'fallback'
}

/** Facts the harness can learn about a model at runtime. Booleans ratchet one way — a fact is
 *  recorded once and never flaps (a single clean observation beats re-litigating every session). */
export interface LearnedFacts {
  noThinkIgnored?: { recordedAt: string }
  textToolCalls?: { recordedAt: string }
}

// Ordered — first match wins. Patterns are lowercase substrings of the model id.
const SEEDS: { pattern: RegExp; profile: Omit<ModelProfile, 'provenance'> }[] = [
  // qwen3.8: live-probed 2026-08-15 — ignores /no_think AND chat_template_kwargs enable_thinking;
  // native tool-call args arrive empty (text recovery carries 100% of turns). Effort 'high'
  // (= unsuppressed) preserves observed behavior until the user flips the dial.
  { pattern: /qwen3\.8/, profile: { thinking: 'always', noThinkHonored: false, toolCallChannel: 'text', defaultEffort: 'high' } },
  // qwen3.6 family honored /no_think in the 2026-06/07 runs.
  { pattern: /qwen3\.6/, profile: { thinking: 'always', noThinkHonored: true, toolCallChannel: 'text', defaultEffort: 'off' } },
  // agentworld: native tool calls with real args live-validated (reviews/PLANNER-VALIDATION.md).
  { pattern: /agentworld/, profile: { thinking: 'always', noThinkHonored: true, toolCallChannel: 'native', defaultEffort: 'off' } },
  // Non-thinking coder/instruct families: no reasoning channel, effort meaningless.
  { pattern: /coder|instruct/, profile: { thinking: 'none', noThinkHonored: true, toolCallChannel: 'text' } }
]

const FALLBACK: Omit<ModelProfile, 'provenance'> = {
  thinking: 'always',
  noThinkHonored: false,
  toolCallChannel: 'text',
  defaultEffort: 'high'
}

// ---------- learned overlay (persisted) ----------

let learnedDir: string | null = null
let learnedCache: Record<string, LearnedFacts> | null = null

function learnedFile(): string | null {
  return learnedDir ? path.join(learnedDir, 'modelProfiles.json') : null
}

/** Point the learned store at a writable dir (userData). Before init, learning is a no-op and
 *  resolution uses seeds only — keeps unit tests and headless callers free of electron. */
export function initModelProfiles(dir: string): void {
  learnedDir = dir
  learnedCache = null
}

function loadLearned(): Record<string, LearnedFacts> {
  if (learnedCache) return learnedCache
  const file = learnedFile()
  if (!file) return {}
  try {
    learnedCache = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, LearnedFacts>
  } catch {
    learnedCache = {}
  }
  return learnedCache
}

/** Record a runtime observation. Ratchet: writes at most once per (model, fact). */
export function recordLearnedFact(modelId: string, fact: keyof LearnedFacts): void {
  const file = learnedFile()
  if (!file || !modelId) return
  const all = loadLearned()
  const entry = (all[modelId] ??= {})
  if (entry[fact]) return
  entry[fact] = { recordedAt: new Date().toISOString().slice(0, 10) }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(all, null, 2), 'utf8')
  } catch {
    /* learning must never break a run */
  }
}

export function getLearnedFacts(modelId: string): LearnedFacts {
  return loadLearned()[modelId] ?? {}
}

// ---------- resolution ----------

export function seededProfile(modelId: string): ModelProfile {
  const id = (modelId ?? '').toLowerCase()
  for (const seed of SEEDS) {
    if (seed.pattern.test(id)) return { ...seed.profile, provenance: 'seeded' }
  }
  return { ...FALLBACK, provenance: 'fallback' }
}

/** Seeded profile with the learned overlay applied. */
export function resolveProfile(modelId: string): ModelProfile {
  const base = seededProfile(modelId)
  const learned = getLearnedFacts(modelId)
  let out = base
  if (learned.noThinkIgnored && base.noThinkHonored) {
    out = { ...out, noThinkHonored: false, provenance: 'learned' }
  }
  if (learned.textToolCalls && base.toolCallChannel !== 'text') {
    out = { ...out, toolCallChannel: 'text', provenance: 'learned' }
  }
  return out
}

/**
 * The two connection defaults buildAgentConfig previously derived from `local ? …` — now derived
 * from the model's profile. Explicit per-connection user values always win (passed by the
 * caller); NON-local connections keep today's undefined defaults so cloud behavior is untouched.
 */
export function resolveConnectionDefaults(
  modelId: string,
  local: boolean
): { preferTextToolCalls: boolean | undefined; reasoningEffort: 'off' | 'low' | 'medium' | 'high' | undefined } {
  if (!local) return { preferTextToolCalls: undefined, reasoningEffort: undefined }
  const p = resolveProfile(modelId)
  return {
    preferTextToolCalls: p.toolCallChannel === 'text' ? true : undefined,
    reasoningEffort: p.thinking === 'none' ? undefined : p.defaultEffort
  }
}

/** One-line human description for the Settings UI. */
export function describeProfile(modelId: string): string {
  const p = resolveProfile(modelId)
  const channel = p.toolCallChannel === 'text' ? 'text tool-calls' : 'native tool-calls'
  const think =
    p.thinking === 'none' ? 'non-thinking' : p.noThinkHonored ? 'thinking suppressible' : 'thinking always on'
  const learned = getLearnedFacts(modelId)
  const learnedNote = Object.values(learned)
    .map((f) => f.recordedAt)
    .sort()[0]
  return `Profile: ${channel} · ${think} (${p.provenance}${learnedNote ? ` ${learnedNote}` : ''})`
}
