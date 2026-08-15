import { describe, expect, it } from 'vitest'
import { splitToolBatch, MAX_TOOL_BATCH } from './loop'
import { extractTextToolCalls } from './textToolFallback'
import { ToolRegistry } from './registry'
import { z } from 'zod'
import type { ToolDef } from './registry'

describe('splitToolBatch', () => {
  it('passes small batches through untouched', () => {
    const calls = [1, 2, 3]
    expect(splitToolBatch(calls)).toEqual({ execute: [1, 2, 3], deferred: [] })
  })

  it('caps at MAX_TOOL_BATCH preserving emission order on both sides', () => {
    const calls = Array.from({ length: 9 }, (_, i) => i)
    const { execute, deferred } = splitToolBatch(calls)
    expect(execute).toEqual([0, 1, 2, 3, 4, 5])
    expect(deferred).toEqual([6, 7, 8])
    expect(execute.length).toBe(MAX_TOOL_BATCH)
  })
})

describe('multi-call batch parsing (the capability the prompt now teaches)', () => {
  it('parses consecutive <tool_call> blocks in emission order', () => {
    const registry = new ToolRegistry()
    const def: ToolDef<z.ZodType> = {
      name: 'read_file',
      description: 'read',
      schema: z.object({ path: z.string() }),
      mutating: false,
      handler: async () => 'ok'
    }
    registry.register(def)
    const text = [
      '<tool_call>\n<function=read_file><parameter=path>src/a.ts</parameter></function>\n</tool_call>',
      '<tool_call>\n<function=read_file><parameter=path>src/b.ts</parameter></function>\n</tool_call>',
      '<tool_call>\n<function=read_file><parameter=path>src/c.ts</parameter></function>\n</tool_call>'
    ].join('\n')
    const { calls } = extractTextToolCalls(text, registry)
    expect(calls.map((c) => (JSON.parse(c.arguments) as { path: string }).path)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts'
    ])
  })
})
