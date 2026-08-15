import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ROOT = path.join(os.tmpdir(), 'nordcode-stream-resume-test')

vi.mock('electron', () => ({ app: { getPath: () => ROOT } }))

import { AgentSession } from './loop'
import { ToolRegistry } from './registry'
import type { ChatChunk, ChatCompletion, ChatStreamParams, LLMConnection } from './lmstudio'
import type { AgentEvent } from '../../shared/ipc-types'

// ---- scripted fake connection ------------------------------------------------------------------

const textChunk = (t: string): ChatChunk => ({ choices: [{ delta: { content: t } }] }) as unknown as ChatChunk
const reasoningChunk = (t: string): ChatChunk =>
  ({ choices: [{ delta: { reasoning_content: t } }] }) as unknown as ChatChunk
const finishChunk = (reason: string): ChatChunk => ({ choices: [{ delta: {}, finish_reason: reason }] }) as unknown as ChatChunk
const toolChunk = (id: string, name: string, args: string): ChatChunk =>
  ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] } }] }) as unknown as ChatChunk

const connReset = (): Error => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })

interface ScriptedStream {
  chunks: ChatChunk[]
  failWith?: Error
  delaysMs?: number[]
}

/** LLMConnection whose chatStream plays one script per call; extra calls get a clean "All done." so a
 *  follow-up nudge (if a heuristic ever fires one) can never hang the test. */
class FakeConnection implements LLMConnection {
  calls: ChatStreamParams[] = []
  constructor(private scripts: ScriptedStream[]) {}

  async listModels(): Promise<string[]> {
    return ['test-model']
  }

  async chatStream(p: ChatStreamParams): Promise<AsyncIterable<ChatChunk> & { controller: AbortController }> {
    this.calls.push(p)
    const script = this.scripts[this.calls.length - 1] ?? { chunks: [textChunk('All done.'), finishChunk('stop')] }
    async function* play(): AsyncGenerator<ChatChunk> {
      for (const [index, c] of script.chunks.entries()) {
        const delayMs = script.delaysMs?.[index] ?? 0
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
        yield c
      }
      if (script.failWith) throw script.failWith
    }
    return Object.assign(play(), { controller: new AbortController() })
  }

  async chatComplete(): Promise<ChatCompletion> {
    throw new Error('chatComplete is not used by these tests')
  }
}

// ---- harness -----------------------------------------------------------------------------------

const runTurn = async (
  conn: FakeConnection
): Promise<{ events: AgentEvent[]; deltas: string; notices: string[]; done: Extract<AgentEvent, { type: 'turn-done' }> }> => {
  const session = new AgentSession({
    id: 'resume-test',
    workspaceRoot: ROOT,
    client: conn,
    registry: new ToolRegistry(),
    config: { model: 'test-model', temperature: 0, maxTokens: 512, maxTurns: 4, contextLimitTokens: 8000 },
    mode: 'ask',
    history: []
  })
  const events: AgentEvent[] = []
  await session.runTurn('please finish explaining the parser fix', 'turn-1', (e) => events.push(e))
  const deltas = events
    .filter((e): e is Extract<AgentEvent, { type: 'assistant-delta' }> => e.type === 'assistant-delta')
    .map((e) => e.text)
    .join('')
  const notices = events
    .filter((e): e is Extract<AgentEvent, { type: 'notice' }> => e.type === 'notice')
    .map((e) => e.text)
  const done = events.find((e): e is Extract<AgentEvent, { type: 'turn-done' }> => e.type === 'turn-done')
  if (!done) throw new Error('turn never finished')
  return { events, deltas, notices, done }
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(ROOT, { recursive: true })
})

// ---- the W1a acceptance tests ------------------------------------------------------------------

describe('resumable mid-stream recovery (W1a)', () => {
  it('resumes after a mid-stream drop, prefills the partial, and never double-emits', async () => {
    const committed = 'The fix lives in the parser: it drops the trailing comma'
    const conn = new FakeConnection([
      // Attempt 1: two deltas, then the socket dies.
      { chunks: [textChunk('The fix lives in the parser: '), textChunk('it drops the trailing comma')], failWith: connReset() },
      // Attempt 2: the model restarts from inside its own text (as weak models do) and finishes.
      { chunks: [textChunk('it drops the trailing comma'), textChunk(' before the close brace. All done.'), finishChunk('stop')] }
    ])

    const { deltas, notices, done } = await runTurn(conn)

    expect(conn.calls).toHaveLength(2)
    // The resumed request carries the partial back as the assistant's own words + the continue steer.
    const resumed = conn.calls[1].messages
    expect(resumed[resumed.length - 2]).toMatchObject({ role: 'assistant', content: committed })
    expect(resumed[resumed.length - 1].role).toBe('system')
    expect(resumed[resumed.length - 1].content).toMatch(/cut off mid-stream/i)
    // The UI saw the full sentence exactly once — the regenerated overlap was de-duplicated.
    expect(deltas).toBe('The fix lives in the parser: it drops the trailing comma before the close brace. All done.')
    expect(notices.some((n) => /resuming/i.test(n))).toBe(true)
    expect(done.stopReason).toBe('completed')
  })

  it('ends the turn as a clean error once the resume budget is spent', async () => {
    const fail = (): ScriptedStream => ({ chunks: [textChunk('partial ')], failWith: connReset() })
    const conn = new FakeConnection([fail(), fail(), fail()])

    const { notices, done } = await runTurn(conn)

    expect(conn.calls).toHaveLength(3) // initial + MAX_STREAM_RESUMES
    expect(notices.filter((n) => /resuming/i.test(n))).toHaveLength(2)
    expect(done.stopReason).toBe('error')
  })

  it('does not resume when native tool-call deltas are in flight (args cannot be stitched)', async () => {
    const conn = new FakeConnection([
      { chunks: [toolChunk('c1', 'write_file', '{"path":"a.txt","content":"par')], failWith: connReset() }
    ])

    const { done, notices } = await runTurn(conn)

    expect(conn.calls).toHaveLength(1)
    expect(notices.some((n) => /resuming/i.test(n))).toBe(false)
    expect(done.stopReason).toBe('error')
  })

  it('still refuses a length-truncated tool-call batch (no resume, no execution)', async () => {
    const conn = new FakeConnection([
      { chunks: [toolChunk('c1', 'write_file', '{"path":"a.txt","content":"par'), finishChunk('length')] }
    ])

    const { done } = await runTurn(conn)

    expect(conn.calls).toHaveLength(1)
    expect(done.stopReason).toBe('completed')
    expect(done.notice).toMatch(/cut off mid tool-call/i)
  })
})

