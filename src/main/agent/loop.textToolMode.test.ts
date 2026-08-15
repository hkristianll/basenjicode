import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const ROOT = path.join(os.tmpdir(), 'nordcode-loop-text-tool-mode-test')

vi.mock('electron', () => ({ app: { getPath: () => ROOT } }))

import { AgentSession, requestToolsTokens } from './loop'
import { ToolRegistry } from './registry'
import type { ChatChunk, ChatCompletion, ChatStreamParams, LLMConnection } from './lmstudio'

const textChunk = (text: string): ChatChunk =>
  ({ choices: [{ delta: { content: text } }] }) as unknown as ChatChunk
const finishChunk = (reason: string): ChatChunk =>
  ({ choices: [{ delta: {}, finish_reason: reason }] }) as unknown as ChatChunk

class RecordingConnection implements LLMConnection {
  calls: ChatStreamParams[] = []

  constructor(private firstResponse: string = 'All done.') {}

  async listModels(): Promise<string[]> {
    return ['test-model']
  }

  async chatStream(params: ChatStreamParams): Promise<AsyncIterable<ChatChunk> & { controller: AbortController }> {
    this.calls.push(params)
    const response = this.calls.length === 1 ? this.firstResponse : 'All done.'
    async function* play(): AsyncGenerator<ChatChunk> {
      yield textChunk(response)
      yield finishChunk('stop')
    }
    return Object.assign(play(), { controller: new AbortController() })
  }

  async chatComplete(): Promise<ChatCompletion> {
    throw new Error('unused')
  }
}

function makeRegistry(handled: string[]): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register({
    name: 'echo_value',
    description: 'Echo a value',
    schema: z.object({ value: z.string() }),
    mutating: false,
    handler: async ({ value }) => {
      handled.push(value)
      return value
    }
  })
  return registry
}

async function run(preferTextToolCalls: boolean, response?: string): Promise<{
  connection: RecordingConnection
  registry: ToolRegistry
  handled: string[]
}> {
  const handled: string[] = []
  const registry = makeRegistry(handled)
  const connection = new RecordingConnection(response)
  const session = new AgentSession({
    id: `text-tool-mode-${preferTextToolCalls}`,
    workspaceRoot: ROOT,
    client: connection,
    registry,
    config: {
      model: 'test-model',
      temperature: 0,
      maxTokens: 512,
      maxTurns: 4,
      contextLimitTokens: 8000,
      preferTextToolCalls
    },
    mode: 'ask',
    history: []
  })
  await session.runTurn('use the echo tool', 'turn-1', () => {})
  return { connection, registry, handled }
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(ROOT, { recursive: true })
})

describe('true text tool-call request mode', () => {
  it('omits tools from the request while retaining the registry for text recovery and execution', async () => {
    const response = '<tool_call>{"name":"echo_value","arguments":{"value":"recovered"}}</tool_call>'
    const { connection, handled } = await run(true, response)

    expect(Object.hasOwn(connection.calls[0], 'tools')).toBe(false)
    expect(handled).toEqual(['recovered'])
  })

  it('keeps native tools on the request when text tool-call mode is off', async () => {
    const { connection } = await run(false)

    expect(Object.hasOwn(connection.calls[0], 'tools')).toBe(true)
    expect(connection.calls[0].tools).toHaveLength(1)
  })

  it('excludes tool-schema tokens from the trim reserve only in text tool-call mode', () => {
    const tools = makeRegistry([]).toOpenAITools()

    expect(requestToolsTokens(tools, true)).toBe(0)
    expect(requestToolsTokens(tools, false)).toBeGreaterThan(0)
  })
})
