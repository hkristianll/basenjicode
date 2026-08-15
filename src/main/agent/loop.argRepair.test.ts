import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const ROOT = path.join(os.tmpdir(), 'nordcode-loop-arg-repair-test')

vi.mock('electron', () => ({ app: { getPath: () => ROOT } }))

import { AgentSession } from './loop'
import { ToolRegistry } from './registry'
import type { ChatChunk, ChatCompletion, ChatStreamParams, LLMConnection } from './lmstudio'
import type { AgentEvent } from '../../shared/ipc-types'

const textChunk = (text: string): ChatChunk =>
  ({ choices: [{ delta: { content: text } }] }) as unknown as ChatChunk
const finishChunk = (reason: string): ChatChunk =>
  ({ choices: [{ delta: {}, finish_reason: reason }] }) as unknown as ChatChunk
const toolChunk = (name: string, args: string): ChatChunk =>
  ({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'call-1', function: { name, arguments: args } }]
        }
      }
    ]
  }) as unknown as ChatChunk

class ToolCallConnection implements LLMConnection {
  calls: ChatStreamParams[] = []

  constructor(
    private args: string,
    private toolName: string
  ) {}

  async listModels(): Promise<string[]> {
    return ['test-model']
  }

  async chatStream(params: ChatStreamParams): Promise<AsyncIterable<ChatChunk> & { controller: AbortController }> {
    this.calls.push(params)
    const chunks =
      this.calls.length === 1
        ? [toolChunk(this.toolName, this.args), finishChunk('tool_calls')]
        : [textChunk('All done.'), finishChunk('stop')]
    async function* play(): AsyncGenerator<ChatChunk> {
      for (const chunk of chunks) yield chunk
    }
    return Object.assign(play(), { controller: new AbortController() })
  }

  async chatComplete(): Promise<ChatCompletion> {
    throw new Error('unused')
  }
}

async function runToolCall(
  schema: z.ZodType,
  args: Record<string, unknown>,
  toolName = 'typed_tool'
): Promise<{ events: AgentEvent[]; handled: unknown[] }> {
  const handled: unknown[] = []
  const registry = new ToolRegistry()
  registry.register({
    name: toolName,
    description: 'test tool',
    schema,
    mutating: false,
    handler: async (validated) => {
      handled.push(validated)
      return 'handled'
    }
  })
  const session = new AgentSession({
    id: 'arg-repair-test',
    workspaceRoot: ROOT,
    client: new ToolCallConnection(JSON.stringify(args), toolName),
    registry,
    config: { model: 'test-model', temperature: 0, maxTokens: 512, maxTurns: 4, contextLimitTokens: 8000 },
    mode: 'ask',
    history: []
  })
  const events: AgentEvent[] = []
  await session.runTurn('run the typed tool', 'turn-1', (event) => events.push(event))
  return { events, handled }
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(ROOT, { recursive: true })
})

describe('tool argument schema repair seam', () => {
  it('retries validation once and executes with the repaired value', async () => {
    const schema = z.object({ count: z.number() })
    const safeParse = vi.spyOn(schema, 'safeParse')

    const { events, handled } = await runToolCall(schema, { count: '12' })

    expect(safeParse).toHaveBeenCalledTimes(2)
    expect(handled).toEqual([{ count: 12 }])
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool-result', ok: true, result: 'handled' }))
  })

  it('preserves the original validation error and appends derived required parameter types', async () => {
    const schema = z.object({ count: z.number().min(10) })
    const original = schema.safeParse({ count: '7' })
    if (original.success) throw new Error('expected the original args to fail')
    const originalIssues = original.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    const safeParse = vi.spyOn(schema, 'safeParse')

    const { events, handled } = await runToolCall(schema, { count: '7' })

    expect(safeParse).toHaveBeenCalledTimes(2)
    expect(handled).toEqual([])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-result',
        ok: false,
        result: `ERROR: invalid arguments — ${originalIssues}. Fix and retry. Required params: count (number).`
      })
    )
  })

  it('teaches todo_write the exact XML shape with its todos JSON array inline', async () => {
    const schema = z.object({
      todos: z.array(z.object({ content: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) }))
    })

    const { events, handled } = await runToolCall(schema, { todos: 'not an array' }, 'todo_write')

    expect(handled).toEqual([])
    const failed = events.find(
      (event): event is Extract<AgentEvent, { type: 'tool-result' }> => event.type === 'tool-result' && !event.ok
    )
    expect(failed?.result).toContain(
      '<function=todo_write><parameter=todos>[{"content": "step", "status": "pending"}]</parameter></function>'
    )
    expect(failed?.result.length).toBeLessThanOrEqual(600)
  })
})
