import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatStreamParams } from './lmstudio'

// Mock the OpenAI SDK + the model-reload primitives so we can drive chatStream's eviction recovery without a server.
const { create, ensureModelLoadedMock, fetchLoadedModelIdsMock } = vi.hoisted(() => ({
  create: vi.fn(),
  ensureModelLoadedMock: vi.fn(),
  fetchLoadedModelIdsMock: vi.fn()
}))
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create } }
    models = { list: vi.fn() }
  }
}))
vi.mock('../lmstudio/loadModel', () => ({ ensureModelLoaded: ensureModelLoadedMock, fetchLoadedModelIds: fetchLoadedModelIdsMock }))

import { OpenAICompatClient, isModelUnloadedError, isStreamingUnsupportedError, toOpenAIMessages } from './lmstudio'
import type { ChatMessage } from '../../shared/domain-types'

describe('toOpenAIMessages — multimodal (vision)', () => {
  it('a user message WITH images becomes multimodal content (text part + image_url parts) so a vision model sees it', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'look at this', images: ['data:image/png;base64,AAAA'] }]
    const out = toOpenAIMessages(msgs)
    expect(out[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
      ]
    })
  })
  it('a text-only user message stays a plain string (no needless multimodal wrapping)', () => {
    const out = toOpenAIMessages([{ role: 'user', content: 'hi' }] as ChatMessage[])
    expect(out[0]).toEqual({ role: 'user', content: 'hi' })
  })
})

describe('isModelUnloadedError', () => {
  it('matches LM Studio eviction messages (Error and nested {error:{message}})', () => {
    expect(isModelUnloadedError(new Error('Model is unloaded'))).toBe(true)
    expect(isModelUnloadedError(new Error('the model is not loaded'))).toBe(true)
    expect(isModelUnloadedError(new Error('No models loaded'))).toBe(true)
    expect(isModelUnloadedError({ error: { message: 'model_not_found' } })).toBe(true)
  })
  it('matches the model-swap/removal 404 phrasings (W1c)', () => {
    expect(isModelUnloadedError(new Error("model 'qwen3.6-27b' not found"))).toBe(true)
    expect(isModelUnloadedError(new Error('404 no such model'))).toBe(true)
    expect(isModelUnloadedError({ error: { message: 'The model `foo` does not exist' } })).toBe(true)
    expect(isModelUnloadedError({ error: { code: 'model_not_found', message: 'nope' } })).toBe(true)
  })
  it('does not match unrelated errors', () => {
    expect(isModelUnloadedError(new Error('ECONNREFUSED'))).toBe(false)
    expect(isModelUnloadedError(new Error('rate limit exceeded'))).toBe(false)
    expect(isModelUnloadedError(new Error('404 page not found'))).toBe(false)
    expect(isModelUnloadedError(null)).toBe(false)
    expect(isModelUnloadedError(undefined)).toBe(false)
  })
})

describe('OpenAICompatClient.chatStream — mid-run model-eviction recovery', () => {
  const params = (): ChatStreamParams => ({
    model: 'm',
    messages: [],
    tools: [],
    temperature: 0,
    maxTokens: null,
    signal: new AbortController().signal
  })
  beforeEach(() => {
    create.mockReset()
    ensureModelLoadedMock.mockReset()
    fetchLoadedModelIdsMock.mockReset().mockResolvedValue(null) // "unknown" unless a test says otherwise
  })

  it('reloads the model and retries ONCE when the call fails with an unloaded error', async () => {
    const fakeStream = { controller: new AbortController(), async *[Symbol.asyncIterator]() {} }
    create.mockRejectedValueOnce(new Error('Model is unloaded')).mockResolvedValueOnce(fakeStream)
    ensureModelLoadedMock.mockResolvedValue({ ctx: 80_000, reloaded: true })
    const client = new OpenAICompatClient({ baseURL: 'http://localhost:1234/v1' })

    const out = await client.chatStream(params())
    expect(out).toBe(fakeStream)
    expect(ensureModelLoadedMock).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('does NOT reload/retry on an unrelated error', async () => {
    create.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const client = new OpenAICompatClient({ baseURL: 'http://localhost:1234/v1' })

    await expect(client.chatStream(params())).rejects.toThrow('ECONNREFUSED')
    expect(ensureModelLoadedMock).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledOnce()
  })

  it('propagates the error if the post-reload retry also fails (no infinite loop)', async () => {
    create.mockRejectedValue(new Error('Model is unloaded'))
    ensureModelLoadedMock.mockResolvedValue({ ctx: null, reloaded: false })
    const client = new OpenAICompatClient({ baseURL: 'http://localhost:1234/v1' })

    await expect(client.chatStream(params())).rejects.toThrow('unloaded')
    expect(create).toHaveBeenCalledTimes(2) // original + one retry, then give up
  })

  it('follows an unambiguous model swap: configured model gone, exactly one other loaded (W1c)', async () => {
    const fakeStream = { controller: new AbortController(), async *[Symbol.asyncIterator]() {} }
    create
      .mockRejectedValueOnce(new Error("model 'm' not found"))
      .mockRejectedValueOnce(new Error("model 'm' not found"))
      .mockResolvedValueOnce(fakeStream)
    ensureModelLoadedMock.mockResolvedValue({ ctx: null, reloaded: false })
    fetchLoadedModelIdsMock.mockResolvedValue(['qwen3.6-27b-mtp'])
    const notices: string[] = []
    const client = new OpenAICompatClient({ baseURL: 'http://localhost:1234/v1' })

    const out = await client.chatStream({ ...params(), onNotice: (t) => notices.push(t) })
    expect(out).toBe(fakeStream)
    expect(create).toHaveBeenCalledTimes(3)
    expect(create.mock.calls[2][0].model).toBe('qwen3.6-27b-mtp') // the retry targets the loaded model
    expect(notices.some((n) => n.includes('qwen3.6-27b-mtp'))).toBe(true)
  })

  it('does NOT guess when several models are loaded — the swap is ambiguous', async () => {
    create.mockRejectedValue(new Error("model 'm' not found"))
    ensureModelLoadedMock.mockResolvedValue({ ctx: null, reloaded: false })
    fetchLoadedModelIdsMock.mockResolvedValue(['a-model', 'b-model'])
    const client = new OpenAICompatClient({ baseURL: 'http://localhost:1234/v1' })

    await expect(client.chatStream(params())).rejects.toThrow('not found')
    expect(create).toHaveBeenCalledTimes(2) // no third attempt against a guessed model
  })

  it('the same swap recovery applies to the non-streaming chatComplete path', async () => {
    create
      .mockRejectedValueOnce(new Error('model_not_found'))
      .mockRejectedValueOnce(new Error('model_not_found'))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] })
    ensureModelLoadedMock.mockResolvedValue({ ctx: null, reloaded: false })
    fetchLoadedModelIdsMock.mockResolvedValue(['only-model'])
    const client = new OpenAICompatClient({ baseURL: 'http://localhost:1234/v1' })

    const out = await client.chatComplete(params())
    expect(out.choices[0].message.content).toBe('x')
    expect(create.mock.calls[2][0].model).toBe('only-model')
  })
})

