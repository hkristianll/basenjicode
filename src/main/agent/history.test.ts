import { describe, it, expect } from 'vitest'
import {
  repairTranscript,
  trimHistory,
  calibrateScale,
  estimateTokens,
  estimateToolsTokens,
  dedupeReads,
  countSendableComposition
} from './history'
import type { ChatMessage } from '../../shared/domain-types'

describe('dedupeReads', () => {
  const big = (s: string): string => s.repeat(50) // >200 chars so it's worth stubbing

  const readCall = (id: string, path: string): ChatMessage => ({
    role: 'assistant',
    content: null,
    toolCalls: [{ id, name: 'read_file', arguments: JSON.stringify({ path }) }]
  })

  it('collapses earlier identical reads to a stub, keeps the latest intact', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      readCall('c1', 'a.ts'),
      { role: 'tool', toolCallId: 'c1', content: big('FIRST READ ') },
      readCall('c2', 'a.ts'),
      { role: 'tool', toolCallId: 'c2', content: big('LATEST READ ') }
    ]
    const result = dedupeReads(msgs)
    expect(result.stubbed).toBe(1)
    expect(result.savedChars).toBe(big('FIRST READ ').length - (msgs[3].content?.length ?? 0))
    expect(msgs[3].content).toMatch(/superseded by the latest/)
    expect(msgs[5].content).toBe(big('LATEST READ ')) // newest copy untouched
  })

  it('does not touch reads of DIFFERENT files', () => {
    const msgs: ChatMessage[] = [
      readCall('c1', 'a.ts'),
      { role: 'tool', toolCallId: 'c1', content: big('A ') },
      readCall('c2', 'b.ts'),
      { role: 'tool', toolCallId: 'c2', content: big('B ') }
    ]
    expect(dedupeReads(msgs)).toEqual({ stubbed: 0, savedChars: 0 })
  })

  it('ignores non-dedup tools (e.g. run_shell) and small outputs', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: null, toolCalls: [{ id: 's1', name: 'run_shell', arguments: '{"command":"ls"}' }] },
      { role: 'tool', toolCallId: 's1', content: big('shell out ') },
      { role: 'assistant', content: null, toolCalls: [{ id: 's2', name: 'run_shell', arguments: '{"command":"ls"}' }] },
      { role: 'tool', toolCallId: 's2', content: big('shell out ') },
      readCall('c1', 'tiny.ts'),
      { role: 'tool', toolCallId: 'c1', content: 'small' },
      readCall('c2', 'tiny.ts'),
      { role: 'tool', toolCallId: 'c2', content: 'small' }
    ]
    expect(dedupeReads(msgs)).toEqual({ stubbed: 0, savedChars: 0 }) // run_shell not eligible; tiny reads under the size floor
  })
})

describe('countSendableComposition', () => {
  it('reports dedupe savings plus final message and image payload counts', () => {
    const oldRead = 'x'.repeat(300)
    const image = 'data:image/png;base64,AAAA'
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'go', images: [image, 'ø'] },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }]
      },
      { role: 'tool', toolCallId: 'c1', content: oldRead },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c2', name: 'read_file', arguments: '{"path":"a.ts"}' }]
      },
      { role: 'tool', toolCallId: 'c2', content: 'latest'.repeat(50) }
    ]
    const dedupe = dedupeReads(msgs)

    expect(countSendableComposition(msgs, { dedupeSavedChars: dedupe.savedChars, trimmedMsgs: 2, toolsTokens: 17 })).toEqual({
      sendableMsgs: 5,
      dedupeSavedChars: oldRead.length - (msgs[2].content?.length ?? 0),
      trimmedMsgs: 2,
      imageCount: 2,
      imageBytes: Buffer.byteLength(image, 'utf8') + Buffer.byteLength('ø', 'utf8'),
      toolsTokens: 17
    })
  })
})

