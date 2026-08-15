import { describe, expect, it } from 'vitest'
import { groupChatItems, isAgentItem } from './chatPresentation'
import type { ToolItem, UIItem } from './store'

function tool(id: string): ToolItem {
  return {
    kind: 'tool',
    id,
    callId: id,
    name: 'read_file',
    risk: 'safe',
    argsText: '{}',
    status: 'done',
    ok: true
  }
}

describe('chat presentation', () => {
  it('groups even a single tool call into compact activity', () => {
    const items: UIItem[] = [
      { kind: 'user', id: 'u1', text: 'inspect this' },
      tool('t1'),
      { kind: 'assistant', id: 'a1', text: 'Done.', streaming: false }
    ]

    expect(groupChatItems(items)).toEqual([
      { type: 'item', item: items[0], idx: 0 },
      { type: 'group', tools: [items[1]], firstIdx: 1 },
      { type: 'item', item: items[2], idx: 2 }
    ])
  })

  it('keeps tool runs on either side of prose in chronological order', () => {
    const items: UIItem[] = [
      tool('t1'),
      tool('t2'),
      { kind: 'assistant', id: 'a1', text: 'I found the seam.', streaming: false },
      tool('t3')
    ]

    const segments = groupChatItems(items)
    expect(segments.map((segment) => segment.type)).toEqual(['group', 'item', 'group'])
    expect(segments[0]).toMatchObject({ firstIdx: 0, tools: [{ id: 't1' }, { id: 't2' }] })
    expect(segments[2]).toMatchObject({ firstIdx: 3, tools: [{ id: 't3' }] })
  })

  it('absorbs short operational bridge prose into the surrounding tool burst', () => {
    const items: UIItem[] = [
      tool('t1'),
      { kind: 'assistant', id: 'bridge', text: 'Now let me check the preview console.', streaming: false },
      tool('t2'),
      { kind: 'assistant', id: 'finding', text: 'I found the issue in the renderer.', streaming: false },
      tool('t3')
    ]

    const segments = groupChatItems(items)
    expect(segments.map((segment) => segment.type)).toEqual(['group', 'item', 'group'])
    expect(segments[0]).toMatchObject({ firstIdx: 0, tools: [{ id: 't1' }, { id: 't2' }] })
    expect(segments[1]).toMatchObject({ item: { id: 'finding' } })
    expect(segments[2]).toMatchObject({ firstIdx: 4, tools: [{ id: 't3' }] })
  })

  it('hides a bridge line before the first tool group in a work burst', () => {
    const items: UIItem[] = [
      { kind: 'user', id: 'u1', text: 'continue' },
      { kind: 'assistant', id: 'bridge', text: "I'll inspect the relevant files first.", streaming: false },
      tool('t1')
    ]

    expect(groupChatItems(items)).toEqual([
      { type: 'item', item: items[0], idx: 0 },
      { type: 'group', tools: [items[2]], firstIdx: 2 }
    ])
  })

  it('skips leaked text tool-call fragments and keeps surrounding tools grouped', () => {
    const items: UIItem[] = [
      tool('t1'),
      { kind: 'assistant', id: 'noise', text: '<tool_call> <function=preview_eval> <parameter=code> return document.title', streaming: false },
      tool('t2'),
      { kind: 'assistant', id: 'a1', text: 'The preview is still failing.', streaming: false },
      tool('t3')
    ]

    const segments = groupChatItems(items)
    expect(segments.map((segment) => segment.type)).toEqual(['group', 'item', 'group'])
    expect(segments[0]).toMatchObject({ firstIdx: 0, tools: [{ id: 't1' }, { id: 't2' }] })
    expect(segments[1]).toMatchObject({ item: { id: 'a1' } })
  })

  it('recognizes only assistant and tool rows as agent continuations', () => {
    expect(isAgentItem({ kind: 'assistant', id: 'a', text: '', streaming: true })).toBe(true)
    expect(isAgentItem(tool('t'))).toBe(true)
    expect(isAgentItem({ kind: 'user', id: 'u', text: '' })).toBe(false)
  })
})