describe('text-tool-call mode withholds the native tool schema', () => {
  const tool = { type: 'function', function: { name: 'read_file', parameters: {} } } as never
  const p = (extra: Partial<ChatStreamParams>): ChatStreamParams => ({
    model: 'm',
    messages: [],
    tools: [tool],
    temperature: 0,
    maxTokens: null,
    signal: new AbortController().signal,
    ...extra
  })
  beforeEach(() => create.mockReset())

  it('sends native tools by default (preferTextToolCalls unset)', async () => {
    create.mockResolvedValueOnce({ controller: new AbortController(), async *[Symbol.asyncIterator]() {} })
    await new OpenAICompatClient({ baseURL: 'http://localhost:1234/v1' }).chatStream(p({}))
    const body = create.mock.calls[0][0]
    expect(body.tools).toBeDefined()
    expect(body.tool_choice).toBe('auto')
  })

  it('drops native tools + tool_choice when preferTextToolCalls is true (forces <tool_call> text)', async () => {
    create.mockResolvedValueOnce({ controller: new AbortController(), async *[Symbol.asyncIterator]() {} })
    await new OpenAICompatClient({ baseURL: 'http://localhost:1234/v1' }).chatStream(p({ preferTextToolCalls: true }))
    const body = create.mock.calls[0][0]
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
  })

  it('the same gate applies to the non-streaming chatComplete path', async () => {
    create.mockResolvedValueOnce({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] })
    await new OpenAICompatClient({ baseURL: 'http://localhost:1234/v1' }).chatComplete(p({ preferTextToolCalls: true }))
    expect(create.mock.calls[0][0].tools).toBeUndefined()
  })
})

describe('isStreamingUnsupportedError', () => {
  it('matches messages that say streaming is not supported / disabled', () => {
    expect(isStreamingUnsupportedError(new Error('streaming is not supported by this endpoint'))).toBe(true)
    expect(isStreamingUnsupportedError(new Error('stream mode is disabled'))).toBe(true)
    expect(isStreamingUnsupportedError({ error: { message: 'This model does not support streaming' } })).toBe(true)
  })
  it('does NOT match unrelated errors (so we never wrongly drop to non-streaming)', () => {
    expect(isStreamingUnsupportedError(new Error('ECONNREFUSED'))).toBe(false)
    expect(isStreamingUnsupportedError(new Error('rate limit exceeded'))).toBe(false)
    expect(isStreamingUnsupportedError(new Error('model is unloaded'))).toBe(false) // a different recovery path
    expect(isStreamingUnsupportedError(null)).toBe(false)
  })
})

describe('OpenAICompatClient.chatComplete — non-streaming fallback path', () => {
  const params = (): ChatStreamParams => ({
    model: 'm',
    messages: [],
    tools: [],
    temperature: 0,
    maxTokens: null,
    signal: new AbortController().signal
  })
  beforeEach(() => {
    create.mockReset()
    ensureModelLoadedMock.mockReset()
    fetchLoadedModelIdsMock.mockReset().mockResolvedValue(null) // "unknown" unless a test says otherwise
  })

  it('requests a NON-streaming completion (stream:false) and returns it', async () => {
    const completion = { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }
    create.mockResolvedValueOnce(completion)
    const client = new OpenAICompatClient({ baseURL: 'http://localhost:1234/v1' })

    const out = await client.chatComplete(params())
    expect(out).toBe(completion)
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0][0]).toMatchObject({ stream: false })
  })

  it('reloads + retries once on a model-eviction error, like the streaming path', async () => {
    const completion = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }
    create.mockRejectedValueOnce(new Error('Model is unloaded')).mockResolvedValueOnce(completion)
    ensureModelLoadedMock.mockResolvedValue({ ctx: 80_000, reloaded: true })
    const client = new OpenAICompatClient({ baseURL: 'http://localhost:1234/v1' })

    expect(await client.chatComplete(params())).toBe(completion)
    expect(ensureModelLoadedMock).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledTimes(2)
  })
})
