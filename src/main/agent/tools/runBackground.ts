import { z } from 'zod'
import type { ToolDef } from '../registry'
import type { ToolPreview } from '../../../shared/ipc-types'
import { bgTasks } from '../../bgtasks'
import { shellFamily } from '../../shell/powershell'
import { dangerousRecursiveDelete } from './deleteGuard'

const SHELL_NAME = shellFamily() === 'powershell' ? 'PowerShell' : 'shell (sh/bash)'

const schema = z.object({
  command: z.string().min(1).describe(`${SHELL_NAME} command to run in the background, e.g. a dev server.`)
})

export const runBackgroundTool: ToolDef<typeof schema> = {
  name: 'run_background',
  description:
    'Start a long-running command (dev server, watcher, etc.) in the background. Returns immediately; the process keeps running and its output appears in the Background Tasks panel. Use this instead of run_shell for anything that does not exit on its own. Requires user approval.',
  schema,
  mutating: true,
  category: 'shell',
  preview(args): ToolPreview {
    return { kind: 'command', text: args.command }
  },
  async handler(args, ctx) {
    // Same workspace-deletion guard as run_shell — a backgrounded `rm -rf <workspace>` is just as destructive.
    const danger = dangerousRecursiveDelete(args.command, ctx.workspace.root)
    if (danger) return `ERROR: ${danger}`
    // Reuse an identical, still-running task instead of spawning a duplicate. The common failure this
    // prevents: the agent re-runs `npm run dev` every verify cycle, each instance binds a fresh port
    // (5174, 5175…), localhost floods, and the preview opens a stale/dead one → ERR_CONNECTION_REFUSED.
    const existing = bgTasks.findRunning(args.command, ctx.workspace.root)
    if (existing) {
      return `A background task with this exact command is already running (id ${existing}) — reusing it instead of starting a duplicate. Read its output with read_background("${existing}") to get the URL/port it bound, or stop_background("${existing}") to restart it.`
    }
    const MAX_RUNNING = 4
    if (bgTasks.runningCount() >= MAX_RUNNING) {
      return `ERROR: ${MAX_RUNNING} background tasks are already running — the maximum. Run list_background to see them, then stop_background(id) the ones you no longer need before starting another. Reuse an existing dev server rather than launching a second (forgotten servers pile up on new ports and hold them until the app quits).`
    }
    const id = bgTasks.start(args.command, ctx.workspace.root)
    return `Started background task ${id}: ${args.command}\nIt is now running — do NOT wait for it. If this is a dev server, call read_background("${id}") to get the actual URL/port it printed (it shifts to 5174/5175… if the default port was busy) and preview_open THAT url, not a hardcoded default.`
  }
}
