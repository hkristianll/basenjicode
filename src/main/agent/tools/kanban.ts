import { z } from 'zod'
import type { ToolDef } from '../registry'

// The shared ticket board (standalone service at Desktop\ticket-board). NordCode
// talks to it over its REST API — no MCP client needed. Override the location with
// the TICKET_BOARD_URL env var if you run the board on a different host/port.
const BOARD_URL = (process.env.TICKET_BOARD_URL || 'http://127.0.0.1:8930').replace(/\/+$/, '')
const ME = process.env.TICKET_BOARD_ASSIGNEE || 'nordcode'

const schema = z.object({
  action: z
    .enum(['claim_next', 'update', 'add', 'list', 'get', 'comment', 'summary'])
    .describe('What to do on the board.'),
  project: z.string().optional().describe('Board/namespace. Scope work to one spec/feature.'),
  id: z.number().int().positive().optional().describe('Ticket id (for get / update / comment).'),
  status: z
    .enum(['todo', 'in_progress', 'review', 'done', 'cancelled', 'ready', 'blocked'])
    .optional()
    .describe('For update: the new status (use "review" to hand a finished ticket off for verification before it is "done"). For list: a filter (incl. derived ready/blocked).'),
  title: z.string().optional().describe('For add: the ticket title.'),
  body: z.string().optional().describe('For add: full detail / acceptance criteria.'),
  deps: z.array(z.number().int().positive()).optional().describe('For add: ticket ids that must be done first.'),
  priority: z.number().int().optional().describe('For add: lower runs earlier (default 100).'),
  check: z.string().optional().describe('For add: a shell command that verifies the ticket is done (the check-gate runs it; non-zero exit = not done).'),
  note: z.string().optional().describe('For update: a note recorded as a comment.'),
  text: z.string().optional().describe('For comment: the comment body.')
})

type Args = z.infer<typeof schema>

async function call(method: string, path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(BOARD_URL + path, {
      method,
      signal,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch (e) {
    throw new Error(
      `Ticket board not reachable at ${BOARD_URL} (${(e as Error).message}). ` +
        `Start it with \`npm start\` in the ticket-board project, or set TICKET_BOARD_URL.`
    )
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `board returned HTTP ${res.status}`)
  return data
}

function ticketLine(t: Record<string, unknown>): string {
  const ready = t.ready ? 'READY' : t.blocked ? `BLOCKED(by ${(t.blocked_by as number[]).join(',')})` : String(t.status).toUpperCase()
  return `#${t.id} [${ready}] ${t.title}${t.assignee ? ` @${t.assignee}` : ''}`
}

export const kanbanTool: ToolDef<typeof schema> = {
  name: 'kanban',
  description:
    'Read and drive the shared ticket board — the cross-agent work queue a planner fills and executors drain.\n' +
    'To work the board autonomously, loop: action="claim_next" (takes the next unblocked ticket and marks it ' +
    'in_progress under you) → do exactly what the returned ticket body describes using your normal tools → ' +
    'action="update" status="done" id=<that id> → repeat until claim_next returns "No ready tickets". ' +
    'If finished work should be verified by a reviewer before it counts as done, use status="review" instead of "done" ' +
    '(a ticket in review still blocks its dependents — a reviewer then promotes it to done). ' +
    'Tickets only become claimable once their deps are done, so following claim_next respects the dependency order. ' +
    'Other actions: "add" (create a ticket; link prerequisites via deps), "list" (filter by project/status, incl. ' +
    'ready/blocked), "get" (full detail + comments for one id), "comment" (id+text), "summary" (counts).',
  schema,
  mutating: false,
  category: 'read',
  async handler(args: Args, ctx): Promise<string> {
    const sig = ctx.signal
    const project = args.project
    switch (args.action) {
      case 'claim_next': {
        const t = (await call('POST', '/api/claim-next', { project, assignee: ME }, sig)) as Record<string, unknown> | null
        if (!t) return 'No ready tickets to claim — the board is empty, all done, or everything left is blocked.'
        return `Claimed #${t.id}: ${t.title}\n\n${t.body || '(no description)'}\n\nWhen finished: kanban action="update" status="done" id=${t.id}`
      }
      case 'update': {
        if (!args.id) throw new Error('update needs an id')
        if (!args.status) throw new Error('update needs a status')
        if (args.status === 'ready' || args.status === 'blocked') throw new Error("status must be one of: todo, in_progress, review, done, cancelled (ready/blocked are derived)")
        const t = (await call('POST', `/api/tickets/${args.id}/status`, { status: args.status, note: args.note, author: ME }, sig)) as Record<string, unknown>
        return `#${t.id} → ${t.status}.`
      }
      case 'add': {
        if (!args.title) throw new Error('add needs a title')
        const t = (await call('POST', '/api/tickets', { title: args.title, body: args.body, project, deps: args.deps, priority: args.priority, check: args.check }, sig)) as Record<string, unknown>
        return `Added #${t.id}: ${t.title}${args.deps?.length ? ` (deps: ${args.deps.map((d) => '#' + d).join(', ')})` : ''}${args.check ? ` (check: ${args.check})` : ''}`
      }
      case 'list': {
        const qs = new URLSearchParams()
        if (project) qs.set('project', project)
        if (args.status) qs.set('status', args.status)
        const list = (await call('GET', `/api/tickets${qs.toString() ? '?' + qs : ''}`, undefined, sig)) as Record<string, unknown>[]
        return list.length ? list.map(ticketLine).join('\n') : 'No matching tickets.'
      }
      case 'get': {
        if (!args.id) throw new Error('get needs an id')
        const t = (await call('GET', `/api/tickets/${args.id}`, undefined, sig)) as Record<string, unknown>
        const comments = (t.comments as Record<string, unknown>[]) || []
        const cs = comments.length ? '\n\nComments:\n' + comments.map((c) => `- ${c.author}: ${c.text}`).join('\n') : ''
        return `#${t.id} ${t.title} [${t.ready ? 'ready' : t.blocked ? 'blocked' : t.status}]${t.assignee ? ` @${t.assignee}` : ''}\ndeps: ${(t.deps as number[]).join(', ') || 'none'}\n\n${t.body || '(no description)'}${cs}`
      }
      case 'comment': {
        if (!args.id) throw new Error('comment needs an id')
        if (!args.text) throw new Error('comment needs text')
        await call('POST', `/api/tickets/${args.id}/comment`, { author: ME, text: args.text }, sig)
        return `Commented on #${args.id}.`
      }
      case 'summary': {
        const qs = project ? `?project=${encodeURIComponent(project)}` : ''
        const s = (await call('GET', `/api/summary${qs}`, undefined, sig)) as Record<string, number>
        return `total ${s.total} · ready ${s.ready} · in_progress ${s.in_progress} · blocked ${s.blocked} · done ${s.done}`
      }
      default:
        throw new Error(`unknown action`)
    }
  }
}
