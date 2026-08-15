import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../shared/domain-types'
import type { AgentEvent } from '../shared/ipc-types'

const store = vi.hoisted(() => ({
  loadSession: vi.fn(),
  saveTranscript: vi.fn()
}))

vi.mock('./store/sessions', () => store)

import { createTurnTranscriptSaver, isTranscriptCheckpointEvent, type LiveTranscriptSource } from './turnTranscriptSaver'

describe('completed-turn transcript persistence', () => {
  const sessionId = 'session-1'
  let history: ChatMessage[]
  let live: LiveTranscriptSource

  beforeEach(() => {
    vi.useFakeTimers()
    store.loadSession.mockReset().mockReturnValue({
      id: sessionId,
      cwd: 'C:\\work',
      mode: 'ask',
      title: 'Saved title'
    })
    store.saveTranscript.mockReset()
    history = [{ role: 'user', content: 'first' }]
    live = {
      getHistory: () => history,
      getAllowList: () => ({ tools: ['read_file'], exact: [], shellPrefixes: [] }),
      getTokenScale: () => 1.25
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces rapid turn-done events, saves latest history, then saves a later turn again', async () => {
    const saver = createTurnTranscriptSaver((id) => (id === sessionId ? live : undefined))

    saver.turnDone(sessionId)
    history = [...history, { role: 'assistant', content: 'latest rapid turn' }]
    saver.turnDone(sessionId)
    await vi.advanceTimersByTimeAsync(499)
    expect(store.saveTranscript).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(store.saveTranscript).toHaveBeenCalledTimes(1)
    expect(store.saveTranscript).toHaveBeenLastCalledWith(sessionId, {
      cwd: 'C:\\work',
      mode: 'ask',
      messages: history,
      title: 'Saved title',
      allowList: { tools: ['read_file'], exact: [], shellPrefixes: [] },
      tokenScale: 1.25
    })

    history = [...history, { role: 'user', content: 'later turn' }]
    saver.turnDone(sessionId)
    await vi.advanceTimersByTimeAsync(500)
    expect(store.saveTranscript).toHaveBeenCalledTimes(2)
    expect(store.saveTranscript.mock.calls[1][1].messages).toBe(history)
  })

  it('saves inner-turn completion events during a run and coalesces a burst per quiet period', async () => {
    const saver = createTurnTranscriptSaver((id) => (id === sessionId ? live : undefined))
    const emit = (event: AgentEvent): void => {
      if (isTranscriptCheckpointEvent(event)) saver.turnDone(sessionId)
    }

    emit({ type: 'assistant-message-done', turnId: 'turn-1' })
    history = [...history, { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{}' }] }]
    emit({ type: 'tool-result', turnId: 'turn-1', callId: 'call-1', ok: true, result: 'file contents' })
    await vi.advanceTimersByTimeAsync(499)
    expect(store.saveTranscript).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(store.saveTranscript).toHaveBeenCalledTimes(1)
    expect(store.saveTranscript.mock.calls[0][1].messages).toBe(history)

    history = [...history, { role: 'assistant', content: 'continuing before the run ends' }]
    emit({ type: 'assistant-message-done', turnId: 'turn-1' })
    await vi.advanceTimersByTimeAsync(500)
    expect(store.saveTranscript).toHaveBeenCalledTimes(2)
    expect(store.saveTranscript.mock.calls[1][1].messages).toBe(history)
  })

  it('skips a pending completed-turn save when rewind mutates the history', async () => {
    const saver = createTurnTranscriptSaver(() => live)

    saver.turnDone(sessionId)
    saver.historyRewound(sessionId)
    await vi.advanceTimersByTimeAsync(500)

    expect(store.saveTranscript).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
