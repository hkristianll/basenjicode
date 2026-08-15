import { z } from 'zod'
import type { ToolDef } from '../registry'
import { bgTasks } from '../../bgtasks'

const idSchema = z.object({
  id: z.string().min(1).describe('Background task id (returned by run_background, or from list_background).')
})

const emptySchema = z.object({})

function taskLine(t: { id: string; command: string; status: string; code: number | null }): string {
  const code = t.code === null ? '' : ` (exit ${t.code})`
  return `${t.id} [${t.status}${code}] ${t.command}`
}

const listBackground: ToolDef<typeof emptySchema> = {
  name: 'list_background',
  description: 'List background tasks started with run_background (id, status, command). Use to find a task id.',
  schema: emptySchema,
  mutating: false,
  async handler() {
    const tasks = bgTasks.list()
    if (!tasks.length) return 'No background tasks.'
    return tasks.map(taskLine).join('\n')
  }
}

const readBackground: ToolDef<typeof idSchema> = {
  name: 'read_background',
  description:
    'Read the latest output (stdout+stderr) of a background task — e.g. to check a dev server\'s logs or a test ' +
    'runner\'s results after starting it with run_background.',
  schema: idSchema,
  mutating: false,
  async handler(args) {
    const exists = bgTasks.list().some((t) => t.id === args.id)
    if (!exists) return `ERROR: no background task with id "${args.id}". Use list_background to see current ids.`
    const out = bgTasks.output(args.id)
    return out.trim() ? out : '(no output yet)'
  }
}

const stopBackground: ToolDef<typeof idSchema> = {
  name: 'stop_background',
  description: 'Stop a running background task (kills the process tree). Safe — it only affects run_background tasks.',
  schema: idSchema,
  mutating: false,
  async handler(args) {
    const task = bgTasks.list().find((t) => t.id === args.id)
    if (!task) return `ERROR: no background task with id "${args.id}".`
    if (task.status !== 'running') return `Background task ${args.id} is already ${task.status}.`
    bgTasks.stop(args.id)
    return `Stopped background task ${args.id}.`
  }
}

export const backgroundTools: ToolDef[] = [
  listBackground as ToolDef,
  readBackground as ToolDef,
  stopBackground as ToolDef
]
