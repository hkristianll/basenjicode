import { z } from 'zod'
import type { ToolDef } from '../registry'
import { appendManagerMemory } from '../managerMemory'

const schema = z.object({
  note: z
    .string()
    .describe(
      'A durable, GENERALIZABLE lesson to carry into FUTURE projects — a planning pattern that works, a decomposition ' +
        'trap to avoid, a check that is reliable vs brittle, a model/tool that behaves a certain way. NOT project-specific ' +
        'trivia (that lives on the board). One or two tight sentences.'
    )
})

/** Brooke's self-directed learning loop: persist a durable cross-project lesson to her memory (managerMemory). Her
 *  memory is injected into her seed every run, so what she records here makes the NEXT project go better. */
export const managerRememberTool: ToolDef<typeof schema> = {
  name: 'remember_lesson',
  description:
    'Save a durable lesson to your PERSISTENT cross-project memory so future runs start smarter. Call it the moment ' +
    'you learn something that should change how the NEXT project is planned or managed — a check pattern that works, ' +
    'a decomposition trap, a model that loops, a fix that recurred. Keep each note generalizable, not project trivia. ' +
    'Your memory is injected into your seed on every future run.',
  schema,
  mutating: false,
  async handler(args) {
    const note = args.note?.trim()
    if (!note) return 'Nothing to remember (empty note).'
    appendManagerMemory(note)
    return `Remembered: "${note.slice(0, 140)}". It will be in your memory on every future run.`
  }
}
