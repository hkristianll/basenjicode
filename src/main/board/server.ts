// In-process ticket board: the same store with four faces — REST (/api, used by raid/hermes), MCP (/mcp,
// for Claude Code), SSE (/events, the live web board), and the static board UI (/). Ported from the
// standalone ticket-board server.js to run INSIDE NordCode's main process, so the app is self-contained
// (no external folder/app). The store (db.js) and MCP face (mcp.js) are copied verbatim; only this HTTP
// layer is rewritten to take dbPath/publicDir/port as params instead of import.meta + env.
//
// Binds to loopback only. No auth: a single-user localhost tool; not being reachable off-machine is the
// security boundary (same posture as the original).
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, normalize, sep } from 'node:path'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { createStore, ValidationError, NotFoundError, ConflictError, type BoardStore } from './db.js'
import { buildMcpServer } from './mcp.js'

const MAX_BODY = 2 * 1024 * 1024 // 2 MB request cap
const SSE_KEEPALIVE_MS = 45_000
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
}

type Req = http.IncomingMessage
type Res = http.ServerResponse

/** Keep an already-open SSE response active across proxy/server idle windows. The MCP SDK owns its GET
 *  response body, but SSE comments may safely share that stream and are ignored by protocol clients. */
function startSseKeepalive(res: Res): () => void {
  let stopped = false
  const beat = setInterval(() => {
    if (res.destroyed || res.writableEnded) return
    try {
      res.write(':ka\n\n')
    } catch {
      stop()
    }
  }, SSE_KEEPALIVE_MS)
  beat.unref()
  const stop = (): void => {
    if (stopped) return
    stopped = true
    clearInterval(beat)
  }
  res.once('close', stop)
  res.once('error', stop)
  res.once('finish', stop)
  return stop
}

function send(res: Res, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
  res.end(data)
}

function httpStatusFor(e: unknown): number {
  if (e instanceof ValidationError) return 400
  if (e instanceof NotFoundError) return 404
  if (e instanceof ConflictError) return 409
  return 500
}

// Browser-attack guard: non-browser clients (Claude, NordCode, curl) send no Origin and pass. A web page
// can reach 127.0.0.1, but the browser stamps its Origin — reject anything not loopback.
function originOk(req: Req): boolean {
  const o = req.headers.origin
  if (!o) return true
  try {
    const h = new URL(o).hostname
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
  } catch {
    return false
  }
}

function readBody(req: Req): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new ValidationError('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req: Req): Promise<Record<string, unknown>> {
  const buf = await readBody(req)
  if (!buf.length) return {}
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw new ValidationError('invalid JSON body')
  }
}

export interface BoardServerHandle {
  close: () => Promise<void>
  store: BoardStore
  port: number
}

/**
 * Start the in-process board. Resolves once the server is listening. `publicDir` is where the web board's
 * static files live (shipped via extraResources); `dbPath` is a writable location (userData/board.db).
 */
