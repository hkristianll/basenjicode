// The MCP face of the board. Every tool is a thin wrapper over the shared store,
// so MCP clients (Claude Code) and REST clients (NordCode) see identical state.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

function text(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] }
}
function fail(e) {
  return { isError: true, content: [{ type: 'text', text: `Error: ${e?.message || e}` }] }
}
function ticketLine(t) {
  const tag = t.ready ? 'READY' : t.blocked ? `BLOCKED(by ${t.blocked_by.join(',')})` : t.status.toUpperCase()
  return `#${t.id} [${tag}] ${t.title}${t.assignee ? ` @${t.assignee}` : ''}`
}

export function buildMcpServer(store) {
  const server = new McpServer({ name: 'ticket-board', version: '1.0.0' })

  server.registerTool(
    'add_ticket',
    {
      title: 'Add ticket',
      description:
        'Create a ticket on the board. Use this when decomposing a spec into work: one ticket per self-contained, ~100k-token-sized chunk of work. ' +
        'Link prerequisites with `deps` (an array of ticket ids that must be done first) so executors only pick a ticket up once it is unblocked. ' +
        'Lower `priority` runs earlier (default 100).',
      inputSchema: {
        title: z.string().describe('Short imperative ticket title.'),
        body: z.string().optional().describe('Full detail: what to build, acceptance criteria, files/areas involved.'),
        project: z.string().optional().describe("Board/namespace, default 'default'. Use one project per spec/feature."),
        deps: z.array(z.number().int().positive()).optional().describe('Ticket ids that must be done before this one is ready.'),
        priority: z.number().int().optional().describe('Lower = earlier. Default 100.'),
        spec_ref: z.string().optional().describe('Path to the spec file this ticket derives from.'),
        check: z.string().optional().describe('Optional shell command that verifies this ticket is complete (exit 0 = pass). An executor/Loop runner runs it as the ticket evaluation; absent → falls back to a review gate.')
      }
    },
    async (args) => {
      try {
        return text(store.addTicket(args))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'list_tickets',
    {
      title: 'List tickets',
      description:
        "List tickets, newest-priority first. Filter by `project` and/or `status`. `status` accepts the stored states " +
        "(todo|in_progress|done|cancelled) plus the derived views 'ready' (todo with all deps done) and 'blocked' (todo with unmet deps).",
      inputSchema: {
        project: z.string().optional(),
        status: z.enum(['todo', 'in_progress', 'review', 'done', 'cancelled', 'ready', 'blocked']).optional()
      }
    },
    async (args) => {
      try {
        const ts = store.listTickets(args)
        if (!ts.length) return text('No matching tickets.')
        return text(ts.map(ticketLine).join('\n'))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'get_ticket',
    {
      title: 'Get ticket',
      description: 'Fetch one ticket in full — body, deps, ready/blocked state, assignee, and comment history.',
      inputSchema: { id: z.number().int().positive() }
    },
    async ({ id }) => {
      try {
        return text(store.getTicket(id))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'next_ready',
    {
      title: 'Peek next ready ticket',
      description:
        'Return the highest-priority ticket that is ready to work (todo with every dependency done) without claiming it. ' +
        'Use claim_next instead when you intend to start work.',
      inputSchema: { project: z.string().optional() }
    },
    async (args) => {
      try {
        const t = store.nextReady(args)
        return text(t || 'No ready tickets — the board is empty, all done, or everything left is blocked.')
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'claim_next',
    {
      title: 'Claim next ready ticket',
      description:
        'Atomically pick the highest-priority ready ticket and mark it in_progress under `assignee`. This is the executor entrypoint: ' +
        'call it, do the work the returned ticket describes, then update_status(id, "done"), and repeat until it returns nothing. ' +
        'Two executors can call this concurrently without grabbing the same ticket.',
      inputSchema: {
        assignee: z.string().describe('Who is taking the ticket, e.g. "claude" or "nordcode".'),
        project: z.string().optional()
      }
    },
    async (args) => {
      try {
        const t = store.claimNext(args)
        return text(t || 'No ready tickets to claim.')
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'claim',
    {
      title: 'Claim a specific ticket',
      description: 'Mark a specific ready ticket in_progress under `assignee`. Fails if it is blocked or already taken.',
      inputSchema: { id: z.number().int().positive(), assignee: z.string() }
    },
    async ({ id, assignee }) => {
      try {
        return text(store.claim(id, assignee))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'update_status',
    {
      title: 'Update ticket status',
      description:
        'Move a ticket to todo | in_progress | review | done | cancelled. Mark it "review" when the work is finished ' +
        'but should be verified by a reviewer before it counts as done — a ticket in review still BLOCKS its dependents ' +
        '(they wait for done). Marking a ticket done can unblock tickets that depend on it. Add a `note` to record what happened.',
      inputSchema: {
        id: z.number().int().positive(),
        status: z.enum(['todo', 'in_progress', 'review', 'done', 'cancelled']),
        note: z.string().optional(),
        author: z.string().optional()
      }
    },
    async ({ id, status, note, author }) => {
      try {
        return text(store.updateStatus(id, status, { note, author }))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'add_dependency',
    {
      title: 'Add dependency',
      description: 'Make ticket `id` depend on ticket `depends_on` (must be done first). Rejected if it would create a cycle.',
      inputSchema: { id: z.number().int().positive(), depends_on: z.number().int().positive() }
    },
    async ({ id, depends_on }) => {
      try {
        return text(store.addDependency(id, depends_on))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'comment',
    {
      title: 'Comment on a ticket',
      description: 'Append a note to a ticket — progress updates, blockers found, decisions made.',
      inputSchema: { id: z.number().int().positive(), text: z.string(), author: z.string().optional() }
    },
    async ({ id, text: body, author }) => {
      try {
        return text(store.comment(id, author || 'anon', body))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'board_summary',
    {
      title: 'Board summary',
      description: 'Counts per status plus ready/blocked totals. Cheap way for an executor to decide whether to keep going.',
      inputSchema: { project: z.string().optional() }
    },
    async (args) => {
      try {
        return text(store.summary(args))
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'set_spec',
    {
      title: 'Save the spec',
      description:
        'Store the agreed spec text for a project so executors share one source of truth. Call after the user confirms the spec, before decomposing it into tickets.',
      inputSchema: { project: z.string().optional(), title: z.string().optional(), content: z.string() }
    },
    async (args) => {
      try {
        store.setSpec(args)
        return text(`Spec saved for project '${args.project || 'default'}'.`)
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'get_spec',
    {
      title: 'Get the spec',
      description: 'Return the saved spec text for a project.',
      inputSchema: { project: z.string().optional() }
    },
    async ({ project }) => {
      try {
        const s = store.getSpec(project)
        return text(s ? s.content : `No spec saved for project '${project || 'default'}'.`)
      } catch (e) {
        return fail(e)
      }
    }
  )

  return server
}
