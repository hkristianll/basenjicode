import { z } from 'zod'
import type { ToolDef } from '../registry'
import { recordEscalation } from '../escalation'

const schema = z.object({
  reason: z
    .string()
    .min(1)
    .describe(
      'What is blocking you, specifically — a missing prerequisite/dependency, an ambiguous or contradictory ' +
        'requirement, a check you cannot make pass, or an error you cannot resolve after genuinely trying.'
    )
})

export const escalateTool: ToolDef<typeof schema> = {
  name: 'escalate_to_lead',
  description:
    'Escalate to your TEAM LEAD when you are genuinely STUCK. ESPECIALLY: if while doing your task you discover a ' +
    'SEPARATE big issue — a bug in another module, a missing/broken foundation, a dependency that does not exist — that ' +
    'would consume all your time, escalate it rather than trying to fix it here. A manager can then file that issue as ' +
    'its OWN ticket so you are not stuck doing two jobs at once. Also escalate on an ambiguous/contradictory requirement, ' +
    'a check you cannot make pass, or repeated failures. Use this INSTEAD of rewriting whole files, guessing, or ' +
    'thrashing: describe the issue clearly (what + where) and STOP. The lead will hand you a concrete fix, or the group ' +
    'manager will re-plan the board. Do NOT use it for trivial questions — only when you are actually blocked.',
  schema,
  mutating: false,
  category: 'read',
  handler: async (args) => {
    recordEscalation(args.reason)
    return (
      'Escalation recorded. STOP now — do not keep trying, do not rewrite files, do not guess. Your team lead will ' +
      'review this issue and either give you a concrete fix to apply or hand it to the group manager.'
    )
  }
}
