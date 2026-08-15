import { describe, it, expect } from 'vitest'
import { isPrematureStop, continuationNudge, isThinkingOnly, looksLikeTruncatedToolCall } from './completion'

describe('isPrematureStop — auto-continue detection', () => {
  it('treats truncated (finish_reason=length) output as unfinished', () => {
    expect(isPrematureStop('partial work', 'length', 0)).toBe(true)
    expect(isPrematureStop('', 'length', 0)).toBe(true)
  })

  it('treats open todos as unfinished regardless of the text', () => {
    expect(isPrematureStop('I added the property and the build passes.', 'stop', 2)).toBe(true)
  })

  it('flags narration of a next action that was not taken', () => {
    expect(isPrematureStop("I'll now update Tower.ts to add the aura property.", 'stop', 0)).toBe(true)
    expect(isPrematureStop('Next, I need to modify Tower.ts to add an auraBonus property and apply it.', 'stop', 0)).toBe(true)
    expect(isPrematureStop('Let me run the tests to verify the change.', 'stop', 0)).toBe(true)
  })

  it('does NOT flag a genuine completion summary (past tense, no pending intent)', () => {
    expect(isPrematureStop('I added the auraBonus property and updated the tier getter. The build passes.', 'stop', 0)).toBe(false)
    expect(isPrematureStop('Done — all 8 tasks complete. Let me know if you need anything else.', 'stop', 0)).toBe(false)
  })

  it('does NOT flag a past-tense report that opens with "Now I\'ve …" (C2 — the "now i" + verb false positive)', () => {
    expect(isPrematureStop("Now I've added the helper function and it works.", 'stop', 0)).toBe(false)
    expect(isPrematureStop("Now I've updated Tower.ts with the aura property.", 'stop', 0)).toBe(false)
    // Still flags real forward-looking intent that merely starts the same way.
    expect(isPrematureStop("Now I'll add the helper function to Tower.ts.", 'stop', 0)).toBe(true)
  })

  it('does NOT flag a reply that ends on a question to the user', () => {
    expect(isPrematureStop('I can refactor this two ways. Which do you prefer?', 'stop', 0)).toBe(false)
    expect(isPrematureStop("I'll need the API key — should I add it to settings?", 'stop', 0)).toBe(false)
  })

  it('does NOT flag a pure-empty non-truncated reply (handled elsewhere)', () => {
    expect(isPrematureStop('', 'stop', 0)).toBe(false)
    expect(isPrematureStop('   ', 'stop', 0)).toBe(false)
  })

  it('continuationNudge wording matches the situation', () => {
    expect(continuationNudge(0, 'length')).toMatch(/cut off/i)
    expect(continuationNudge(3, 'stop')).toMatch(/3 items .*are still/i)
    expect(continuationNudge(1, 'stop')).toMatch(/1 item .*is still/i)
    expect(continuationNudge(0, 'stop')).toMatch(/did not take it/i)
  })
})

describe('isThinkingOnly — thinking-only recovery detection', () => {
  it('detects reasoning_content with no visible answer and no tool call', () => {
    expect(isThinkingOnly('', '', 'Let me figure out the next step…', 0)).toBe(true)
  })

  it('detects an inline <think> block with no visible content', () => {
    // displayText is empty because the loop already stripped the think tags out of the content.
    expect(isThinkingOnly('', '<think>planning the edit</think>', '', 0)).toBe(true)
  })

  it('is false when there is a real visible answer', () => {
    expect(isThinkingOnly('Here is the result.', 'Here is the result.', 'some reasoning', 0)).toBe(false)
  })

  it('is false when the model made a tool call (it is acting, not just thinking)', () => {
    expect(isThinkingOnly('', '', 'reasoning about which tool', 1)).toBe(false)
  })

  it('is false when there is neither reasoning nor an inline think block (that is a plain empty reply)', () => {
    expect(isThinkingOnly('', '', '', 0)).toBe(false)
  })
})

describe('looksLikeTruncatedToolCall — cut-off text tool call detection', () => {
  it('detects an opened <tool_call> with no closing tag (the real incident)', () => {
    const t = '<tool_call>\n<function=write_file>\n<parameter=path>a.js</parameter>\n<parameter=content>\n// big file...'
    expect(looksLikeTruncatedToolCall(t)).toBe(true)
  })
  it('detects unbalanced <parameter> (content param never closed)', () => {
    expect(looksLikeTruncatedToolCall('<parameter=path>a.js</parameter><parameter=content>x')).toBe(true)
  })
  it('detects an opened <function= with no </function>', () => {
    expect(looksLikeTruncatedToolCall('<function=read_file><parameter=path>a</parameter>')).toBe(true)
  })
  it('is false for a complete tool call', () => {
    const t = '<tool_call><function=write_file><parameter=path>a.js</parameter><parameter=content>x</parameter></function></tool_call>'
    expect(looksLikeTruncatedToolCall(t)).toBe(false)
  })
  it('is false for plain prose with no tool tags', () => {
    expect(looksLikeTruncatedToolCall('Done — milestone 2 complete, ready for the next.')).toBe(false)
  })
})
