// Brooke's control tools — the group manager's levers over the Hermes engine. Thin wrappers over the installed
// HermesController (ipc.ts wires it to boardRunner + runHermes + loopBoard). These are the ONLY tools that drive
// the run; the per-ticket department workers never get them. Brooke runs in auto mode, so "mutating" tools
// execute without an approval prompt — she IS the operator.
import { z } from 'zod'
import type { ToolDef } from '../registry'
import { hermesController } from '../hermesControl'
import { checkPromptRules, shellCheckLabel } from '../checkLint'

const CHECK_SHELL = shellCheckLabel()
const CHECK_RULES = checkPromptRules()

const startGoalTool: ToolDef<z.ZodObject<{ goal: z.ZodString }>> = {
  name: 'start_goal',
  description:
    'Launch the team on a goal. The departments decompose it into tickets and begin executing immediately. ' +
    'Use this whenever the user gives you something to build — do not just describe a plan.',
  schema: z.object({ goal: z.string().min(1).describe('What to build, in the user\'s words.') }),
  mutating: true,
  category: 'shell',
  handler: (args, ctx) => hermesController(ctx.hermesProject).startGoal(args.goal)
}

const addWorkTool: ToolDef<
  z.ZodObject<{ title: z.ZodString; body: z.ZodOptional<z.ZodString>; role: z.ZodOptional<z.ZodString>; check: z.ZodOptional<z.ZodString>; deps: z.ZodOptional<z.ZodArray<z.ZodNumber>> }>
> = {
  name: 'add_work',
  description:
    'File a new ticket into a department so the team picks it up. role is one of: architecture, implementation, ' +
    'design, testing, review, docs. Provide a check (a shell command that passes only when the work is done) when you can. ' +
    'Keep each ticket to ONE worker session — never file a project-wide SWEEP (expand the whole test suite, enforce ' +
    'coverage, write all the docs, build the entire frontend) as a single ticket; split it per module/file. ' +
    'If the work builds on, tests, validates, or extends EXISTING tickets, pass their ids in deps so it runs AFTER them — ' +
    'a deps-less ticket is ready immediately and may run before its prerequisites exist (wasted or duplicated work).',
  schema: z.object({
    title: z.string().min(1).describe('Short imperative ticket title.'),
    body: z.string().optional().describe('What to build + acceptance criteria.'),
    role: z.string().optional().describe('Owning department: architecture | implementation | design | testing | review | docs.'),
    check: z.string().optional().describe('Shell command that verifies the ticket is done.'),
    deps: z.array(z.number()).optional().describe('Ids of existing tickets this one depends on — it waits until they are done. Omit for work with no prerequisites.')
  }),
  mutating: true,
  category: 'shell',
  handler: (args, ctx) => hermesController(ctx.hermesProject).addWork(args)
}

const reopenTool: ToolDef<z.ZodObject<{ id: z.ZodNumber }>> = {
  name: 'reopen_ticket',
  description: 'Re-engage a ticket that is in review or parked (→ todo) so the team works it again.',
  schema: z.object({ id: z.number().int().positive().describe('Ticket id to reopen.') }),
  mutating: true,
  category: 'shell',
  handler: (args, ctx) => hermesController(ctx.hermesProject).reopen(args.id)
}

const cancelTool: ToolDef<z.ZodObject<{ id: z.ZodNumber; reason: z.ZodOptional<z.ZodString> }>> = {
  name: 'cancel_ticket',
  description:
    'Cancel a stale or obsolete ticket so it stops cluttering the board and competing for the team\'s attention ' +
    '(→ cancelled — terminal but reversible with reopen_ticket). Use for old blocked or superseded work that ' +
    'should no longer be done. Read the board first so you cancel the right ones.',
  schema: z.object({
    id: z.number().int().positive().describe('Ticket id to cancel.'),
    reason: z.string().optional().describe('Why it is being cancelled (recorded as a board comment).')
  }),
  mutating: true,
  category: 'shell',
  handler: (args, ctx) => hermesController(ctx.hermesProject).cancel(args.id, args.reason)
}

const editTicketTool: ToolDef<
  z.ZodObject<{ id: z.ZodNumber; body: z.ZodOptional<z.ZodString>; check: z.ZodOptional<z.ZodString>; priority: z.ZodOptional<z.ZodNumber> }>
