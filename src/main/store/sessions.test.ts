import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ROOT = path.join(os.tmpdir(), 'nordcode-composer-session-test')

vi.mock('electron', () => ({ app: { getPath: () => ROOT } }))

import { createSession, loadSession, saveComposerState, saveTranscript } from './sessions'

describe('session composer persistence', () => {
  beforeEach(() => {
    fs.rmSync(ROOT, { recursive: true, force: true })
    fs.mkdirSync(ROOT, { recursive: true })
  })

  it('persists drafts and queues without changing chat recency', () => {
    const meta = createSession('C:\\work', 'ask')
    const before = loadSession(meta.id)
    saveComposerState(meta.id, {
      draft: 'unfinished thought',
      images: [],
      queue: [{ id: 'q1', text: 'run tests', createdAt: 10 }]
    })
    const after = loadSession(meta.id)
    expect(after?.composer?.draft).toBe('unfinished thought')
    expect(after?.composer?.queue[0]?.text).toBe('run tests')
    expect(after?.updatedAt).toBe(before?.updatedAt)
  })

  it('preserves composer state when a completed turn saves the transcript', () => {
    const meta = createSession('C:\\work', 'ask')
    saveComposerState(meta.id, { draft: '', images: [], queue: [{ id: 'q1', text: 'next', createdAt: 10 }] })
    saveTranscript(meta.id, {
      cwd: 'C:\\work',
      mode: 'ask',
      messages: [{ role: 'user', content: 'first' }]
    })
    expect(loadSession(meta.id)?.composer?.queue.map((entry) => entry.text)).toEqual(['next'])
  })
})
