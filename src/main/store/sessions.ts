import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  sessionSchema,
  type AgentMode,
  type AllowList,
  type ComposerSessionState,
  type Session,
  type SessionMeta,
  type ChatMessage
} from '../../shared/domain-types'
import { writeJsonAtomic } from './settings'
import { deleteSessionSnapshots } from './snapshots'
import { repairTranscript } from '../agent/history'
import type { SessionSearchHit } from '../../shared/ipc-types'

function sessionsDir(): string {
  return path.join(app.getPath('userData'), 'sessions')
}
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function sessionFile(id: string): string {
  // IDs come from the renderer; reject anything that isn't a UUID so `../` can't escape the dir.
  if (!UUID_RE.test(id)) throw new Error(`invalid session id: ${id}`)
  return path.join(sessionsDir(), `${id}.json`)
}
function indexFile(): string {
  return path.join(sessionsDir(), 'index.json')
}

function defaultTitle(cwd: string): string {
  return path.basename(cwd) || 'Session'
}

/** A readable chat title from the first user message: collapse whitespace, strip leading symbols, and
 *  truncate on a word boundary so the sidebar shows clean titles instead of raw mid-word slices. */
function deriveTitle(firstUser: string, cwd: string): string {
  const cleaned = firstUser.replace(/\s+/g, ' ').replace(/^\W+/, '').trim()
  if (!cleaned) return defaultTitle(cwd)
  if (cleaned.length <= 52) return cleaned
  const cut = cleaned.slice(0, 52)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > 24 ? cut.slice(0, sp) : cut).trim()}…`
}

export function listSessions(): SessionMeta[] {
  try {
    const arr = JSON.parse(fs.readFileSync(indexFile(), 'utf8'))
    if (Array.isArray(arr)) return arr as SessionMeta[]
  } catch {
    /* no index yet */
  }
  return []
}

function writeIndex(metas: SessionMeta[]): void {
  writeJsonAtomic(indexFile(), metas)
}

function upsertIndex(meta: SessionMeta): void {
  const metas = listSessions().filter((m) => m.id !== meta.id)
  metas.unshift(meta)
  writeIndex(metas)
}

export function createSession(cwd: string, mode: AgentMode): SessionMeta {
  const now = Date.now()
  const meta: SessionMeta = { id: randomUUID(), title: defaultTitle(cwd), cwd, createdAt: now, updatedAt: now }
  const session: Session = { ...meta, mode, messages: [] }
  writeJsonAtomic(sessionFile(meta.id), session)
  upsertIndex(meta)
  invalidateBodyIndex()
  return meta
}

export function loadSession(id: string): Session | null {
  let text: string
  try {
    text = fs.readFileSync(sessionFile(id), 'utf8')
  } catch {
    return null // missing — not corruption
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    // Migrate pre-mode sessions that stored a boolean planMode.
    if (raw.mode === undefined && 'planMode' in raw) {
      raw.mode = raw.planMode ? 'plan' : 'ask'
    }
    const parsed = sessionSchema.safeParse(raw)
    if (parsed.success) {
      // Heal any transcript left malformed by an older build or an interrupted turn.
      parsed.data.messages = repairTranscript(parsed.data.messages)
      return parsed.data
    }
    quarantine(id) // schema mismatch — set aside instead of silently losing it
  } catch {
    quarantine(id) // unparseable JSON
  }
  return null
}

function quarantine(id: string): void {
  try {
    fs.renameSync(sessionFile(id), `${sessionFile(id)}.bak`)
  } catch {
    /* ignore */
  }
}

export function saveSession(session: Session): void {
  session.updatedAt = Date.now()
  writeJsonAtomic(sessionFile(session.id), session)
  upsertIndex({
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  })
  invalidateBodyIndex()
}

/** Persist composer-only state without changing the chat's activity timestamp or search index. Draft
 * keystrokes should not reorder the sidebar, and queued prompts must remain outside message search until sent. */
export function saveComposerState(id: string, composer: ComposerSessionState): void {
  const session = loadSession(id)
  if (!session) return
  session.composer = composer
  writeJsonAtomic(sessionFile(id), session)
}

/** Persist a turn's result, deriving a friendly title from the first user message when needed. */
export function saveTranscript(
  id: string,
  opts: {
    cwd: string
    mode: AgentMode
    messages: ChatMessage[]
    title?: string
    allowList?: AllowList
    tokenScale?: number
  }
): void {
  const existing = loadSession(id)
  const createdAt = existing?.createdAt ?? Date.now()
  let title = opts.title ?? existing?.title
  if (!title || title === defaultTitle(opts.cwd)) {
    const firstUser = opts.messages.find((m) => m.role === 'user')?.content
    title = firstUser ? deriveTitle(firstUser, opts.cwd) : defaultTitle(opts.cwd)
  }
  saveSession({
    id,
    title,
    cwd: opts.cwd,
    createdAt,
    updatedAt: Date.now(),
    mode: opts.mode,
    // Always persist a well-formed transcript, even if a write lands mid-turn.
    messages: repairTranscript(opts.messages),
    // A transcript save can race a debounced draft save at turn completion; preserve the latest
    // composer state already on disk instead of clearing it.
    composer: existing?.composer,
    allowList: opts.allowList,
    // Preserve the learned calibration when a non-turn save (setMode/clearApprovals) omits it.
    tokenScale: opts.tokenScale ?? existing?.tokenScale
  })
}

export function deleteSession(id: string): void {
  try {
    fs.rmSync(sessionFile(id))
  } catch {
    /* already gone */
  }
  // Reclaim the session's per-turn undo snapshots too (they used to leak on disk forever). The UUID
  // guard keeps the recursive delete from ever touching anything but a real session's snapshot dir.
  if (UUID_RE.test(id)) deleteSessionSnapshots(id)
  writeIndex(listSessions().filter((m) => m.id !== id))
  invalidateBodyIndex()
}

// ---- body search (find chats by content, not just title) ----
let bodyIndex: Map<string, string> | null = null

function invalidateBodyIndex(): void {
  bodyIndex = null
}

function buildBodyIndex(): Map<string, string> {
  const idx = new Map<string, string>()
  for (const meta of listSessions()) {
    const s = loadSession(meta.id)
    if (!s) continue
    idx.set(meta.id, s.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join(' '))
  }
  return idx
}

/** Search session message bodies for `query` (case-insensitive); returns matching ids + a short
 *  surrounding snippet. Lazily builds an in-memory index, cached until the next session write. */
export function searchSessions(query: string): SessionSearchHit[] {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return []
  if (!bodyIndex) bodyIndex = buildBodyIndex()
  const hits: SessionSearchHit[] = []
  for (const [id, text] of bodyIndex) {
    const i = text.toLowerCase().indexOf(q)
    if (i === -1) continue
    const start = Math.max(0, i - 24)
    const snip = text.slice(start, i + q.length + 48).replace(/\s+/g, ' ').trim()
    hits.push({ id, snippet: `${start > 0 ? '…' : ''}${snip}…` })
    if (hits.length >= 40) break
  }
  return hits
}
