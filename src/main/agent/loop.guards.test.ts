import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const ROOT = path.join(os.tmpdir(), 'nordcode-loop-guards-test')

// turnStats.ts writes turns.jsonl under app.getPath('logs'); point that at ROOT so we can read it back.
vi.mock('electron', () => ({ app: { getPath: () => ROOT } }))

import { AgentSession, guardWarnBudget } from './loop'
import { ToolRegistry } from './registry'
import type { ChatChunk, ChatCompletion, ChatStreamParams, LLMConnection } from './lmstudio'
import type { AgentConfig } from './loop'

// ---- guardWarnBudget: the soft-guard leash resolution (#1) --------------------------------------

describe('guardWarnBudget (board soft-guard leash)', () => {
  it('chat (warnDontBail) warns unbounded — Infinity budget', () => {
    expect(guardWarnBudget(true, undefined)).toBe(Infinity)
    // An explicit board budget is irrelevant once warnDontBail is on.
    expect(guardWarnBudget(true, 0)).toBe(Infinity)
  })

  it('the board (warnDontBail off) gets a small finite default so a wobble does not kill the turn on trip 1', () => {
    expect(guardWarnBudget(false, undefined)).toBe(2)
    expect(guardWarnBudget(undefined, undefined)).toBe(2)
  })

  it('honours an explicit override and clamps a bad (negative) config to the old stop-on-first-trip behaviour', () => {
    expect(guardWarnBudget(false, 4)).toBe(4)
    expect(guardWarnBudget(false, 0)).toBe(0) // 0 = stop immediately, the pre-change board behaviour
    expect(guardWarnBudget(false, -3)).toBe(0) // never negative
  })
})

// ---- board telemetry flag: turns.jsonl carries board:true|false (#2) ----------------------------

const textChunk = (t: string): ChatChunk => ({ choices: [{ delta: { content: t } }] }) as unknown as ChatChunk
const finishChunk = (reason: string): ChatChunk => ({ choices: [{ delta: {}, finish_reason: reason }] }) as unknown as ChatChunk

/** Minimal connection: one clean completion so the turn ends `completed` and records one turns.jsonl line. */
class DoneConnection implements LLMConnection {
  async listModels(): Promise<string[]> {
    return ['test-model']
  }
  async chatStream(_p: ChatStreamParams): Promise<AsyncIterable<ChatChunk> & { controller: AbortController }> {
    async function* play(): AsyncGenerator<ChatChunk> {
      yield textChunk('All done.')
      yield finishChunk('stop')
    }
    return Object.assign(play(), { controller: new AbortController() })
  }
  async chatComplete(): Promise<ChatCompletion> {
    throw new Error('unused')
  }
}

const BASE: AgentConfig = { model: 'test-model', temperature: 0, maxTokens: 512, maxTurns: 4, contextLimitTokens: 8000 }

async function runTurnWithId(id: string, config: AgentConfig = BASE): Promise<void> {
  const session = new AgentSession({
    id,
    workspaceRoot: ROOT,
    client: new DoneConnection(),
    registry: new ToolRegistry(),
    config,
    mode: 'ask',
    history: []
  })
  await session.runTurn('do the thing', `${id}-turn`, () => {})
}

function readTurns(): Array<Record<string, unknown>> {
  const file = path.join(ROOT, 'turns.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(ROOT, { recursive: true })
})

describe('turns.jsonl board discriminator', () => {
  it('tags a Mission/board worker turn (id `loop-<ticket>-…`) as board:true', async () => {
    await runTurnWithId('loop-42-abc')
    const rows = readTurns()
    expect(rows).toHaveLength(1)
    expect(rows[0].board).toBe(true)
  })

  it('tags an interactive chat turn as board:false', async () => {
    await runTurnWithId('chat-session-1')
    const rows = readTurns()
    expect(rows).toHaveLength(1)
    expect(rows[0].board).toBe(false)
  })

  it('tags a Brooke/manager turn (id `brooke:<key>`) as board:false — only per-ticket workers are board', async () => {
    await runTurnWithId('brooke:my-project')
    const rows = readTurns()
    expect(rows).toHaveLength(1)
    expect(rows[0].board).toBe(false)
  })

  it('records the Scout-premise counter when a relevant-file seed is supplied', async () => {
    await runTurnWithId('loop-42-counter', { ...BASE, relevantFiles: [] })
    const rows = readTurns()
    expect(rows).toHaveLength(1)
    expect(rows[0].readsOutsideRelevantFiles).toBe(0)
  })
})

// ---- model-reliability columns: completionTokens / genMs / toolFailures (#3) --------------------

const usageChunk = (promptTokens: number, completionTokens: number): ChatChunk =>
  ({ choices: [{ delta: {} }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } }) as unknown as ChatChunk
const toolChunk = (name: string, args: string): ChatChunk =>
  ({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name, arguments: args } }] } }] }) as unknown as ChatChunk

/** First completion calls one tool, second finishes clean; both deliver a usage chunk. */
class ToolThenDoneConnection implements LLMConnection {
  private completions = 0
  async listModels(): Promise<string[]> {
    return ['test-model']
  }
  async chatStream(_p: ChatStreamParams): Promise<AsyncIterable<ChatChunk> & { controller: AbortController }> {
    this.completions++
    const chunks =
      this.completions === 1
        ? [toolChunk('always_fails', '{"x":1}'), finishChunk('tool_calls'), usageChunk(10, 25)]
        : [textChunk('All done.'), finishChunk('stop'), usageChunk(40, 15)]
    async function* play(): AsyncGenerator<ChatChunk> {
      for (const chunk of chunks) yield chunk
    }
    return Object.assign(play(), { controller: new AbortController() })
  }
  async chatComplete(): Promise<ChatCompletion> {
    throw new Error('unused')
  }
}

describe('turns.jsonl model-reliability columns', () => {
  it('records completionTokens and genMs, and counts failed calls by tool name', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'always_fails',
      description: 'test tool that always fails',
      schema: z.object({ x: z.number() }),
      mutating: false,
      handler: async () => 'ERROR: kaboom'
    })
    const session = new AgentSession({
      id: 'reliability-test',
      workspaceRoot: ROOT,
      client: new ToolThenDoneConnection(),
      registry,
      config: BASE,
      mode: 'ask',
      history: []
    })
    await session.runTurn('do the thing', 'reliability-turn', () => {})
    const rows = readTurns()
    expect(rows).toHaveLength(1)
    expect(rows[0].completionTokens).toBe(40) // 25 + 15, accumulated across BOTH completions
    expect(typeof rows[0].genMs).toBe('number')
    expect(rows[0].genMs as number).toBeGreaterThanOrEqual(0)
    expect(rows[0].toolFailures).toEqual({ always_fails: 1 })
  })

  it('omits toolFailures entirely on a turn where no tool failed', async () => {
    await runTurnWithId('chat-clean-tools')
    const rows = readTurns()
    expect(rows).toHaveLength(1)
    expect(rows[0].toolFailures).toBeUndefined()
    expect(rows[0].completionTokens).toBe(0) // DoneConnection never emits a usage chunk
  })
})