export function startBoardServer(opts: {
  dbPath: string
  publicDir: string
  port?: number
  host?: string
  log?: (msg: string) => void
}): Promise<BoardServerHandle> {
  const PORT = opts.port ?? 8930
  const HOST = opts.host ?? '127.0.0.1'
  const PUBLIC = opts.publicDir
  const store = createStore(opts.dbPath)

  // ---------- MCP (Streamable HTTP, session-aware) ----------
  const mcpSessions = new Map<string, StreamableHTTPServerTransport>() // least→most recently used
  const MAX_SESSIONS = 64
  function bumpSession(sid: string): StreamableHTTPServerTransport | undefined {
    const t = mcpSessions.get(sid)
    if (t) {
      mcpSessions.delete(sid)
      mcpSessions.set(sid, t)
    }
    return t
  }

  async function handleMcp(req: Req, res: Res): Promise<void> {
    const sid = req.headers['mcp-session-id'] as string | undefined
    if (req.method === 'POST') {
      let body: Record<string, unknown>
      try {
        body = await readJson(req)
      } catch (e) {
        return send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: (e as Error).message }, id: null })
      }
      let transport: StreamableHTTPServerTransport | undefined
      if (sid && mcpSessions.has(sid)) {
        transport = bumpSession(sid)
      } else if (!sid && isInitializeRequest(body)) {
        if (mcpSessions.size >= MAX_SESSIONS) {
          const lru = mcpSessions.keys().next().value
          if (lru) {
            try {
              await mcpSessions.get(lru)?.close()
            } catch {
              /* ignore */
            }
            mcpSessions.delete(lru)
          }
        }
        const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id: string) => {
            mcpSessions.set(id, t)
          },
          onsessionclosed: (id: string) => {
            mcpSessions.delete(id)
          }
        })
        t.onclose = () => {
          if (t.sessionId) mcpSessions.delete(t.sessionId)
        }
        await buildMcpServer(store).connect(t)
        transport = t
      } else {
        return send(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'No valid session id for non-initialize request' }, id: null })
      }
      try {
        await transport!.handleRequest(req, res, body)
        return
      } catch (e) {
        if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: (e as Error).message }, id: null })
        return
      }
    }
    if (req.method === 'GET') {
      if (!sid || !mcpSessions.has(sid)) return send(res, 400, { error: 'invalid or missing session id' })
      // The default Node timeouts concern request/header receipt rather than a live response, but explicitly
      // disable socket inactivity for this long-lived stream. Normal REST requests retain the server defaults.
      req.setTimeout(0)
      res.setTimeout(0)
      const stopKeepalive = startSseKeepalive(res)
      try {
        await bumpSession(sid)!.handleRequest(req, res)
      } finally {
        if (res.destroyed || res.writableEnded) stopKeepalive()
      }
      return
    }
    if (req.method === 'DELETE') {
      if (!sid || !mcpSessions.has(sid)) return send(res, 400, { error: 'invalid or missing session id' })
      await bumpSession(sid)!.handleRequest(req, res)
      return
    }
    return send(res, 405, { error: 'method not allowed' }, { Allow: 'GET, POST, DELETE' })
  }

  // ---------- SSE ----------
  let sseCount = 0
  const MAX_SSE = 64
  function handleEvents(req: Req, res: Res): void {
    if (sseCount >= MAX_SSE) return send(res, 503, { error: 'too many live connections' })
    sseCount++
    req.setTimeout(0)
    res.setTimeout(0)
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' })
    res.write(`event: hello\ndata: {"ok":true}\n\n`)
    const unsub = store.subscribe((evt) => {
      res.write(`event: change\ndata: ${JSON.stringify(evt)}\n\n`)
    })
    const stopKeepalive = startSseKeepalive(res)
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      stopKeepalive()
      unsub()
      sseCount--
    }
    req.once('aborted', close)
    res.once('close', close)
    res.once('error', close)
  }

  // ---------- REST ----------
  async function handleApi(req: Req, res: Res, url: URL): Promise<void> {
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean)
    const qp = url.searchParams
    try {
      if (parts[0] === 'health') return send(res, 200, { ok: true, db: opts.dbPath })
      if (parts[0] === 'tickets') {
        if (parts.length === 1 && req.method === 'GET') {
          return send(res, 200, store.listTickets({ project: qp.get('project') || undefined, status: qp.get('status') || undefined }))
        }
        if (parts.length === 1 && req.method === 'POST') {
          return send(res, 201, store.addTicket(await readJson(req)))
        }
        const id = Number(parts[1])
        if (parts.length === 2 && req.method === 'GET') return send(res, 200, store.getTicket(id))
        if (parts.length === 2 && req.method === 'PATCH') return send(res, 200, store.updateTicket(id, await readJson(req)))
        if (parts[2] === 'status' && req.method === 'POST') {
          const { status, note, author } = await readJson(req)
          return send(res, 200, store.updateStatus(id, status as string, { note: note as string, author: author as string }))
        }
        if (parts[2] === 'claim' && req.method === 'POST') {
          const { assignee } = await readJson(req)
          return send(res, 200, store.claim(id, assignee as string))
        }
        if (parts[2] === 'comment' && req.method === 'POST') {
          const { author, text } = await readJson(req)
          return send(res, 200, store.comment(id, author as string, text as string))
        }
        if (parts[2] === 'dependency' && req.method === 'POST') {
          const { depends_on } = await readJson(req)
          return send(res, 200, store.addDependency(id, depends_on as number))
        }
      }
      if (parts[0] === 'claim-next' && req.method === 'POST') {
        const { project, assignee } = await readJson(req)
        return send(res, 200, store.claimNext({ project: project as string, assignee: assignee as string }))
      }
      if (parts[0] === 'next-ready' && req.method === 'GET') {
        return send(res, 200, store.nextReady({ project: qp.get('project') || undefined }))
      }
      if (parts[0] === 'summary' && req.method === 'GET') {
        return send(res, 200, store.summary({ project: qp.get('project') || undefined }))
      }
      if (parts[0] === 'projects' && req.method === 'GET') {
        return send(res, 200, store.projects())
      }
      if (parts[0] === 'spec') {
        if (req.method === 'GET') return send(res, 200, store.getSpec(qp.get('project') || undefined))
        if (req.method === 'POST') return send(res, 200, store.setSpec(await readJson(req)))
      }
      return send(res, 404, { error: 'no such endpoint' })
    } catch (e) {
      return send(res, httpStatusFor(e), { error: (e as Error).message })
    }
  }

  // ---------- static board ----------
  async function handleStatic(_req: Req, res: Res, url: URL): Promise<void> {
    const rel = url.pathname === '/' ? '/index.html' : url.pathname
    const filePath = normalize(join(PUBLIC, rel))
    if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + sep)) return send(res, 403, { error: 'forbidden' })
    try {
      const data = await readFile(filePath)
      const ext = filePath.slice(filePath.lastIndexOf('.'))
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
      res.end(data)
    } catch {
      send(res, 404, { error: 'not found' })
    }
  }

  const server = http.createServer(async (req: Req, res: Res) => {
    let url: URL
    try {
      url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
    } catch {
      return send(res, 400, { error: 'bad url' })
    }
    if (!originOk(req)) return send(res, 403, { error: 'cross-origin request rejected' })
    if (url.pathname === '/mcp') return handleMcp(req, res)
    if (url.pathname === '/events') return handleEvents(req, res)
    if (url.pathname.startsWith('/api')) return handleApi(req, res, url)
    return handleStatic(req, res, url)
  })

  return new Promise<BoardServerHandle>((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, HOST, () => {
      server.off('error', reject)
      const addr = server.address()
      const actual = addr && typeof addr === 'object' ? addr.port : PORT
      opts.log?.(`In-process ticket board listening on http://${HOST}:${actual} (db=${opts.dbPath})`)
      resolve({
        port: actual,
        store,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => {
              // Release the SQLite handle too, so the DB file isn't left locked (matters for tests/shutdown).
              try {
                ;(store.db as { close?: () => void }).close?.()
              } catch {
                /* ignore */
              }
              res()
            })
          })
      })
    })
  })
}
