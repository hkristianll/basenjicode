import os from 'node:os'
import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from './prompt'
import { extractTextToolCalls } from './textToolFallback'
import type { ToolRegistry } from './registry'

// extractTextToolCalls only reads registry.list().map(d => d.name); a minimal stub is enough.
const fakeRegistry = { list: () => [{ name: 'write_file' }, { name: 'edit_file' }] } as unknown as ToolRegistry
const ROOT = os.tmpdir() // a real dir with no nordcode.md / skills, so those sections are empty

describe('buildSystemPrompt — Brooke (manager persona)', () => {
  it('returns the manager contract, not the coding-agent prompt', () => {
    const p = buildSystemPrompt({ workspaceRoot: ROOT, planMode: false, persona: 'manager' })
    expect(p).toContain('You are Brooke')
    expect(p).toContain('MANAGER')
    expect(p).toContain('start_goal')
    expect(p).toContain('do NOT write or edit code')
    // She coordinates, not codes — the coding-agent tool catalog must NOT be present.
    expect(p).not.toContain('edit_file(path, old_string')
  })
  it('the default persona is still the coding agent', () => {
    const p = buildSystemPrompt({ workspaceRoot: ROOT, planMode: false })
    expect(p).toContain('You are a coding agent')
    expect(p).not.toContain('You are Brooke')
  })
})

describe('buildSystemPrompt — single-ticket worker note', () => {
  it('scopes the worker to one ticket + its real tools', () => {
    const p = buildSystemPrompt({ workspaceRoot: ROOT, planMode: false, workerRole: 'implementation' })
    expect(p).toContain('SINGLE-TICKET WORKER')
    expect(p).toContain('IMPLEMENTATION department')
    expect(p).toContain('do not call it') // don't try tools it lacks
  })
  it('review workers get the audit-only contract (run tests, no edits, route via file_finding)', () => {
    const p = buildSystemPrompt({ workspaceRoot: ROOT, planMode: false, workerRole: 'review' })
    expect(p).toContain('As REVIEW you AUDIT')
    expect(p).toContain('file_finding')
    expect(p).toContain('never write/edit/delete')
  })
  it('omits the worker note for a normal (non-board) session', () => {
    expect(buildSystemPrompt({ workspaceRoot: ROOT, planMode: false })).not.toContain('SINGLE-TICKET WORKER')
  })
})

describe('buildSystemPrompt — weak-model feature flags', () => {
  it('preferTextToolCalls block uses the exact XML format the parser accepts (no drift)', () => {
    const p = buildSystemPrompt({ workspaceRoot: ROOT, planMode: false, preferTextToolCalls: true })
    expect(p).toContain('<tool_call>')
    expect(p).toContain('<function=')
    // The literal example in the prompt must parse back to a real call — this is the drift guard. The
    // example is an edit_file call in the Hermes/Qwen XML form; the parser must yield exactly that.
    const { calls } = extractTextToolCalls(p, fakeRegistry)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('edit_file')
    const args = JSON.parse(calls[0].arguments)
    expect(args).toHaveProperty('path')
    expect(args).toHaveProperty('old_string')
    expect(args).toHaveProperty('new_string')
  })

  it('omits the text-tool block by default', () => {
    const p = buildSystemPrompt({ workspaceRoot: ROOT, planMode: false })
    expect(p).not.toContain('TOOL-CALL FORMAT')
  })

  it('reasoningEffort "off" injects the no-think switch; unset adds nothing', () => {
    expect(buildSystemPrompt({ workspaceRoot: ROOT, planMode: false, reasoningEffort: 'off' })).toContain('/no_think')
    expect(buildSystemPrompt({ workspaceRoot: ROOT, planMode: false })).not.toContain('/no_think')
  })
})