describe('repairTranscript', () => {
  it('stubs an unanswered tool_call (cancel mid-batch)', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'a', name: 'x', arguments: '{}' },
          { id: 'b', name: 'y', arguments: '{}' }
        ]
      },
      { role: 'tool', toolCallId: 'a', content: 'ok' },
      { role: 'user', content: 'next' }
    ]
    const out = repairTranscript(msgs)
    const toolMsgs = out.filter((m) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(2)
    expect(toolMsgs.some((m) => m.toolCallId === 'b')).toBe(true)
    expect(out[out.length - 1].content).toBe('next')
  })

  it('leaves a complete transcript unchanged', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: null, toolCalls: [{ id: 'a', name: 'x', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'a', content: 'ok' }
    ]
    expect(repairTranscript(msgs)).toHaveLength(2)
  })

  it('leaves a plain conversation unchanged', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ]
    expect(repairTranscript(msgs)).toHaveLength(2)
  })

  it('drops an orphan tool message (no preceding assistant tool_calls) that would 400 the request', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', toolCallId: 'ghost', content: 'orphan output' }, // no assistant tool_calls before it
      { role: 'assistant', content: 'ok' }
    ]
    const out = repairTranscript(msgs)
    expect(out.some((m) => m.role === 'tool')).toBe(false)
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('repairs only the incomplete batch when there are several', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: null, toolCalls: [{ id: 'a', name: 'x', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'a', content: 'ok' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'b', name: 'y', arguments: '{}' },
          { id: 'c', name: 'z', arguments: '{}' }
        ]
      },
      { role: 'tool', toolCallId: 'b', content: 'ok' }
    ]
    const out = repairTranscript(msgs)
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(3)
    expect(out.some((m) => m.role === 'tool' && m.toolCallId === 'c')).toBe(true)
  })
})

describe('trimHistory', () => {
  it('keeps the system prompt and last user message while dropping old turns', () => {
    const big = 'x'.repeat(4000)
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: big },
      { role: 'assistant', content: big },
      { role: 'user', content: 'latest' }
    ]
    trimHistory(msgs, 3000, 100) // budget = 3000 - 100 - 2000 = 900 tokens, content ~2000
    expect(msgs[0].role).toBe('system')
    expect(msgs[msgs.length - 1].content).toBe('latest')
    expect(msgs.length).toBeLessThan(4)
  })

  it('does nothing when within budget', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' }
    ]
    expect(trimHistory(msgs, 100000, 1000)).toBe(0)
    expect(msgs).toHaveLength(2)
  })

  it('trims more aggressively as the scale rises (real tokenizer denser than chars/4)', () => {
    const A = 'a'.repeat(8000)
    const mk = (): ChatMessage[] => [
      { role: 'system', content: 'sys' },
      { role: 'user', content: A },
      { role: 'assistant', content: 'b'.repeat(8000) },
      { role: 'user', content: 'c'.repeat(4000) },
      { role: 'user', content: 'latest' }
    ]
    // budget = 12000 - 0 - 2000 = 10000; raw estimate ~5000 tokens.
    const lo = mk()
    expect(trimHistory(lo, 12000, 0, 1)).toBe(0) // fits at chars/4
    expect(lo.some((m) => m.content === A)).toBe(true)

    const hi = mk()
    expect(trimHistory(hi, 12000, 0, 2)).toBeGreaterThan(0) // a denser tokenizer forces a drop
    expect(hi.some((m) => m.content === A)).toBe(false)
    expect(hi[0].content).toBe('sys')
    expect(hi[hi.length - 1].content).toBe('latest')
  })

  it('keeps the first non-system message a user turn after trimming (qwen template needs it)', () => {
    const big = 'x'.repeat(8000)
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: `old question ${big}` },
      { role: 'assistant', content: null, toolCalls: [{ id: 'a', name: 'grep', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'a', content: big },
      { role: 'user', content: 'continue working' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'b', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'b', content: 'file body' }
    ]
    trimHistory(msgs, 4000, 100, 1.4) // force heavy trimming
    const firstReal = msgs.find((m) => m.role !== 'system')
    expect(firstReal?.role).toBe('user') // never an orphaned assistant/tool at the front
  })

  it('drops leading orphaned assistant/tool even without trimming', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'orphan' },
      { role: 'user', content: 'hello' }
    ]
    trimHistory(msgs, 100000, 1000) // within budget, but front is an assistant
    const firstReal = msgs.find((m) => m.role !== 'system')
    expect(firstReal?.role).toBe('user')
  })

  it('stubs old tool outputs that accumulate after the last user turn (in-turn compaction)', () => {
    const bigOut = 'z'.repeat(20000)
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do a big task' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'a', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'a', content: bigOut }, // old, big
      { role: 'assistant', content: null, toolCalls: [{ id: 'b', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'b', content: bigOut }, // old, big
      { role: 'assistant', content: null, toolCalls: [{ id: 'c', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c', content: 'recent small output' } // recent — must survive
    ]
    trimHistory(msgs, 6000, 100, 1.4) // budget ~3900; the big outputs can't be dropped (all after last user)
    expect(msgs.find((m) => m.role === 'user')?.content).toBe('do a big task') // task preserved
    const toolContents = msgs.filter((m) => m.role === 'tool').map((m) => m.content)
    expect(toolContents.some((c) => c?.includes('trimmed to fit'))).toBe(true) // oldest stubbed
    expect(toolContents).toContain('recent small output') // most recent kept intact
    expect(estimateTokens(msgs) * 1.4).toBeLessThanOrEqual(6000 - 100 - 2000) // and it now fits
  })

  it('truncates an oversized last user message that alone blows the budget (RC3)', () => {
    const huge = 'q'.repeat(400000)
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: huge }
    ]
    const budget = 50000 - 4096 - 2000
    trimHistory(msgs, 50000, 4096, 1.4)
    expect(msgs).toHaveLength(2) // can't drop the protected pair...
    const last = msgs[1].content as string
    expect(last.length).toBeLessThan(huge.length) // ...so it shrinks the message instead
    expect(estimateTokens(msgs) * 1.4).toBeLessThanOrEqual(budget) // and now it fits
  })
})

