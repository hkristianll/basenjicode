import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { extractTextToolCalls } from './textToolFallback'
import type { ToolRegistry } from './registry'

// Minimal stub with real schemas so XML recovery can distinguish required from empty-args tools.
const registry = {
  list: () => [
    { name: 'read_file', schema: z.object({ path: z.string() }) },
    { name: 'write_file', schema: z.object({ path: z.string(), content: z.string() }) },
    {
      name: 'edit_file',
      schema: z.object({
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
        replace_all: z.boolean().optional()
      })
    },
    { name: 'preview_open', schema: z.object({ url: z.string() }) },
    {
      name: 'typed_tool',
      schema: z.object({ ratio: z.number(), enabled: z.boolean(), missing: z.null() })
    }
  ]
} as unknown as ToolRegistry

describe('extractTextToolCalls', () => {
  it('parses the canonical <tool_call> tag', () => {
    const { calls } = extractTextToolCalls('<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>', registry)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('read_file')
    expect(JSON.parse(calls[0].arguments)).toEqual({ path: 'a.ts' })
  })

  it('accepts the plural <tool_calls> tag', () => {
    const { calls } = extractTextToolCalls('<tool_calls>{"name":"read_file","arguments":{"path":"b.ts"}}</tool_calls>', registry)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('read_file')
  })

  it('tolerates whitespace inside the tags', () => {
    const { calls } = extractTextToolCalls('< tool_call >{"name":"read_file","arguments":{}}< / tool_call >', registry)
    expect(calls).toHaveLength(1)
  })

  it('accepts an array of calls in one block', () => {
    const body = '[{"name":"read_file","arguments":{"path":"a"}},{"name":"write_file","arguments":{"path":"b","content":"x"}}]'
    const { calls } = extractTextToolCalls(`<tool_calls>${body}</tool_calls>`, registry)
    expect(calls.map((c) => c.name)).toEqual(['read_file', 'write_file'])
  })

  it('accepts params as a JSON-form arguments alias', () => {
    const text = '<tool_call>{"name":"read_file","params":{"path":"aliased.ts"}}</tool_call>'
    const { calls } = extractTextToolCalls(text, registry)
    expect(JSON.parse(calls[0].arguments)).toEqual({ path: 'aliased.ts' })
  })

  it('repairs malformed JSON before giving up', () => {
    const text = '<tool_call>{"name":"read_file","arguments":{"path":"fixed.ts",},}</tool_call>'
    const { calls } = extractTextToolCalls(text, registry)
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0].arguments)).toEqual({ path: 'fixed.ts' })
  })

  it('parses a bare ```json fenced block', () => {
    const { calls } = extractTextToolCalls('```json\n{"name":"write_file","arguments":{"path":"c","content":"y"}}\n```', registry)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('write_file')
  })

  it('ignores unknown tool names and plain prose (never fabricates a call)', () => {
    expect(extractTextToolCalls('<tool_call>{"name":"rm_rf","arguments":{}}</tool_call>', registry).calls).toHaveLength(0)
    expect(extractTextToolCalls('I will read_file the config and write_file the result.', registry).calls).toHaveLength(0)
  })

  it('strips formatting blank-lines from the JSON form too (path "\\n…\\n" → clean), not just XML', () => {
    // The model emits valid JSON but wraps each value in newlines — this used to bypass the strip and
    // produce file-not-found. Both paths must clean now.
    const text = '<tool_call>{"name":"edit_file","arguments":{"path":"\\nC:\\\\proj\\\\game.js\\n","old_string":"\\n   a();\\n","new_string":"\\n   b();\\n"}}</tool_call>'
    const args = JSON.parse(extractTextToolCalls(text, registry).calls[0].arguments)
    expect(args.path).toBe('C:\\proj\\game.js')
    expect(args.old_string).toBe('   a();') // 3-space indent preserved, wrapping newlines gone
    expect(args.new_string).toBe('   b();')
  })

  it('strips a matched call from the cleaned text', () => {
    const { cleanedText } = extractTextToolCalls(
      'Done.\n<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>',
      registry
    )
    expect(cleanedText).toBe('Done.')
  })

  it('does NOT also execute a ```json block when a real <tool_call> tag is present (prose false positive)', () => {
    const text =
      '<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>\n' +
      'For reference you could also run:\n```json\n{"name":"write_file","arguments":{"path":"x","content":"y"}}\n```'
    const { calls } = extractTextToolCalls(text, registry)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('read_file')
  })
})