> = {
  name: 'edit_ticket',
  description:
    'Edit a ticket IN PLACE — fix a broken/impossible CHECK, refine the body/acceptance criteria, or change priority — ' +
    'WITHOUT cancelling and re-filing a duplicate. This is the right tool when a ticket parked because its check was ' +
    `wrong (syntax for a different shell, a check for files no ticket creates, etc.): pass a corrected ${CHECK_SHELL} ` +
    `check here, then reopen_ticket so the team re-runs it. ${CHECK_RULES} Only the fields you pass change.`,
  schema: z.object({
    id: z.number().int().positive().describe('Ticket id to edit.'),
    body: z.string().optional().describe('New body / acceptance criteria.'),
    check: z.string().optional().describe(`New ${CHECK_SHELL} check command (npm test / pytest / npx tsc --noEmit / npm run build).`),
    priority: z.number().int().optional().describe('New priority (lower runs earlier).')
  }),
  mutating: true,
  category: 'shell',
  handler: (args, ctx) => hermesController(ctx.hermesProject).editTicket(args.id, { body: args.body, check: args.check, priority: args.priority })
}

const dedupeBoardTool: ToolDef<z.ZodObject<Record<string, never>>> = {
  name: 'dedupe_board',
  description:
    'Find and cancel DUPLICATE tickets — the same work re-filed multiple times (re-file churn). Matches by ' +
    'normalized title, keeps the most-advanced copy of each (a done/in-progress one over a todo), and cancels the ' +
    'rest (reversible with reopen_ticket). Use this when the board has obvious repeats you cannot clean one-by-one, ' +
    'or before a planning meeting so the leads see a clean board. Returns a summary of what it cancelled.',
  schema: z.object({}),
  mutating: true,
  category: 'shell',
  handler: (_args, ctx) => hermesController(ctx.hermesProject).dedupeBoard()
}

const requestImproveTool: ToolDef<z.ZodObject<Record<string, never>>> = {
  name: 'request_improve',
  description: 'Run one improvement pass now: the lead critic reviews the project and files follow-up tickets (tests, edge cases, refactors).',
  schema: z.object({}),
  mutating: true,
  category: 'shell',
  handler: (_args, ctx) => hermesController(ctx.hermesProject).requestImprove()
}

const pauseTool: ToolDef<z.ZodObject<Record<string, never>>> = {
  name: 'pause_team',
  description: 'Pause the team at the next ticket boundary.',
  schema: z.object({}),
  mutating: true,
  category: 'shell',
  handler: (_args, ctx) => hermesController(ctx.hermesProject).pause()
}

const resumeTool: ToolDef<z.ZodObject<Record<string, never>>> = {
  name: 'resume_team',
  description:
    'Resume OR continue the team. Un-pauses a paused run; if no run is live (it finished a pass, was stopped, or ' +
    'the app restarted) it restarts the team on the EXISTING board — picking up the unfinished tickets where they ' +
    'left off, without re-planning. Use this whenever the user says continue, resume, keep going, or carry on. Do ' +
    'NOT use start_goal to continue — that re-decomposes from scratch and duplicates the whole board.',
  schema: z.object({}),
  mutating: true,
  category: 'shell',
  handler: (_args, ctx) => hermesController(ctx.hermesProject).resume()
}

const stopTool: ToolDef<z.ZodObject<Record<string, never>>> = {
  name: 'stop_team',
  description: 'Stop the team and the whole orchestration cycle.',
  schema: z.object({}),
  mutating: true,
  category: 'shell',
  handler: (_args, ctx) => hermesController(ctx.hermesProject).stop()
}

const keepWorkingTool: ToolDef<z.ZodObject<{ on: z.ZodOptional<z.ZodBoolean> }>> = {
  name: 'keep_working',
  description:
    'Turn on "keep working until I stop" mode: the team will NOT end when the board drains — instead it convenes a ' +
    'MANAGER MEETING with the department leads to find the next improvements and keeps going, and otherwise stays ' +
    'on-call, until you call stop_team. Use this whenever the user says to work until they stop, keep going ' +
    'indefinitely, or run unattended. After enabling, call resume_team (or start_goal) to set it working. Pass ' +
    'on:false to turn it back off (the team then stops when the current work completes).',
  schema: z.object({ on: z.boolean().optional().describe('true to enable (default), false to disable.') }),
  mutating: true,
  category: 'shell',
  handler: (args, ctx) => hermesController(ctx.hermesProject).keepWorking(args.on ?? true)
}

const teamStatusTool: ToolDef<z.ZodObject<Record<string, never>>> = {
  name: 'team_status',
  description: 'Get a department-by-department status snapshot of the board (done / in progress / blocked / review). Read this before reporting status to the user.',
  schema: z.object({}),
  mutating: false,
  category: 'read',
  handler: (_args, ctx) => hermesController(ctx.hermesProject).teamStatus()
}

/** All of Brooke's control tools, in one array for the manager registry. */
export const hermesControlTools: ToolDef[] = [
  startGoalTool,
  addWorkTool,
  reopenTool,
  cancelTool,
  editTicketTool,
  dedupeBoardTool,
  requestImproveTool,
  pauseTool,
  resumeTool,
  stopTool,
  keepWorkingTool,
  teamStatusTool
] as unknown as ToolDef[]