describe('context-overflow invariant (the reported bug)', () => {
  // Reproduces the failure: a code-dense transcript whose REAL tokens run ~33% over the chars/4
  // estimate. Before the fix, trimHistory trimmed to the estimate and the real payload blew past
  // the cap (the screenshot's 259k used / 200k limit). The calibrated scale must prevent that.
  it('keeps the real payload under the cap with output headroom, every turn', () => {
    const RATIO = 1.33 // real prompt_tokens per estimated token for code/JSON
    const CAP = 200000
    const RESERVE = 4096
    const mk = (): ChatMessage[] => {
      const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }]
      for (let i = 0; i < 200; i++) {
        msgs.push({ role: 'user', content: 'x'.repeat(3000) })
        msgs.push({ role: 'assistant', content: 'y'.repeat(3000) })
      }
      msgs.push({ role: 'user', content: 'latest' })
      return msgs
    }
    let scale = 1.4
    for (let turn = 0; turn < 4; turn++) {
      const sendable = mk()
      trimHistory(sendable, CAP, RESERVE, scale)
      const est = estimateTokens(sendable)
      const real = Math.round(est * RATIO) // what LM Studio would actually report
      // The real payload must fit the window AND leave room for the model's output.
      expect(real).toBeLessThanOrEqual(CAP - RESERVE)
      scale = calibrateScale(scale, est, real)
    }
  })
})

describe('estimateTokens with images', () => {
  it('charges attached images so vision turns count against the budget', () => {
    const base: ChatMessage[] = [{ role: 'user', content: 'describe this' }]
    const withImg: ChatMessage[] = [{ role: 'user', content: 'describe this', images: ['data:image/png;base64,AAAA'] }]
    expect(estimateTokens(withImg)).toBeGreaterThan(estimateTokens(base) + 1000)
  })
})

describe('estimateToolsTokens', () => {
  it('is zero for no tools', () => {
    expect(estimateToolsTokens([])).toBe(0)
  })
  it('counts names, descriptions, and serialized schemas (the per-request payload the budget missed)', () => {
    const tools = [
      { function: { name: 'read_file', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }
    ]
    // Real, non-trivial overhead — the whole point is that this used to be invisible to the budget.
    expect(estimateToolsTokens(tools)).toBeGreaterThan(15)
  })
  it('grows with more tools', () => {
    const one = [{ function: { name: 'a', description: 'x', parameters: {} } }]
    const two = [...one, { function: { name: 'b', description: 'y', parameters: {} } }]
    expect(estimateToolsTokens(two)).toBeGreaterThan(estimateToolsTokens(one))
  })
})

describe('calibrateScale', () => {
  it('ratchets up to the observed ratio plus a 10% safety margin', () => {
    expect(calibrateScale(1.4, 1000, 2000)).toBeCloseTo(2.2, 5) // (2000/1000) * 1.1
  })
  it('decays gently (not hard-pinned) when observed runs below the previous scale', () => {
    // Old behavior pinned at prev forever; now a one-off spike can relax ~2%/turn so it isn't permanent.
    expect(calibrateScale(2.0, 1000, 1000)).toBeCloseTo(1.96, 2) // 2.0 * 0.98
  })
  it('rejects a single-turn anomaly instead of ratcheting to the 4x ceiling', () => {
    // A giant one-off prompt (observed ~110x) must not bake in a permanent 4x scale; cap the jump at 2x.
    expect(calibrateScale(1.4, 1000, 100000)).toBeCloseTo(2.8, 5) // min(110, 1.4*2)
  })
  it('ignores degenerate inputs', () => {
    expect(calibrateScale(1.7, 0, 5000)).toBe(1.7)
    expect(calibrateScale(1.7, 1000, 0)).toBe(1.7)
  })
})