describe('extractTextToolCalls — Hermes/Qwen XML form (<function>/<parameter>)', () => {
  it('parses <function=…><parameter=…> with RAW values (code, quotes, newlines — no escaping)', () => {
    const text =
      '<tool_call>\n<function=edit_file>\n<parameter=path>src/x.ts</parameter>\n' +
      '<parameter=old_string>const a = "1";</parameter>\n' +
      '<parameter=new_string>const a = "1";\nif (b) { c(); }</parameter>\n</function>\n</tool_call>'
    const { calls } = extractTextToolCalls(text, registry)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('edit_file')
    const args = JSON.parse(calls[0].arguments)
    expect(args.path).toBe('src/x.ts')
    expect(args.old_string).toBe('const a = "1";') // quotes preserved verbatim, unescaped in source
    expect(args.new_string).toBe('const a = "1";\nif (b) { c(); }') // embedded newline preserved
  })

  it('accepts the name="…" attribute variant', () => {
    const text =
      '<tool_call><function name="write_file"><parameter name="path">a.ts</parameter>' +
      '<parameter name="content">hello</parameter></function></tool_call>'
    const args = JSON.parse(extractTextToolCalls(text, registry).calls[0].arguments)
    expect(args).toEqual({ path: 'a.ts', content: 'hello' })
  })

  it('accepts an unquoted parameter name attribute', () => {
    const text =
      '<tool_call><function=preview_open><parameter name=url>http://127.0.0.1:8930</parameter></function></tool_call>'
    const args = JSON.parse(extractTextToolCalls(text, registry).calls[0].arguments)
    expect(args).toEqual({ url: 'http://127.0.0.1:8930' })
  })

  it('falls back to bare child tags when a required-args function has no parameter tags', () => {
    const text =
      '<tool_call><function=preview_open><url>http://127.0.0.1:8930/board</url></function></tool_call>'
    const { calls, rawBlocks } = extractTextToolCalls(text, registry)
    expect(JSON.parse(calls[0].arguments)).toEqual({ url: 'http://127.0.0.1:8930/board' })
    expect(rawBlocks[calls[0].id]).toBe(text)
  })

  it('coerces booleans/integers but keeps code strings raw', () => {
    const text =
      '<tool_call><function=edit_file><parameter=path>a</parameter>' +
      '<parameter=old_string>x</parameter><parameter=new_string>y</parameter>' +
      '<parameter=replace_all>true</parameter></function></tool_call>'
    const args = JSON.parse(extractTextToolCalls(text, registry).calls[0].arguments)
    expect(args.replace_all).toBe(true) // real boolean, not "true"
    expect(args.old_string).toBe('x')
  })

  it('coerces floats and Python True/False/None literals', () => {
    const text =
      '<tool_call><function=typed_tool><parameter=ratio>-1.25</parameter>' +
      '<parameter=enabled>True</parameter><parameter=missing>None</parameter></function></tool_call>'
    const args = JSON.parse(extractTextToolCalls(text, registry).calls[0].arguments)
    expect(args).toEqual({ ratio: -1.25, enabled: true, missing: null })

    const falseText =
      '<tool_call><function=typed_tool><parameter=ratio>2</parameter>' +
      '<parameter=enabled>False</parameter><parameter=missing>None</parameter></function></tool_call>'
    expect(JSON.parse(extractTextToolCalls(falseText, registry).calls[0].arguments).enabled).toBe(false)
  })

  it('leaves a zero-param required function as text instead of emitting an empty call', () => {
    const text = '<tool_call><function=read_file></function></tool_call>'
    const { calls, cleanedText } = extractTextToolCalls(text, registry)
    expect(calls).toHaveLength(0)
    expect(cleanedText).toBe(text)
  })

  it('parses the XML form even without a <tool_call> wrapper', () => {
    const text = 'Sure.\n<function=read_file><parameter=path>z.ts</parameter></function>'
    const { calls, cleanedText } = extractTextToolCalls(text, registry)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('read_file')
    expect(cleanedText).toBe('Sure.')
  })

  it('ignores an unknown function name', () => {
    const text = '<tool_call><function=rm_rf><parameter=path>/</parameter></function></tool_call>'
    expect(extractTextToolCalls(text, registry).calls).toHaveLength(0)
  })

  it('strips the formatting blank-lines that wrap a value (the real bug: path "\\n…\\n" → file-not-found)', () => {
    // The model puts each value on its own line(s); keeping those newlines poisoned scalar args.
    const text =
      '<tool_call><function=read_file>\n<parameter=path>\n\nC:\\proj\\game.js\n\n\n</parameter>\n</function></tool_call>'
    const args = JSON.parse(extractTextToolCalls(text, registry).calls[0].arguments)
    expect(args.path).toBe('C:\\proj\\game.js') // all leading/trailing blank lines gone, no spaces
  })

  it('preserves the first content line indentation and internal newlines (edit old_string must match exactly)', () => {
    const text =
      '<tool_call><function=edit_file>' +
      '<parameter=path>\na.ts\n</parameter>' +
      '<parameter=old_string>\n      if (placed) break;\n    }\n\n</parameter>' +
      '<parameter=new_string>\n      done();\n</parameter>' +
      '</function></tool_call>'
    const args = JSON.parse(extractTextToolCalls(text, registry).calls[0].arguments)
    expect(args.path).toBe('a.ts')
    expect(args.old_string).toBe('      if (placed) break;\n    }') // 6-space indent + internal newline kept; blank lines stripped
    expect(args.new_string).toBe('      done();')
  })
})
