// Single source of truth for the ticket board.
// node:sqlite is synchronous and this is a single-process server, so every
// read→write sequence below runs without interleaving — that is what makes
// claim_next race-safe without explicit locks.
import { DatabaseSync } from 'node:sqlite'

export const STATUSES = ['todo', 'in_progress', 'review', 'done', 'cancelled']
// A dependency is "cleared" once the upstream ticket is done or cancelled
// (or has been deleted). Anything else — including 'review' — still blocks the
// dependent ticket: you don't build on work that hasn't passed review yet.
const CLEARED = new Set(['done', 'cancelled'])

const LIMITS = { title: 500, body: 100_000, project: 200, assignee: 200, text: 20_000, deps: 200, check: 4_000 }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project    TEXT    NOT NULL DEFAULT 'default',
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL DEFAULT 'todo',
  priority   INTEGER NOT NULL DEFAULT 100,
  assignee   TEXT,
  deps       TEXT    NOT NULL DEFAULT '[]',
  spec_ref   TEXT,
  check_cmd  TEXT,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL,
  author     TEXT    NOT NULL DEFAULT '',
  text       TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS specs (
  project    TEXT PRIMARY KEY,
  title      TEXT,
  content    TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project);
CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id);
`

function now() {
  return new Date().toISOString()
}

function clip(v, max, name) {
  const s = String(v ?? '')
  if (s.length > max) throw new ValidationError(`${name} exceeds ${max} chars`)
  return s
}

export class ValidationError extends Error {}
export class NotFoundError extends Error {}
export class ConflictError extends Error {}

function normalizeDeps(deps) {
  if (deps == null) return []
  if (!Array.isArray(deps)) throw new ValidationError('deps must be an array of ticket ids')
  if (deps.length > LIMITS.deps) throw new ValidationError(`too many deps (max ${LIMITS.deps})`)
  const out = []
  for (const d of deps) {
    const n = Number(d)
    if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`dep "${d}" is not a positive ticket id`)
    if (!out.includes(n)) out.push(n)
  }
  return out
}

function rowToTicket(r) {
  if (!r) return null
  let deps = []
  try {
    deps = JSON.parse(r.deps)
  } catch {
    deps = []
  }
  return {
    id: r.id,
    project: r.project,
    title: r.title,
    body: r.body,
    status: r.status,
    priority: r.priority,
    assignee: r.assignee || null,
    deps,
    spec_ref: r.spec_ref || null,
    check: r.check_cmd || null,
    created_at: r.created_at,
    updated_at: r.updated_at
  }
}

export function createStore(dbPath) {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  // additive migration: existing DBs created before check_cmd existed.
  const cols = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name)
  if (!cols.includes('check_cmd')) db.exec('ALTER TABLE tickets ADD COLUMN check_cmd TEXT')

  const subscribers = new Set()
  function emit(type, payload) {
    for (const fn of subscribers) {
      try {
        fn({ type, ...payload })
      } catch {
        /* a broken subscriber must not break a write */
      }
    }
  }

  const q = {
    insert: db.prepare(
      `INSERT INTO tickets (project,title,body,status,priority,assignee,deps,spec_ref,check_cmd,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ),
    byId: db.prepare('SELECT * FROM tickets WHERE id = ?'),
    allByProject: db.prepare('SELECT * FROM tickets WHERE project = ? ORDER BY priority ASC, id ASC'),
    all: db.prepare('SELECT * FROM tickets ORDER BY project ASC, priority ASC, id ASC'),
    setStatus: db.prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?'),
    setAssignee: db.prepare('UPDATE tickets SET assignee = ?, updated_at = ? WHERE id = ?'),
    setDeps: db.prepare('UPDATE tickets SET deps = ?, updated_at = ? WHERE id = ?'),
    // Atomic claim: only transitions a ticket that is still 'todo'.
    claimIfTodo: db.prepare(
      "UPDATE tickets SET status='in_progress', assignee=?, updated_at=? WHERE id=? AND status='todo'"
    ),
    addComment: db.prepare('INSERT INTO comments (ticket_id,author,text,created_at) VALUES (?,?,?,?)'),
    commentsFor: db.prepare('SELECT * FROM comments WHERE ticket_id = ? ORDER BY id ASC'),
    upsertSpec: db.prepare(
      `INSERT INTO specs (project,title,content,updated_at) VALUES (?,?,?,?)
       ON CONFLICT(project) DO UPDATE SET title=excluded.title, content=excluded.content, updated_at=excluded.updated_at`
    ),
    getSpec: db.prepare('SELECT * FROM specs WHERE project = ?')
  }

  function getRaw(id) {
    const n = Number(id)
    if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`invalid ticket id "${id}"`)
    const r = q.byId.get(n)
    if (!r) throw new NotFoundError(`ticket #${n} not found`)
    return r
  }

  // Resolve a dependency's current status. Prefer the in-batch map, but fall back
  // to an authoritative DB lookup for any dep outside the decorated subset — a
  // single-ticket fetch or a project-scoped list must NOT treat an out-of-subset
  // dep as missing. undefined is returned only when the dep ticket genuinely no
  // longer exists (deleted), which counts as cleared.
  function depStatus(d, statusById) {
    if (statusById.has(d)) return statusById.get(d)
    const r = q.byId.get(d)
    return r ? r.status : undefined
  }

  function decorate(tickets) {
    const statusById = new Map(tickets.map((t) => [t.id, t.status]))
    return tickets.map((t) => {
      const depStates = t.deps.map((d) => ({ d, st: depStatus(d, statusById) }))
      const cleared = depStates.every(({ st }) => st === undefined || CLEARED.has(st))
      const blockedBy = t.status === 'todo' ? depStates.filter(({ st }) => st !== undefined && !CLEARED.has(st)).map(({ d }) => d) : []
      return {
        ...t,
        ready: t.status === 'todo' && cleared,
        blocked: t.status === 'todo' && !cleared,
        blocked_by: blockedBy
      }
    })
  }

  const api = {
    db,

    subscribe(fn) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },

    addTicket({ project, title, body, deps, priority, assignee, spec_ref, check } = {}) {
      const ttl = clip(title, LIMITS.title, 'title').trim()
      if (!ttl) throw new ValidationError('title is required')
      const proj = clip(project || 'default', LIMITS.project, 'project').trim() || 'default'
      const b = clip(body || '', LIMITS.body, 'body')
      const dlist = normalizeDeps(deps)
      for (const d of dlist) {
        if (!q.byId.get(d)) throw new ValidationError(`dependency #${d} does not exist`)
      }
      let prio = priority == null ? 100 : Number(priority)
      if (!Number.isFinite(prio)) throw new ValidationError('priority must be a number')
      prio = Math.trunc(prio)
      const asg = assignee ? clip(assignee, LIMITS.assignee, 'assignee') : null
      const sref = spec_ref ? clip(spec_ref, LIMITS.body, 'spec_ref') : null
      const chk = check ? clip(check, LIMITS.check, 'check').trim() || null : null
      const ts = now()
      const info = q.insert.run(proj, ttl, b, 'todo', prio, asg, JSON.stringify(dlist), sref, chk, ts, ts)
      const t = rowToTicket(q.byId.get(info.lastInsertRowid))
      emit('ticket.created', { ticket: t })
      return t
    },

    getTicket(id) {
      const t = rowToTicket(getRaw(id))
      const comments = q.commentsFor.all(t.id)
      return { ...decorate([t])[0], comments }
    },

    listTickets({ project, status } = {}) {
      let rows = project ? q.allByProject.all(String(project)) : q.all.all()
      let tickets = decorate(rows.map(rowToTicket))
      if (status) {
        if (status === 'ready') tickets = tickets.filter((t) => t.ready)
        else if (status === 'blocked') tickets = tickets.filter((t) => t.blocked)
        else tickets = tickets.filter((t) => t.status === status)
      }
      return tickets
    },

    updateStatus(id, status, { note, author } = {}) {
      if (!STATUSES.includes(status)) throw new ValidationError(`status must be one of ${STATUSES.join(', ')}`)
      const raw = getRaw(id)
      q.setStatus.run(status, now(), raw.id)
      if (note) q.addComment.run(raw.id, clip(author || 'system', LIMITS.assignee, 'author'), clip(note, LIMITS.text, 'note'), now())
      const t = rowToTicket(q.byId.get(raw.id))
      emit('ticket.status', { ticket: t })
      return this.getTicket(t.id)
    },

    // Edit a ticket's content in place (title / body / check / priority) — lets the orchestrator FIX a broken or
    // impossible check (or refine scope) instead of cancelling + re-filing a duplicate (the re-file churn). Partial:
    // only the provided fields change. Reuses the same validation/limits as addTicket. Status/deps unchanged.
    updateTicket(id, { title, body, check, priority } = {}) {
      const raw = getRaw(id)
      const sets = []
      const vals = []
      if (title !== undefined) {
        const ttl = clip(title, LIMITS.title, 'title').trim()
        if (!ttl) throw new ValidationError('title cannot be empty')
        sets.push('title = ?')
        vals.push(ttl)
      }
      if (body !== undefined) {
        sets.push('body = ?')
        vals.push(clip(body || '', LIMITS.body, 'body'))
      }
      if (check !== undefined) {
        sets.push('check_cmd = ?')
        vals.push(check ? clip(check, LIMITS.check, 'check').trim() || null : null)
      }
      if (priority !== undefined) {
        const prio = Number(priority)
        if (!Number.isFinite(prio)) throw new ValidationError('priority must be a number')
        sets.push('priority = ?')
        vals.push(Math.trunc(prio))
      }
      if (!sets.length) throw new ValidationError('updateTicket: provide at least one of title, body, check, priority')
      sets.push('updated_at = ?')
      vals.push(now())
      db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...vals, raw.id)
      const t = rowToTicket(q.byId.get(raw.id))
      emit('ticket.updated', { ticket: t })
      return this.getTicket(t.id)
    },

    claim(id, assignee) {
      const asg = clip(assignee || '', LIMITS.assignee, 'assignee').trim()
      if (!asg) throw new ValidationError('assignee is required to claim a ticket')
      const raw = getRaw(id)
      const t = rowToTicket(raw)
      const deco = decorate([t])[0]
      if (t.status !== 'todo') throw new ConflictError(`ticket #${t.id} is '${t.status}', not claimable`)
      if (!deco.ready) throw new ConflictError(`ticket #${t.id} is blocked by ${deco.blocked_by.join(', ')}`)
      const info = q.claimIfTodo.run(asg, now(), t.id)
      if (info.changes === 0) throw new ConflictError(`ticket #${t.id} was claimed by someone else`)
      const updated = this.getTicket(t.id)
      emit('ticket.claimed', { ticket: updated })
      return updated
    },

    // Read-only peek at the next ready ticket (does not claim).
    nextReady({ project } = {}) {
      const ready = this.listTickets({ project, status: 'ready' })
      return ready[0] || null
    },

    // Atomic find-next-ready + claim. The whole sequence is synchronous, so two
    // concurrent callers cannot grab the same ticket.
    claimNext({ project, assignee } = {}) {
      const asg = clip(assignee || '', LIMITS.assignee, 'assignee').trim()
      if (!asg) throw new ValidationError('assignee is required')
      const ready = this.listTickets({ project, status: 'ready' })
      for (const cand of ready) {
        const info = q.claimIfTodo.run(asg, now(), cand.id)
        if (info.changes === 1) {
          const updated = this.getTicket(cand.id)
          emit('ticket.claimed', { ticket: updated })
          return updated
        }
      }
      return null
    },

    addDependency(id, dependsOn) {
      const raw = getRaw(id)
      const dep = Number(dependsOn)
      if (!Number.isInteger(dep) || dep <= 0) throw new ValidationError(`invalid dependency id "${dependsOn}"`)
      if (dep === raw.id) throw new ValidationError('a ticket cannot depend on itself')
      getRaw(dep) // ensure the dependency exists
      if (this._wouldCycle(raw.id, dep)) throw new ValidationError(`adding dep #${dep} would create a dependency cycle`)
      const t = rowToTicket(raw)
      if (!t.deps.includes(dep)) t.deps.push(dep)
      q.setDeps.run(JSON.stringify(t.deps), now(), raw.id)
      const updated = this.getTicket(raw.id)
      emit('ticket.updated', { ticket: updated })
      return updated
    },

    // Would making `from` depend on `to` create a cycle? (i.e. does `to` already
    // reach `from` through its own deps?)
    _wouldCycle(from, to) {
      const seen = new Set()
      const stack = [to]
      while (stack.length) {
        const cur = stack.pop()
        if (cur === from) return true
        if (seen.has(cur)) continue
        seen.add(cur)
        const r = q.byId.get(cur)
        if (!r) continue
        try {
          for (const d of JSON.parse(r.deps)) stack.push(Number(d))
        } catch {
          /* ignore */
        }
      }
      return false
    },

    comment(id, author, text) {
      const raw = getRaw(id)
      const txt = clip(text || '', LIMITS.text, 'text')
      if (!txt.trim()) throw new ValidationError('comment text is required')
      q.addComment.run(raw.id, clip(author || 'anon', LIMITS.assignee, 'author'), txt, now())
      const updated = this.getTicket(raw.id)
      emit('ticket.comment', { ticket: updated })
      return updated
    },

    summary({ project } = {}) {
      const tickets = this.listTickets({ project })
      const counts = { total: tickets.length, ready: 0, blocked: 0, todo: 0, in_progress: 0, review: 0, done: 0, cancelled: 0 }
      for (const t of tickets) {
        counts[t.status] = (counts[t.status] || 0) + 1
        if (t.ready) counts.ready++
        if (t.blocked) counts.blocked++
      }
      return counts
    },

    setSpec({ project, title, content } = {}) {
      const proj = clip(project || 'default', LIMITS.project, 'project').trim() || 'default'
      q.upsertSpec.run(proj, title ? clip(title, LIMITS.title, 'title') : null, clip(content || '', LIMITS.body, 'content'), now())
      emit('spec.updated', { project: proj })
      return q.getSpec.get(proj)
    },

    getSpec(project) {
      return q.getSpec.get(clip(project || 'default', LIMITS.project, 'project')) || null
    },

    projects() {
      const rows = db.prepare('SELECT DISTINCT project FROM tickets ORDER BY project ASC').all()
      return rows.map((r) => r.project)
    }
  }

  return api
}
