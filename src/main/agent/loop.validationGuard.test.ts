import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const ROOT = path.join(os.tmpdir(), 'nordcode-loop-validation-guard-test')

vi.mock('electron', () => ({ app: { getPath: () => ROOT } }))

import { AgentSession } from './loop'
import { ToolRegistry } from './registry'
import type { ChatChunk, ChatCompletion, ChatStreamParams, LLMConnection } from './lmstudio'
import type { AgentEvent } from '../../shared/ipc-types'

const textChunk = (text: string): ChatChunk =>
  ({ choices: [{ delta: { content: text } }] }) as unknown as ChatChunk
const finishChunk = (reason: string): ChatChunk =>
  ({ choices: [{ delta: {}, finish_reason: reason }] }) as unknown as ChatChunk
const toolChunk = (index: number, args: Record<string, unknown>): ChatChunk =>
  ({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: `call-${index}`, function: { name: 'todo_write', arguments: JSON.stringify(args) } }
          ]
        }
      }
    ]
  }) as unknown as ChatChunk

class AttemptConnection implements LLMConnection {
  calls: ChatStreamParams[] = []

  constructor(private attempts: Array<Record<string, unknown>>) {}

  async listModels(): Promise<string[]> {
    return ['test-model']
  }

  async chatStream(params: ChatStreamParams): Promise<AsyncIterable<ChatChunk> & { controller: AbortController }> {
    this.calls.push(params)
    const index = this.calls.length - 1
    const attempt = this.attempts[index]
    async function* play(): AsyncGenerator<ChatChunk> {
      if (attempt) {
        yield toolChunk(index, attempt)
        yield finishChunk('tool_calls')
      } else {
        yield textChunk('All done.')
        yield finishChunk('stop')
      }
    }
    return Object.assign(play(), { controller: new AbortController() })
  }

  async chatComplete(): Promise<ChatCompletion> {
    throw new Error('unused')
  }
}

const invalid = (label = 'same'): Record<string, unknown> => ({ todos: label })
const runtime = (): Record<string, unknown> => ({ todos: [{ content: 'runtime', status: 'pending' }] })

async function run(
  attempts: Array<Record<string, unknown>>,
  warnDontBail: boolean
): Promise<{ session: AgentSession; connection: AttemptConnection; events: AgentEvent[] }> {
  const registry = new ToolRegistry()
  registry.register({
    name: 'todo_write',
    description: 'test todo tool',
    schema: z.object({
      todos: z.array(z.object({ content: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) }))
    }),
    mutating: false,
    handler: async () => 'ERROR: runtime failure'
  })
  const connection = new AttemptConnection(attempts)
  const session = new AgentSession({
    id: warnDontBail ? 'chat-validation-guard' : 'loop-validation-guard',
    workspaceRoot: ROOT,
    client: connection,
    registry,
    config: {
      model: 'test-model',
      temperature: 0,
      maxTokens: 512,
      maxTurns: 12,
      contextLimitTokens: 8000,
      warnDontBail
    },
    mode: 'ask',
    history: []
  })
  const events: AgentEvent[] = []
  await session.runTurn('run the todo tool', 'turn-1', (event) => events.push(event))
  return { session, connection, events }
}

const correctiveMessages = (session: AgentSession): string[] =>
  session
    .getHistory()
    .filter((message) => message.role === 'system' && message.content?.startsWith('STOP repeating the identical invalid'))
    .map((message) => message.content ?? '')

const doneEvent = (events: AgentEvent[]): Extract<AgentEvent, { type: 'turn-done' }> => {
  const done = events.find((event): event is Extract<AgentEvent, { type: 'turn-done' }> => event.type === 'turn-done')
  if (!done) throw new Error('turn did not finish')
  return done
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(ROOT, { recursive: true })
})

describe('deterministic schema-validation failure guard', () => {
  it('injects one corrective exact-shape message after 3 identical chat failures', async () => {
    const { session, connection, events } = await run([invalid(), invalid(), invalid()], true)

    expect(connection.calls).toHaveLength(4)
    expect(doneEvent(events).stopReason).toBe('completed')
    expect(correctiveMessages(session)).toEqual([
      expect.stringContaining(
        '<function=todo_write><parameter=todos>[{"content": "step", "status": "pending"}]</parameter></function>'
      )
    ])
  })

  it('guard-stops the board directly at the 3rd identical validation failure', async () => {
    const { session, connection, events } = await run([invalid(), invalid(), invalid(), invalid()], false)

    expect(connection.calls).toHaveLength(3)
    expect(doneEvent(events)).toMatchObject({ stopReason: 'error', error: expect.stringContaining('identical invalid arguments') })
    expect(correctiveMessages(session)).toHaveLength(0)
  })

  it('guard-stops chat after 3 more identical failures following the one nudge', async () => {
    const attempts = Array.from({ length: 7 }, () => invalid())
    const { session, connection, events } = await run(attempts, true)

    expect(connection.calls).toHaveLength(6)
    expect(doneEvent(events)).toMatchObject({ stopReason: 'error', error: expect.stringContaining('identical invalid arguments') })
    expect(correctiveMessages(session)).toHaveLength(1)
  })

  it('different args and a runtime failure reset the consecutive validation counter', async () => {
    const attempts = [invalid('a'), invalid('a'), invalid('b'), invalid('a'), invalid('a'), runtime(), invalid('a'), invalid('a')]
    const { session, connection, events } = await run(attempts, false)

    expect(connection.calls).toHaveLength(attempts.length + 1)
    expect(doneEvent(events).stopReason).toBe('completed')
    expect(correctiveMessages(session)).toHaveLength(0)
  })
})
