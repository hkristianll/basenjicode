import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  initModelProfiles,
  recordLearnedFact,
  getLearnedFacts,
  seededProfile,
  resolveProfile,
  resolveConnectionDefaults,
  describeProfile
} from './modelProfiles'

const DIR = path.join(os.tmpdir(), 'basenjicode-model-profiles-test')

beforeEach(() => {
  fs.rmSync(DIR, { recursive: true, force: true })
  initModelProfiles(DIR)
})

describe('seeded pattern matching', () => {
  it('matches known families case-insensitively and falls back safely', () => {
    expect(seededProfile('qwen3.8-27b')).toMatchObject({ noThinkHonored: false, toolCallChannel: 'text', defaultEffort: 'high', provenance: 'seeded' })
    expect(seededProfile('Qwen3.6-27B-MTP')).toMatchObject({ noThinkHonored: true, defaultEffort: 'off' })
    expect(seededProfile('qwen-agentworld-35b-a3b')).toMatchObject({ toolCallChannel: 'native' })
    expect(seededProfile('Qwen3-Coder-Next')).toMatchObject({ thinking: 'none' })
    expect(seededProfile('some-unknown-model')).toMatchObject({ provenance: 'fallback', toolCallChannel: 'text', noThinkHonored: false })
  })
})

describe('resolution order: learned overlays seeded', () => {
  it('learned facts flip honored/native seeds and mark provenance', () => {
    recordLearnedFact('qwen-agentworld-35b-a3b', 'textToolCalls')
    recordLearnedFact('mystery-thinker', 'noThinkIgnored')
    expect(resolveProfile('qwen-agentworld-35b-a3b')).toMatchObject({ toolCallChannel: 'text', provenance: 'learned' })
    // fallback already has noThinkHonored:false — learned fact is absorbed without a flap
    expect(resolveProfile('mystery-thinker').noThinkHonored).toBe(false)
    // an untouched model stays seeded
    expect(resolveProfile('qwen3.6-27b').provenance).toBe('seeded')
  })
})

describe('learned ratchet', () => {
  it('records a fact exactly once and survives reload', () => {
    recordLearnedFact('qwen3.9-test', 'noThinkIgnored')
    const first = getLearnedFacts('qwen3.9-test').noThinkIgnored
    recordLearnedFact('qwen3.9-test', 'noThinkIgnored')
    expect(getLearnedFacts('qwen3.9-test').noThinkIgnored).toEqual(first)
    initModelProfiles(DIR) // simulate app restart — cache dropped, file reloaded
    expect(getLearnedFacts('qwen3.9-test').noThinkIgnored).toEqual(first)
  })

  it('is a no-op before init (headless/test callers without electron)', () => {
    initModelProfiles(DIR)
    ;(initModelProfiles as unknown as (d: string | null) => void)(null as unknown as string)
    expect(() => recordLearnedFact('x', 'noThinkIgnored')).not.toThrow()
  })
})

describe('connection-default resolution (the buildAgentConfig seam)', () => {
  it('qwen3.8 no-change guarantee: text channel, thinking unsuppressed', () => {
    expect(resolveConnectionDefaults('qwen3.8-27b', true)).toEqual({ preferTextToolCalls: true, reasoningEffort: 'high' })
  })
  it('qwen3.6 keeps its historical suppressed default', () => {
    expect(resolveConnectionDefaults('qwen3.6-27b-mtp', true)).toEqual({ preferTextToolCalls: true, reasoningEffort: 'off' })
  })
  it('non-local connections keep undefined defaults (cloud untouched)', () => {
    expect(resolveConnectionDefaults('claude-opus-4-8', false)).toEqual({ preferTextToolCalls: undefined, reasoningEffort: undefined })
  })
  it('non-thinking models get no effort default', () => {
    expect(resolveConnectionDefaults('Qwen3-Coder-Next', true).reasoningEffort).toBeUndefined()
  })
})

describe('describeProfile', () => {
  it('renders channel, thinking mode, and provenance with learned date', () => {
    expect(describeProfile('qwen3.8-27b')).toContain('text tool-calls')
    expect(describeProfile('qwen3.8-27b')).toContain('thinking always on')
    recordLearnedFact('qwen-agentworld-35b-a3b', 'textToolCalls')
    const s = describeProfile('qwen-agentworld-35b-a3b')
    expect(s).toContain('learned')
  })
})
