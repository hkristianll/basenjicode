import http from 'node:http'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBoardServer, type BoardServerHandle } from './server'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'

// End-to-end smoke test of the in-process board over real HTTP — proves the REST face raid/hermes depend on
// works without any external app/folder. Uses an ephemeral port (0) and a temp DB + public dir.
describe('in-process board server (REST)', () => {
  let h: BoardServerHandle
  let dir: string
  let base: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'board-srv-'))
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>board</title>')
    h = await startBoardServer({ dbPath: join(dir, 'board.db'), publicDir: dir, port: 0 })
    base = `http://127.0.0.1:${h.port}`
  })
  afterAll(async () => {
    await h.close()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows can hold the file handle briefly after close — a leftover temp dir is harmless. */
    }
  })

  const json = async (path: string, init?: RequestInit): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}${path}`, init)
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  const openStream = (
    path: string,
    headers: Record<string, string> = {}
  ): Promise<{ req: http.ClientRequest; res: http.IncomingMessage; chunks: string[] }> =>
    new Promise((resolve, reject) => {
      const chunks: string[] = []
      const req = http.get(`${base}${path}`, { headers }, (res) => {
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => chunks.push(chunk))
        resolve({ req, res, chunks })
      })
      req.once('error', reject)
    })

  const disconnect = async (req: http.ClientRequest, res: http.IncomingMessage): Promise<void> => {
    const closed = new Promise<void>((resolve) => {
      if (res.closed) resolve()
      else res.once('close', () => resolve())
    })
    req.destroy()
    await closed
    await vi.advanceTimersByTimeAsync(0)
  }

  it('starts empty: /api/projects and /api/summary', async () => {
    expect((await json('/api/projects')).body).toEqual([])
    const sum = await json('/api/summary')
    expect(sum.status).toBe(200)
    expect(sum.body.total).toBe(0)
  })

  it('adds a ticket, lists it as ready, then claim-next claims it', async () => {
    const add = await json('/api/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'p1', title: 'do the thing' })
    })
    expect(add.status).toBe(201)
    expect(add.body.id).toBeGreaterThan(0)
    expect(add.body.status).toBe('todo')

    const list = await json('/api/tickets?project=p1')
    expect(list.body).toHaveLength(1)
    expect(list.body[0].ready).toBe(true)

    const claimed = await json('/api/claim-next', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'p1', assignee: 'tester' })
    })
    expect(claimed.body.status).toBe('in_progress')
    expect(claimed.body.assignee).toBe('tester')

    expect((await json('/api/projects')).body).toEqual(['p1'])
    expect((await json('/api/summary?project=p1')).body.in_progress).toBe(1)
  })

  it('a dependency blocks a ticket until the upstream is done', async () => {
    const a = await json('/api/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'p2', title: 'upstream' })
    })
    const b = await json('/api/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'p2', title: 'downstream', deps: [a.body.id] })
    })
    expect(b.body.id).toBeGreaterThan(0)
    // downstream is blocked → claim-next returns the upstream, not the downstream
    const first = await json('/api/claim-next', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'p2', assignee: 't' })
    })
    expect(first.body.id).toBe(a.body.id)
    // mark upstream done → downstream becomes claimable
    await json(`/api/tickets/${a.body.id}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' })
    })
    const second = await json('/api/claim-next', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'p2', assignee: 't' })
    })
    expect(second.body.id).toBe(b.body.id)
  })

  it('serves the static board UI at /', async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('board')
  })

  it('keeps an idle /events SSE connection alive and clears its interval on disconnect', async () => {
    vi.useFakeTimers()
    let stream: Awaited<ReturnType<typeof openStream>> | undefined
    try {
      stream = await openStream('/events')
      expect(stream.chunks.join('')).toContain('event: hello')

      await vi.advanceTimersByTimeAsync(45_000)
      expect(stream.chunks.join('')).toContain(':ka\n\n')

      // Platform-robust cleanup assertion: socket-close event ordering differs between OSes (a
      // node-internal timer can linger briefly on Linux), so assert the BEHAVIOR — the keepalive
      // interval is gone (count strictly drops) and no further :ka ever lands after the close.
      const timersBefore = vi.getTimerCount()
      const lenAtClose = stream.chunks.join('').length
      await disconnect(stream.req, stream.res)
      await vi.advanceTimersByTimeAsync(90_000)
      expect(stream.chunks.join('').length).toBe(lenAtClose)
      expect(vi.getTimerCount()).toBeLessThan(timersBefore)
      stream = undefined
    } finally {
      if (stream) stream.req.destroy()
      vi.useRealTimers()
    }
  })

  it('keeps an idle MCP GET stream alive beyond 6 minutes and clears its interval', async () => {
    const init = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'board-server-test', version: '1.0.0' }
        }
      })
    })
    expect(init.status).toBe(200)
    const sessionId = init.headers.get('mcp-session-id')
    expect(sessionId).toBeTruthy()
    await init.arrayBuffer()

    vi.useFakeTimers()
    let stream: Awaited<ReturnType<typeof openStream>> | undefined
    try {
      stream = await openStream('/mcp', {
        accept: 'text/event-stream',
        'mcp-session-id': sessionId!,
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION
      })

      await vi.advanceTimersByTimeAsync(6 * 60_000 + 1)
      expect(stream.res.closed).toBe(false)
      expect(stream.chunks.join('').match(/:ka\n\n/g)?.length).toBeGreaterThanOrEqual(8)

      // Same platform-robust cleanup assertion as the /events test (see comment there).
      const timersBefore = vi.getTimerCount()
      const lenAtClose = stream.chunks.join('').length
      await disconnect(stream.req, stream.res)
      await vi.advanceTimersByTimeAsync(90_000)
      expect(stream.chunks.join('').length).toBe(lenAtClose)
      expect(vi.getTimerCount()).toBeLessThan(timersBefore)
      stream = undefined
    } finally {
      if (stream) stream.req.destroy()
      vi.useRealTimers()
    }
  })
})
