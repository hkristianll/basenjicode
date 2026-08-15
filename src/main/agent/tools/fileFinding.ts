// The REVIEW department's only write lever: report a problem by filing an IMPLEMENTATION ticket for the team
// to fix — review audits and ROUTES, it never edits code itself. Scoped to the worker's own project (via
// ctx.hermesProject) and can only ADD a ticket (no claim/status), so it can't drain the board.
import { z } from 'zod'
import type { ToolDef } from '../registry'
import { addTicket } from '../../loopBoard'
import { withRoleBanner } from '../specOrchestrator'

const schema = z.object({
  title: z.string().min(1).describe('Short imperative title of the fix needed.'),
  body: z.string().optional().describe('What is wrong, where (file/area), and the acceptance criteria for the fix.'),
  check: z.string().optional().describe('A shell command that will pass once the fix is correct (e.g. the failing test).')
})

export const fileFindingTool: ToolDef<typeof schema> = {
  name: 'file_finding',
  description:
    'REVIEW only: report a problem you found by filing an IMPLEMENTATION ticket for the team to fix — you do NOT ' +
    'fix it yourself. One call per distinct issue. If the code is fine, do not call this.',
  schema,
  mutating: true,
  category: 'shell',
  async handler(args, ctx): Promise<string> {
    const project = ctx.hermesProject
    if (!project) throw new Error('file_finding has no project context (only Hermes review workers can file findings).')
    const row = await addTicket({
      project,
      title: args.title,
      body: withRoleBanner('implementation', args.body ?? ''),
      check: args.check,
      spec_ref: `board:${project}`
    })
    return `Filed implementation ticket #${row.id}: ${args.title}`
  }
}
