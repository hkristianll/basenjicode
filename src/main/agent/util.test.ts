import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { todoWriteTool } from './tools/todo'
import { multiEditTool } from './tools/multiEdit'
import { argsAreEmpty, argPath, repairJsonArgs, repairArgsToSchema, sanitizeToolArgs } from './util'

describe('argsAreEmpty', () => {
  it('treats missing / empty-object args as empty', () => {
    expect(argsAreEmpty('')).toBe(true)
    expect(argsAreEmpty('{}')).toBe(true)
    expect(argsAreEmpty('  {}  ')).toBe(true)
  })
  it('treats a hollow object (all null/empty values) as empty — the Qwen failure mode', () => {
    expect(argsAreEmpty('{"path":null,"old_string":null,"new_string":null}')).toBe(true)
    expect(argsAreEmpty('{"path":""}')).toBe(true)
  })
  it('treats a real object as non-empty', () => {
    expect(argsAreEmpty('{"path":"src/a.ts"}')).toBe(false)
    expect(argsAreEmpty('{"path":null,"old_string":"x"}')).toBe(false)
  })
  it('treats unparseable-but-non-empty as non-empty (let schema report it)', () => {
    expect(argsAreEmpty('{"path":')).toBe(false)
  })
})

describe('argPath', () => {
  it('extracts a string path', () => {
    expect(argPath('{"path":"src/a.ts","old_string":"x"}')).toBe('src/a.ts')
  })
  it('returns null when absent, non-string, or unparseable', () => {
    expect(argPath('{"old_string":"x"}')).toBeNull()
    expect(argPath('{"path":123}')).toBeNull()
    expect(argPath('not json')).toBeNull()
  })
})

describe('repairJsonArgs', () => {
  it('passes through valid JSON', () => {
    expect(repairJsonArgs('{"path":"a.ts"}')).toEqual({ path: 'a.ts' })
  })
  it('closes an unterminated string + brace (streamed-truncated)', () => {
    expect(repairJsonArgs('{"path":"src/a.ts","old_string":"foo')).toEqual({
      path: 'src/a.ts',
      old_string: 'foo'
    })
  })
  it('strips a trailing comma', () => {
    expect(repairJsonArgs('{"path":"a.ts",}')).toEqual({ path: 'a.ts' })
  })
  it('escapes raw control chars inside strings (the #1 local-model / llama.cpp case)', () => {
    // A literal newline + tab inside a string value — standard JSON.parse rejects these.
    expect(repairJsonArgs('{"content":"line1\nline2\ttabbed"}')).toEqual({
      content: 'line1\nline2\ttabbed'
    })
  })
  it('trims excess closing braces', () => {
    expect(repairJsonArgs('{"path":"a.ts"}}}')).toEqual({ path: 'a.ts' })
  })
  it('repairs control chars combined with a trailing comma', () => {
    expect(repairJsonArgs('{"a":"x\ny",}')).toEqual({ a: 'x\ny' })
  })
  it('returns null when it cannot be made into an object', () => {
    expect(repairJsonArgs('')).toBeNull()
    expect(repairJsonArgs('[1,2,3]')).toBeNull()
    expect(repairJsonArgs('garbage ((')).toBeNull()
  })
})

describe('repairArgsToSchema', () => {
  it('recovers qwen stringified todo_write.todos without mutating the original args', () => {
    const todos = '[{"content":"x","status":"pending"}]'
    const args = { todos }
    const first = todoWriteTool.schema.safeParse(args)
    expect(first.success).toBe(false)
    if (first.success) throw new Error('expected todo validation to fail')

    const repaired = repairArgsToSchema(args, first.error)

    expect(todoWriteTool.schema.safeParse(repaired).success).toBe(true)
    expect(repaired).toEqual({ todos: [{ content: 'x', status: 'pending' }] })
    expect(args).toEqual({ todos })
  })

  it('recovers multi_edit.edits plus numeric, boolean, and object strings at failing paths', () => {
    const edits = '[{"old_string":"before","new_string":"after"}]'
    const multiArgs = { path: 'src/a.ts', edits }
    const multiFirst = multiEditTool.schema.safeParse(multiArgs)
    expect(multiFirst.success).toBe(false)
    if (multiFirst.success) throw new Error('expected multi-edit validation to fail')
    expect(multiEditTool.schema.safeParse(repairArgsToSchema(multiArgs, multiFirst.error)).success).toBe(true)

    const schema = z.object({ count: z.number(), enabled: z.boolean(), config: z.object({ mode: z.string() }) })
    const args = { count: '12.5', enabled: 'False', config: '{"mode":"safe"}' }
    const first = schema.safeParse(args)
    expect(first.success).toBe(false)
    if (first.success) throw new Error('expected primitive validation to fail')
    expect(repairArgsToSchema(args, first.error)).toEqual({
      count: 12.5,
      enabled: false,
      config: { mode: 'safe' }
    })
  })

  it('does not reinterpret valid string fields even when their contents look like JSON', () => {
    const schema = z.object({ old_string: z.string(), count: z.number() })
    const args = { old_string: '{"keep":"this exact string"}', count: '7' }
    const first = schema.safeParse(args)
    expect(first.success).toBe(false)
    if (first.success) throw new Error('expected numeric validation to fail')

    expect(repairArgsToSchema(args, first.error)).toEqual({
      old_string: '{"keep":"this exact string"}',
      count: 7
    })
  })
})

describe('sanitizeToolArgs', () => {
  it('passes valid JSON through unchanged', () => {
    expect(sanitizeToolArgs('{"path":"a.ts"}')).toBe('{"path":"a.ts"}')
  })
  it('maps empty / whitespace / None / null to an empty object (Hermes last-resort)', () => {
    expect(sanitizeToolArgs('')).toBe('{}')
    expect(sanitizeToolArgs('   ')).toBe('{}')
    expect(sanitizeToolArgs(null)).toBe('{}')
    expect(sanitizeToolArgs(undefined)).toBe('{}')
    expect(sanitizeToolArgs('None')).toBe('{}')
    expect(sanitizeToolArgs('null')).toBe('{}')
  })
  it('repairs malformed args into valid JSON', () => {
    expect(JSON.parse(sanitizeToolArgs('{"path":"a.ts","old":"foo'))).toEqual({
      path: 'a.ts',
      old: 'foo'
    })
    expect(JSON.parse(sanitizeToolArgs('{"a":"x\ny",}'))).toEqual({ a: 'x\ny' })
  })
  it('falls back to {} for unrepairable junk rather than throwing', () => {
    expect(sanitizeToolArgs('garbage ((')).toBe('{}')
  })
})
