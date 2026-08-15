import { z } from 'zod'
import type { ToolDef } from '../registry'

const itemSchema = z.object({
  content: z.string().min(1).describe('Short, imperative task description.'),
  status: z.enum(['pending', 'in_progress', 'completed']).describe('pending | in_progress | completed')
})

const schema = z.object({
  todos: z.array(itemSchema).describe('The COMPLETE task list (replaces the previous one).')
})

const MARK: Record<string, string> = { pending: '[ ]', in_progress: '[~]', completed: '[x]' }

export const todoWriteTool: ToolDef<typeof schema> = {
  name: 'todo_write',
  description:
    'Track your plan for a multi-step task as a checklist shown to the user. Pass the FULL list every time (it ' +
    'replaces the previous one). Keep one item in_progress while you work it and mark it completed when done. ' +
    'Use it for tasks with several steps; skip it for trivial one-step requests.',
  schema,
  mutating: false,
  async handler(args, ctx) {
    ctx.todos?.set(args.todos)
    if (!args.todos.length) return 'Cleared the task list.'
    const done = args.todos.filter((t) => t.status === 'completed').length
    const lines = args.todos.map((t) => `${MARK[t.status]} ${t.content}`)
    return `Task list (${done}/${args.todos.length} done):\n${lines.join('\n')}`
  }
}
