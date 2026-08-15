import { describe, it, expect } from 'vitest'
import { sanitizeLabel, sanitizeToolName, toolName, flattenToolResult } from './translate'

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

describe('sanitizeLabel', () => {
  it('keeps identifier-ish labels unchanged', () => {
    expect(sanitizeLabel('board')).toBe('board')
    expect(sanitizeLabel('my_server2')).toBe('my_server2')
  })
  it('collapses runs of non-identifier chars to a single underscore', () => {
    expect(sanitizeLabel('my server')).toBe('my_server')
    expect(sanitizeLabel('a.b-c/d')).toBe('a_b_c_d')
  })
  it('trims leading/trailing underscores and whitespace', () => {
    expect(sanitizeLabel('  weird!!  ')).toBe('weird')
    expect(sanitizeLabel('--x--')).toBe('x')
  })
  it('falls back to "mcp" when nothing usable remains', () => {
    expect(sanitizeLabel('!!!')).toBe('mcp')
    expect(sanitizeLabel('')).toBe('mcp')
  })
})

describe('sanitizeToolName', () => {
  it('replaces chars outside the function-name contract', () => {
    expect(sanitizeToolName('add ticket')).toBe('add_ticket')
    expect(sanitizeToolName('get/status')).toBe('get_status')
    expect(sanitizeToolName('tool.name')).toBe('tool_name')
  })
  it('keeps already-valid names (underscores and hyphens allowed)', () => {
    expect(sanitizeToolName('add_ticket')).toBe('add_ticket')
    expect(sanitizeToolName('list-all')).toBe('list-all')
  })
  it('falls back to "tool" when nothing usable remains', () => {
    expect(sanitizeToolName('🚀')).toBe('tool')
  })
})

describe('toolName', () => {
  it('namespaces a tool under the sanitized label and name', () => {
    expect(toolName('board', 'add_ticket')).toBe('board__add_ticket')
    expect(toolName('My Server', 'list')).toBe('My_Server__list')
  })
  it('produces a contract-valid name even from hostile upstream names', () => {
    for (const [label, name] of [
      ['board', 'add ticket'],
      ['board', 'get/status'],
      ['board', 'tool.name'],
      ['weird srv!', 'emoji🚀'],
      ['x', 'y'.repeat(80)]
    ] as const) {
      expect(toolName(label, name)).toMatch(NAME_RE)
    }
  })
})

describe('flattenToolResult', () => {
  it('joins text content blocks with newlines', () => {
    expect(
      flattenToolResult({
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' }
        ]
      })
    ).toBe('a\nb')
  })
  it('notes non-text blocks by their kind', () => {
    expect(flattenToolResult({ content: [{ type: 'image' }] })).toBe('[image]')
  })
  it('prefixes ERROR when the result is an error', () => {
    expect(flattenToolResult({ content: [{ type: 'text', text: 'boom' }], isError: true })).toBe('ERROR: boom')
  })
  it('handles empty / missing content', () => {
    expect(flattenToolResult({})).toBe('(no output)')
    expect(flattenToolResult({ content: [] })).toBe('(no output)')
    expect(flattenToolResult({ isError: true })).toBe('ERROR: tool reported an error')
  })
})