describe('completion-token accounting (W3c)', () => {
  const usageChunk = (prompt: number, completion: number): ChatChunk =>
    ({ choices: [{ delta: {} }], usage: { prompt_tokens: prompt, completion_tokens: completion } }) as unknown as ChatChunk

  it('the usage event carries cumulative completion tokens for the turn', async () => {
    const conn = new FakeConnection([
      { chunks: [textChunk('All done here.'), usageChunk(120, 7), finishChunk('stop')] }
    ])
    const { events } = await runTurn(conn)
    const usage = events.find((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage')
    expect(usage?.promptTokens).toBe(120)
    expect(usage?.completionTokens).toBe(7)
  })

  it('a server that omits stream usage degrades gracefully (no usage event, turn still completes)', async () => {
    const conn = new FakeConnection([{ chunks: [textChunk('All done here.'), finishChunk('stop')] }])
    const { events, done } = await runTurn(conn)
    expect(done.stopReason).toBe('completed')
    expect(events.some((e) => e.type === 'usage')).toBe(false)
  })
})

describe('thinking progress events (P4a)', () => {
  it('emits throttled cumulative progress for reasoning chunks spread over more than two seconds', async () => {
    const conn = new FakeConnection([
      {
        chunks: [reasoningChunk('a'.repeat(210)), reasoningChunk('b'.repeat(50)), reasoningChunk('c'.repeat(50)), textChunk('All done.'), finishChunk('stop')],
        delaysMs: [0, 1050, 1050, 0, 0]
      }
    ])

    const { events } = await runTurn(conn)
    const progress = events.filter(
      (event): event is Extract<AgentEvent, { type: 'thinking-progress' }> => event.type === 'thinking-progress'
    )

    expect(progress.length).toBeGreaterThanOrEqual(2)
    expect(progress.map((event) => event.chars)).toEqual([210, 260, 310])
    expect(progress.map((event) => event.seconds)).toEqual([0, 1, 2])
    expect(progress.every((event) => !('text' in event))).toBe(true)
  })

  it('emits no thinking progress for a content-only stream', async () => {
    const conn = new FakeConnection([{ chunks: [textChunk('All done.'), finishChunk('stop')] }])

    const { events } = await runTurn(conn)

    expect(events.some((event) => event.type === 'thinking-progress')).toBe(false)
  })
})

describe('ignored reasoning suppression notice (P4b)', () => {
  const longThinking = (): ScriptedStream => ({
    chunks: [reasoningChunk('r'.repeat(2001)), textChunk('All done.'), finishChunk('stop')]
  })
  const ignoredNotice = /ignores the \/no_think reasoning suppression/

  it('warns on the first over-threshold turn but not the second in the same session', async () => {
    const conn = new FakeConnection([longThinking(), longThinking()])
    const session = new AgentSession({
      id: 'reasoning-warning-test',
      workspaceRoot: ROOT,
      client: conn,
      registry: new ToolRegistry(),
      config: {
        model: 'test-model',
        temperature: 0,
        maxTokens: 512,
        maxTurns: 4,
        contextLimitTokens: 8000,
        reasoningEffort: 'off'
      },
      mode: 'ask',
      history: []
    })
    const first: AgentEvent[] = []
    const second: AgentEvent[] = []

    await session.runTurn('first task', 'turn-1', (event) => first.push(event))
    await session.runTurn('second task', 'turn-2', (event) => second.push(event))

    expect(first.filter((event) => event.type === 'notice' && ignoredNotice.test(event.text))).toHaveLength(1)
    expect(second.some((event) => event.type === 'notice' && ignoredNotice.test(event.text))).toBe(false)
  })

  it.each([undefined, 'high' as const])('does not warn when reasoningEffort is %s', async (reasoningEffort) => {
    const conn = new FakeConnection([longThinking()])
    const session = new AgentSession({
      id: 'reasoning-no-warning-test',
      workspaceRoot: ROOT,
      client: conn,
      registry: new ToolRegistry(),
      config: {
        model: 'test-model',
        temperature: 0,
        maxTokens: 512,
        maxTurns: 4,
        contextLimitTokens: 8000,
        reasoningEffort
      },
      mode: 'ask',
      history: []
    })
    const events: AgentEvent[] = []

    await session.runTurn('do the task', 'turn-1', (event) => events.push(event))

    expect(events.some((event) => event.type === 'notice' && ignoredNotice.test(event.text))).toBe(false)
  })
})
