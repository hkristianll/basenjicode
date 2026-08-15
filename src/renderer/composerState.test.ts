import { describe, expect, it } from 'vitest'
import {
  EMPTY_COMPOSER_STATE,
  enqueuePrompt,
  promptHistory,
  removeQueuedPrompt,
  takeNextPrompt,
  updateQueuedPrompt
} from './composerState'

describe('composer queue state', () => {
  it('queues a draft without adding it to any transcript', () => {
    const next = enqueuePrompt({ draft: 'draft', images: ['old'], queue: [] }, '  run tests  ', ['img'], 'q1', 10)
    expect(next).toEqual({
      draft: '',
      images: [],
      queue: [{ id: 'q1', text: 'run tests', images: ['img'], createdAt: 10 }]
    })
  })

  it('edits, removes, and drains entries in order', () => {
    const one = enqueuePrompt(EMPTY_COMPOSER_STATE, 'one', [], 'q1', 1)
    const two = enqueuePrompt(one, 'two', [], 'q2', 2)
    const edited = updateQueuedPrompt(two, 'q2', 'second')
    const first = takeNextPrompt(edited)
    expect(first.prompt?.text).toBe('one')
    expect(removeQueuedPrompt(first.state, 'q2').queue).toEqual([])
  })

  it('does not auto-drain a queue entry while it is being edited', () => {
    const queued = enqueuePrompt(EMPTY_COMPOSER_STATE, 'original', [], 'q1', 1)
    const editing = { ...queued, draft: 'work in progress', editingQueueId: 'q1' }
    const blocked = takeNextPrompt(editing)

    expect(blocked.prompt).toBeNull()
    expect(blocked.state).toBe(editing)
  })

  it('derives de-duplicated sent prompt history', () => {
    expect(
      promptHistory([
        { kind: 'user', text: 'one' },
        { kind: 'assistant', text: 'answer' },
        { kind: 'user', text: 'one' },
        { kind: 'user', text: 'two' }
      ])
    ).toEqual(['one', 'two'])
  })
})
