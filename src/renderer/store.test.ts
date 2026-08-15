import { describe, it, expect } from 'vitest'
import { chatReducer, deriveItems, initialSessionChats } from './store'
import type { TodoItem } from '../shared/domain-types'

describe('chatReducer — todos', () => {
  it('stores the todo list for the right session', () => {
    const todos: TodoItem[] = [
      { content: 'Read code', status: 'completed' },
      { content: 'Make the change', status: 'in_progress' },
      { content: 'Verify', status: 'pending' }
    ]
    const next = chatReducer(initialSessionChats, {
      type: 'event',
      sessionId: 's1',
      event: { type: 'todos', turnId: 't1', todos }
    })
    expect(next['s1'].todos).toEqual(todos)
    expect(next['s2']).toBeUndefined()
  })

  it('replaces the previous list on the next todos event', () => {
    let state = chatReducer(initialSessionChats, {
      type: 'event',
      sessionId: 's1',
      event: { type: 'todos', turnId: 't1', todos: [{ content: 'a', status: 'pending' }] }
    })
    state = chatReducer(state, {
      type: 'event',
      sessionId: 's1',
      event: { type: 'todos', turnId: 't1', todos: [{ content: 'b', status: 'completed' }] }
    })
    expect(state['s1'].todos).toEqual([{ content: 'b', status: 'completed' }])
  })
})

describe('chatReducer — live thinking progress', () => {
  it('updates ephemeral progress and clears it when assistant text starts', () => {
    let state = chatReducer(initialSessionChats, {
      type: 'event',
      sessionId: 's1',
      event: { type: 'turn-started', turnId: 't1' }
    })
    state = chatReducer(state, {
      type: 'event',
      sessionId: 's1',
      event: { type: 'thinking-progress', turnId: 't1', chars: 800, seconds: 3 }
    })
    state = chatReducer(state, {
      type: 'event',
      sessionId: 's1',
      event: { type: 'thinking-progress', turnId: 't1', chars: 1200, seconds: 5 }
    })

    expect(state['s1'].thinkingProgress).toEqual({ turnId: 't1', chars: 1200, seconds: 5 })
    expect(state['s1'].items).toEqual([])

    state = chatReducer(state, {
      type: 'event',
      sessionId: 's1',
      event: { type: 'assistant-delta', turnId: 't1', text: 'Here is the answer.' }
    })

    expect(state['s1'].thinkingProgress).toBeUndefined()
    expect(state['s1'].items).toMatchObject([{ kind: 'assistant', text: 'Here is the answer.' }])
  })

  it('clears progress on the first tool call and cannot rehydrate it from persisted messages', () => {
    let state = chatReducer(initialSessionChats, {
      type: 'event',
      sessionId: 's1',
      event: { type: 'thinking-progress', turnId: 't1', chars: 400, seconds: 1 }
    })
    state = chatReducer(state, {
      type: 'event',
      sessionId: 's1',
      event: { type: 'tool-call-delta', turnId: 't1', callId: 'c1', name: 'read_file', argsDelta: '{}' }
    })

    expect(state['s1'].thinkingProgress).toBeUndefined()
    expect(deriveItems([{ role: 'user', content: 'read it' }, { role: 'assistant', content: 'done' }])).not.toContainEqual(
      expect.objectContaining({ kind: 'thinking-progress' })
    )
  })
})

describe('chatReducer — rewind support (W5c)', () => {
  it('stampUserTurn marks the newest unstamped user item and leaves stamped ones alone', () => {
    let state = chatReducer(initialSessionChats, { type: 'addUser', sessionId: 's1', text: 'first' })
    state = chatReducer(state, { type: 'stampUserTurn', sessionId: 's1', turnId: 'turn-1' })
    state = chatReducer(state, { type: 'addUser', sessionId: 's1', text: 'second' })
    state = chatReducer(state, { type: 'stampUserTurn', sessionId: 's1', turnId: 'turn-2' })

    const users = state['s1'].items.filter((it) => it.kind === 'user')
    expect(users).toMatchObject([
      { text: 'first', turnId: 'turn-1' },
      { text: 'second', turnId: 'turn-2' }
    ])
  })

  it('stampUserTurn with no unstamped user item is a no-op', () => {
    const state = chatReducer(initialSessionChats, { type: 'stampUserTurn', sessionId: 's1', turnId: 't' })
    expect(state).toBe(initialSessionChats)
  })

  it('deriveItems carries the persisted turnId back onto user items', () => {
    const items = deriveItems([
      { role: 'user', content: 'do the thing', turnId: 'turn-9' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'mid-turn steer with no stamp' }
    ])
    expect(items).toMatchObject([
      { kind: 'user', text: 'do the thing', turnId: 'turn-9' },
      { kind: 'assistant', text: 'done' },
      { kind: 'user', text: 'mid-turn steer with no stamp', turnId: undefined }
    ])
  })
})

describe('deriveItems — reload fidelity (W5b)', () => {
  it('rehydrates the tool preview (diff) and images from the persisted transcript', () => {
    const items = deriveItems([
      { role: 'user', content: 'change it', turnId: 't1' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'edit_file', arguments: '{"path":"a.ts"}' }]
      },
      {
        role: 'tool',
        toolCallId: 'c1',
        content: 'OK: edited a.ts',
        preview: { kind: 'diff', unified: '--- a.ts\n+++ a.ts\n-old\n+new', path: 'a.ts' },
        images: ['data:image/png;base64,AAAA']
      }
    ])
    const tool = items.find((it) => it.kind === 'tool')
    expect(tool).toMatchObject({
      kind: 'tool',
      name: 'edit_file',
      ok: true,
      preview: { kind: 'diff', path: 'a.ts' },
      images: ['data:image/png;base64,AAAA']
    })
  })

  it('old sessions without the new fields still load (migration-safe)', () => {
    const items = deriveItems([
      { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'run_shell', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: 'done' }
    ])
    const tool = items.find((it) => it.kind === 'tool')
    expect(tool).toMatchObject({ kind: 'tool', name: 'run_shell', result: 'done', ok: true })
    expect((tool as { preview?: unknown }).preview).toBeUndefined()
  })
})
