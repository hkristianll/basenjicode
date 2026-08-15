import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { MCPServerConfig } from '../../../shared/domain-types'

// ---- fake SDK + logger --------------------------------------------------------------------------
// The manager is exercised against a controllable fake Client: `behavior` scripts connect outcomes and
// callTool failures, and `instances` exposes onclose so tests can cut the transport.

const { behavior, instances } = vi.hoisted(() => ({
  behavior: { failConnects: 0, callToolError: null as Error | null, tools: [{ name: 'ping', description: 'ping' }] },
  instances: [] as Array<{ onclose?: () => void; onerror?: (e: unknown) => void }>
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class FakeClient {
    onclose?: () => void
    onerror?: (e: unknown) => void
    constructor() {
      instances.push(this)
    }
    async connect(): Promise<void> {
      if (behavior.failConnects > 0) {
        behavior.failConnects--
        throw new Error('fetch failed')
      }
    }
    async listTools(): Promise<{ tools: { name: string; description: string }[] }> {
      return { tools: behavior.tools }
    }
    async callTool(): Promise<{ content: [] }> {
      if (behavior.callToolError) throw behavior.callToolError
      return { content: [] }
    }
    async close(): Promise<void> {}
  }
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: class {}, getDefaultEnvironment: () => ({}) }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {} }))
vi.mock('../../logger', () => ({ log: vi.fn() }))

import { MCPManager, reconnectDelayMs, isMcpTransportError, type TimerImpl } from './manager'

// Manual timer surface: collects scheduled callbacks so tests fire them deterministically.
function manualTimers(): TimerImpl & { pending: Array<{ fn: () => void; ms: number }>; fire: (i?: number) => void } {
  const pending: Array<{ fn: () => void; ms: number }> = []
  return {
    pending,
    set(fn, ms) {
      const entry = { fn, ms }
      pending.push(entry)
      return entry
    },
    clear(handle) {
      const i = pending.indexOf(handle as { fn: () => void; ms: number })
      if (i >= 0) pending.splice(i, 1)
    },
    fire(i = 0) {
      const entry = pending.splice(i, 1)[0]
      entry?.fn()
    }
  }
}

const CFG: MCPServerConfig = { id: 'srv1', label: 'board', transport: 'http', enabled: true, url: 'http://127.0.0.1:8930/mcp' }
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  behavior.failConnects = 0
  behavior.callToolError = null
  instances.length = 0
})

describe('MCPManager auto-reconnect (W1b)', () => {
  it('transport drop → error status → backoff reconnect → connected again + onToolsChanged', async () => {
    const timers = manualTimers()
    const m = new MCPManager(timers)
    const toolsChanged = vi.fn()
    m.onToolsChanged = toolsChanged
    await m.sync([CFG])
    expect(m.statuses()).toMatchObject([{ id: 'srv1', status: 'connected', toolCount: 1 }])

    instances[0].onclose?.() // the server dies
    expect(m.statuses()[0].status).toBe('error')
    expect(timers.pending).toMatchObject([{ ms: 1000 }]) // first retry after 1s

    timers.fire()
    await flush()
    expect(m.statuses()).toMatchObject([{ id: 'srv1', status: 'connected', toolCount: 1 }])
    expect(m.tools().map((t) => t.name)).toEqual(['board__ping']) // tools rediscovered
    expect(toolsChanged).toHaveBeenCalledOnce() // ipc re-syncs the registry
  })

  it('walks the backoff ladder while the server stays down, then settles at the 5-min heartbeat', async () => {
    const timers = manualTimers()
    const m = new MCPManager(timers)
    behavior.failConnects = 99
    await m.sync([CFG])
    expect(m.statuses()[0].status).toBe('error')

    const seen: number[] = []
    for (let i = 0; i < 5; i++) {
      expect(timers.pending).toHaveLength(1) // exactly one pending attempt — no storm
      seen.push(timers.pending[0].ms)
      timers.fire()
      await flush()
    }
    expect(seen).toEqual([1000, 5000, 30000, 300000, 300000])
  })

  it('a tool call against a dropped server returns a retryable error and kicks the reconnect', async () => {
    const timers = manualTimers()
    const m = new MCPManager(timers)
    await m.sync([CFG])
    behavior.callToolError = new Error('Not connected')

    const out = await m.tools()[0].handler({}, {} as never)
    expect(out).toMatch(/^ERROR: MCP server 'board' connection dropped/)
    expect(m.statuses()[0].status).toBe('error')
    expect(timers.pending).toHaveLength(1) // reconnect scheduled

    behavior.callToolError = null
    timers.fire()
    await flush()
    expect(m.statuses()[0].status).toBe('connected')
  })

  it('sync() and dispose() cancel a pending reconnect (a removed server must stay removed)', async () => {
    const timers = manualTimers()
    const m = new MCPManager(timers)
    behavior.failConnects = 99
    await m.sync([CFG])
    expect(timers.pending).toHaveLength(1)

    await m.sync([]) // server removed from settings
    expect(timers.pending).toHaveLength(0)
    expect(m.statuses()).toEqual([])
  })

  it('reconnectDelayMs exposes the ladder', () => {
    expect([0, 1, 2, 3, 9].map(reconnectDelayMs)).toEqual([1000, 5000, 30000, 300000, 300000])
  })

  it('isMcpTransportError separates transport drops from tool-level failures', () => {
    expect(isMcpTransportError(new Error('Not connected'))).toBe(true)
    expect(isMcpTransportError(new Error('fetch failed'))).toBe(true)
    expect(isMcpTransportError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isMcpTransportError(new Error('ticket 42 not found'))).toBe(false)
    expect(isMcpTransportError(new Error('invalid arguments'))).toBe(false)
  })
})
