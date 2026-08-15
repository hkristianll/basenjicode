// Loop board data provider — runs in MAIN so requests carry no Origin header and pass the board's
// origin guard (server.js originOk: a renderer fetch from file:// would send Origin "null" → 403).
// REST for snapshots, a single SSE consumer for live "something changed" pings forwarded to the renderer.
import http from 'node:http'
import type { BoardTicketRow, BoardCounts, LoopBoardData } from '../shared/ipc-types'

const BOARD_URL = (process.env.TICKET_BOARD_URL || 'http://127.0.0.1:8930').replace(/\/+$/, '')
const ME = process.env.TICKET_BOARD_ASSIGNEE || 'nordcode'

async function boardGet<T>(path: string): Promise<T> {
  const res = await fetch(BOARD_URL + path) // main-process fetch adds no Origin → passes the board's guard
  if (!res.ok) throw new Error(`board HTTP ${res.status}`)
  return (await res.json()) as T
}

// POST helper — main-process fetch (no Origin) so it clears the board's cross-origin guard, with the same
// error surfacing as boardGet. Used by Hermes to author/repair the board (decompose + replan write here).
async function boardPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(BOARD_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error((data as { error?: string }).error || `board HTTP ${res.status}`)
  return data
}

/** A ticket the orchestrator wants created. `deps` are REAL board ids and must already exist (the board
 *  rejects a dep to a missing ticket), so callers create scaffold-first in topological order. */
export interface NewTicket {
  project: string
  title: string
  body?: string
  /** Shell command the check-gate runs to verify this ticket — Hermes authors one per ticket. */
  check?: string
  deps?: number[]
  priority?: number
  spec_ref?: string
}

/** Create a ticket. Returns the created row (with its assigned `id`), so callers can map a decompose
 *  plan's local indices → real ids and wire later tickets' deps to it. */
export function addTicket(t: NewTicket): Promise<BoardTicketRow> {
  return boardPost<BoardTicketRow>('/api/tickets', t)
}

/** Add a dependency edge (id depends on dependsOn). The board cycle-checks and de-dupes. */
export function addDependency(id: number, dependsOn: number): Promise<BoardTicketRow> {
  return boardPost<BoardTicketRow>(`/api/tickets/${id}/dependency`, { depends_on: dependsOn })
}

/** Set a ticket's status (+ optional note recorded as a comment). The reopen-review lever and the
 *  replan loop both drive the board through this. */
export function setStatus(id: number, status: string, note?: string): Promise<BoardTicketRow> {
  return boardPost<BoardTicketRow>(`/api/tickets/${id}/status`, { status, note, author: ME })
}

/** Edit a ticket's content IN PLACE (title/body/check/priority) via PATCH — lets the orchestrator FIX a broken or
 *  impossible check (or refine scope) instead of cancelling + re-filing a duplicate (the re-file churn). Only the
 *  provided fields change; status/deps are untouched. */
export async function updateTicket(
  id: number,
  fields: { title?: string; body?: string; check?: string; priority?: number }
): Promise<BoardTicketRow> {
  const res = await fetch(`${BOARD_URL}/api/tickets/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields)
  })
  const data = (await res.json().catch(() => ({}))) as BoardTicketRow & { error?: string }
  if (!res.ok) throw new Error(data.error || `board HTTP ${res.status}`)
  return data
}

/** Upsert the project-level spec (shared truth the decompose turn writes and the replan turn reads). */
export function setSpec(project: string, content: string, title?: string): Promise<unknown> {
  return boardPost('/api/spec', { project, content, title })
}

/** Read the project-level spec back (null if none). */
export function getSpec(project: string): Promise<{ project: string; title: string | null; content: string } | null> {
  return boardGet(`/api/spec?project=${encodeURIComponent(project)}`)
}

/** Decorated tickets for one project (optionally filtered by status, incl. derived ready/blocked). The
 *  replan turn reads the live graph through this. */
export function fetchTickets(project: string, status?: string): Promise<BoardTicketRow[]> {
  const q = new URLSearchParams({ project })
  if (status) q.set('status', status)
  return boardGet<BoardTicketRow[]>(`/api/tickets?${q}`)
}

/** Tickets (decorated with ready/blocked) + summary counts for one project. */
export async function fetchBoard(project: string): Promise<LoopBoardData> {
  const q = `?project=${encodeURIComponent(project)}`
  const [tickets, counts] = await Promise.all([
    boardGet<BoardTicketRow[]>(`/api/tickets${q}`),
    boardGet<BoardCounts>(`/api/summary${q}`)
  ])
  return { tickets, counts }
}

/** Distinct project names on the board (for the loops rail). */
export function fetchProjects(): Promise<string[]> {
  return boardGet<string[]>('/api/projects')
}

/** Post a comment on a ticket (the per-ticket reply box). Best-effort; surfaces a throw to the caller. */
export async function postComment(id: number, text: string): Promise<void> {
  const res = await fetch(`${BOARD_URL}/api/tickets/${id}/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ author: 'nordcode', text })
  })
  if (!res.ok) throw new Error(`board HTTP ${res.status}`)
}

/**
 * One shared SSE consumer in main. Calls onChange() on every board `change` event and reconnects on
 * drop. Returns an unsubscribe. The board never serves the full board over SSE — just a change signal —
 * so the renderer re-fetches via fetchBoard() when this fires.
 */
export function subscribeBoardChanges(onChange: () => void): () => void {
  const url = new URL(BOARD_URL + '/events')
  let closed = false
  let req: http.ClientRequest | null = null
  let retry: ReturnType<typeof setTimeout> | null = null

  const scheduleReconnect = (): void => {
    if (closed || retry) return
    retry = setTimeout(() => {
      retry = null
      connect()
    }, 1500)
  }

  const connect = (): void => {
    if (closed) return
    req = http.get(
      { hostname: url.hostname, port: url.port, path: url.pathname, headers: { Accept: 'text/event-stream' } },
      (res) => {
        res.setEncoding('utf8')
        let buf = ''
        res.on('data', (chunk: string) => {
          buf += chunk
          let i: number
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i)
            buf = buf.slice(i + 2)
            if (/^event:\s*change/m.test(block)) onChange()
          }
        })
        res.on('end', scheduleReconnect)
        res.on('error', scheduleReconnect)
      }
    )
    req.on('error', scheduleReconnect)
  }

  connect()
  return () => {
    closed = true
    if (retry) clearTimeout(retry)
    try {
      req?.destroy()
    } catch {
      /* already gone */
    }
  }
}
