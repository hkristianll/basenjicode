import path from 'node:path'
import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'

const ROOT = path.join(os.tmpdir(), 'nordcode-stable-prompt-test')
vi.mock('electron', () => ({ app: { getPath: () => ROOT } }))

import { buildSystemPrompt, buildVolatileSystemPrompt } from './prompt'
import { renderProjectState } from './projectState'
import { backgroundHandles, composeSendableMessages, nextPreviewUrl } from './loop'
import type { ChatMessage } from '../../shared/domain-types'

describe('stable prefix and volatile sendable tail', () => {
  it('keeps the first system bytes identical while updated project state rides at the tail', () => {
    const stableA = buildSystemPrompt({ workspaceRoot: ROOT, planMode: false, workerRole: 'implementation' })
    const stableB = buildSystemPrompt({ workspaceRoot: ROOT, planMode: false, workerRole: 'implementation' })
    const first = composeSendableMessages({
      stableSystemPrompt: stableA,
      history: [{ role: 'user', content: 'build it' }],
      volatileSystemPrompt: buildVolatileSystemPrompt({
        workspaceRoot: ROOT,
        projectState: renderProjectState({ goal: 'build it' })
      }),
      contextLimitTokens: 8000,
      maxTokens: 512,
      toolsTokens: 0
    })
    const second = composeSendableMessages({
      stableSystemPrompt: stableB,
      history: [{ role: 'user', content: 'build it' }],
      volatileSystemPrompt: buildVolatileSystemPrompt({
        workspaceRoot: ROOT,
        projectState: renderProjectState({
          goal: 'build it',
          files: [{ path: 'src/new.ts', action: 'created' }],
          todos: [{ content: 'verify output', status: 'in_progress' }]
        })
      }),
      contextLimitTokens: 8000,
      maxTokens: 512,
      toolsTokens: 0
    })

    expect(first.sendable[0].content).toBe(second.sendable[0].content)
    expect(first.sendable.at(-1)?.content).not.toContain('src/new.ts')
    expect(second.sendable.at(-1)?.content).toContain('src/new.ts')
    expect(second.sendable.at(-1)?.content).toContain('verify output')
  })

  it('preserves the volatile block after compacted history is heavily trimmed', () => {
    const history: ChatMessage[] = [
      { role: 'system', content: `Compacted summary ${'x'.repeat(20_000)}` },
      { role: 'user', content: `old task ${'y'.repeat(20_000)}` },
      { role: 'assistant', content: `old answer ${'z'.repeat(20_000)}` },
      { role: 'user', content: 'continue' }
    ]
    const built = composeSendableMessages({
      stableSystemPrompt: 'stable prefix',
      history,
      volatileSystemPrompt: '# Current run state\nCurrent file: src/live.ts',
      contextLimitTokens: 5000,
      maxTokens: 512,
      toolsTokens: 0,
      tokenScale: 1.4
    })

    expect(built.composition.trimmedMsgs).toBeGreaterThan(0)
    expect(built.sendable.at(-1)).toEqual({
      role: 'system',
      content: '# Current run state\nCurrent file: src/live.ts'
    })
  })

  it('carries a successful preview_open URL into the next volatile project-state block', () => {
    const previewUrl = nextPreviewUrl('', 'preview_open', 'Preview loaded: http://127.0.0.1:8471')
    const built = composeSendableMessages({
      stableSystemPrompt: 'stable prefix',
      history: [{ role: 'user', content: 'show me the app' }],
      volatileSystemPrompt: buildVolatileSystemPrompt({
        workspaceRoot: ROOT,
        projectState: renderProjectState({ previewUrl })
      }),
      contextLimitTokens: 8000,
      maxTokens: 512,
      toolsTokens: 0
    })

    expect(built.sendable.at(-1)?.content).toContain('Preview: http://127.0.0.1:8471')
    expect(nextPreviewUrl(previewUrl, 'preview_open', 'ERROR: preview unavailable')).toBe(previewUrl)
  })

  it('keeps only running background handles and discovers a URL from recent output', () => {
    expect(
      backgroundHandles([
        { id: 'bg1', command: 'npm run dev', status: 'running', outputTail: 'ready at http://localhost:5173\n' },
        { id: 'bg2', command: 'npm test', status: 'exited', outputTail: 'done' }
      ])
    ).toEqual([{ id: 'bg1', command: 'npm run dev', url: 'http://localhost:5173' }])
  })
})

describe('pressure-gated duplicate-read collapse', () => {
  const duplicateHistory = (): ChatMessage[] => {
    const args = '{"path":"src/a.ts"}'
    return [
      { role: 'user', content: 'inspect the file', images: ['data:image/png;base64,AAAA'] },
      { role: 'assistant', content: null, toolCalls: [{ id: 'read-1', name: 'read_file', arguments: args }] },
      { role: 'tool', toolCallId: 'read-1', content: 'old'.repeat(1700) },
      { role: 'assistant', content: null, toolCalls: [{ id: 'read-2', name: 'read_file', arguments: args }] },
      { role: 'tool', toolCallId: 'read-2', content: 'latest'.repeat(850) }
    ]
  }

  const build = (contextLimitTokens: number) =>
    composeSendableMessages({
      stableSystemPrompt: 'stable prefix',
      history: duplicateHistory(),
      volatileSystemPrompt: 'current state',
      contextLimitTokens,
      maxTokens: 128,
      toolsTokens: 23,
      tokenScale: 1
    })

  it('leaves duplicate reads byte-stable below 60% pressure and reports zero dedupe savings', () => {
    const built = build(20_000)

    expect(built.sendable.some((message) => message.content === 'old'.repeat(1700))).toBe(true)
    expect(built.composition).toMatchObject({
      dedupeSavedChars: 0,
      imageCount: 1,
      imageBytes: Buffer.byteLength('data:image/png;base64,AAAA'),
      toolsTokens: 23
    })
  })

  it('collapses duplicate reads exactly as before at high pressure and reports the savings', () => {
    const built = build(6_000)
    const old = built.sendable.find((message) => message.toolCallId === 'read-1')

    expect(old?.content).toContain('superseded by the latest')
    expect(built.composition.dedupeSavedChars).toBe('old'.repeat(1700).length - (old?.content?.length ?? 0))
    expect(built.composition).toMatchObject({ imageCount: 1, toolsTokens: 23 })
  })
})
