import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ROOT = path.join(os.tmpdir(), 'basenjicode-thinking-budget-test')

vi.mock('electron', () => ({ app: { getPath: () => ROOT } }))

import { AgentSession } from './loop'
import { ToolRegistry } from './registry'
import type { ChatChunk, ChatStreamParams, LLMConnection } from './lmstudio'
import type { AgentEvent } from '../../shared/ipc-types'
import type { ChatMessage } from '../../shared/domain-types'

const rChunk = (s: string): ChatChunk => ({ choices: [{ delta: { reasoning_content: s } }] }) as unknown as ChatChunk
const cChunk = (s: string): ChatChunk => ({ choices: [{ delta: { content: s } }] }) as unknown as ChatChunk
const finishChunk = (): ChatChunk => ({ choices: [{ delta: {}, finish_reason: 'stop' }] }) as unknown as ChatChunk

/** First call: streams `firstReasoning` in 800-char chunks (abort-aware), then finishes.
 *  Later calls: a plain 'Done.' content completion. */
class ThinkingConnection implements LLMConnection {
  calls: ChatStreamParams[] = []

  constructor(private firstReasoning: string) {}

  async listModels(): Promise<string[]> {
    return ['mystery-model']
  }

  async chatStream(params: ChatStreamParams): Promise<AsyncIterable<ChatChunk> & { controller: AbortController }> {
    this.calls.push(params)
    const first = this.calls.length === 1
    const controller = new AbortController()
    const reasoning = this.firstReasoning
    async function* play(): AsyncGenerator<ChatChunk> {
      if (first) {
        for (let i = 0; i < reasoning.length; i += 800) {
          if (controller.signal.aborted) return
          yield rChunk(reasoning.slice(i, i + 800))
          await new Promise((r) => setTimeout(r, 1))
        }
        if (controller.signal.aborted) return
        yield cChunk(' 42')
      } else {
        yield cChunk('Done.')
      }
      yield finishChunk()
    }
    return Object.assign(play(), { controller })
  }

  async chatComplete(): Promise<never> {
    throw new Error('unused')
  }
}

async function run(
  effort: 'low' | 'high',
  firstReasoning: string
): Promise<{ connection: ThinkingConnection; events: AgentEvent[] }> {
  const connection = new ThinkingConnection(firstReasoning)
  const events: AgentEvent[] = []
  const session = new AgentSession({
    id: `thinking-budget-${effort}`,
    workspaceRoot: ROOT,
    client: connection,
    registry: new ToolRegistry(),
    config: {
      model: 'mystery-model',
      temperature: 0,
      maxTokens: 512,
      maxTurns: 2,
      contextLimitTokens: 8000,
      preferTextToolCalls: true,
      reasoningEffort: effort
    },
    mode: 'ask',
    history: []
  })
  await session.runTurn('question', 'turn-1', (e) => events.push(e))
  return { connection, events }
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(ROOT, { recursive: true })
})

describe('1b′ thinking budgets', () => {
  it('force-closes an over-budget think once and re-issues with the closed prefill', async () => {
    const { connection, events } = await run('low', 'x'.repeat(3200)) // low budget = 2000 chars
    expect(connection.calls.length).toBe(2)
    const prefill = (connection.calls[1].messages as ChatMessage[]).map((m) => m.content ?? '').join('\n')
    expect(prefill).toContain('<think>')
    expect(prefill).toContain('concluding now')
    const notices = events.filter((e) => e.type === 'notice' && /Thinking budget/.test(e.text))
    expect(notices.length).toBe(1)
  })

  it("effort 'high' engages zero budget machinery (single request)", async () => {
    const { connection } = await run('high', 'x'.repeat(3200))
    expect(connection.calls.length).toBe(1)
  })

  it('never aborts while a tool call is mid-emission in the reasoning channel', async () => {
    const { connection } = await run('low', '<tool_call>' + 'y'.repeat(3000))
    expect(connection.calls.length).toBe(1)
  })
})
