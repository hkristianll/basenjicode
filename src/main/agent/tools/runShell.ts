import { z } from 'zod'
import type { ToolDef } from '../registry'
import type { ToolPreview } from '../../../shared/ipc-types'
import { runShell, shellFamily, type ShellResult } from '../../shell/powershell'
import { LIMITS, truncateMiddle } from '../util'
import { dangerousRecursiveDelete } from './deleteGuard'

const SHELL_NAME = shellFamily() === 'powershell' ? 'PowerShell' : 'shell (sh/bash)'

const schema = z.object({
  command: z.string().min(1).describe(`${SHELL_NAME} command to run in the workspace root.`)
})

/**
 * Map a common shell failure to a one-line corrective hint, appended to the tool result so the model
 * fixes the command on the NEXT turn instead of repeating the same broken one (the most common "it's
 * stuck" complaint). Branches by shell family. Returns null when nothing actionable is recognised.
 */
export function shellHint(command: string, res: ShellResult): string | null {
  const err = res.stderr
  // Platform-agnostic: a long-running command run in the foreground that timed out.
  if (res.timedOut && /\b(serve|dev|watch|start|http-server|vite|next|nodemon|webpack|tsc -w)\b/i.test(command)) {
    return 'This command looks long-running and timed out. Start it with run_background instead of run_shell.'
  }
  if (process.platform === 'win32') {
    if (/not a valid statement separator|token '&&'|token '\|\|'/i.test(err)) {
      return "PowerShell can't chain with '&&' or '||'. Use ';' instead (or 'A; if ($?) { B }' to run B only on success)."
    }
    if (/running scripts is disabled|\.ps1.*cannot be loaded|because running scripts/i.test(err)) {
      return "A .ps1 launcher was blocked by the execution policy. Call the .cmd/.exe directly (npm.cmd, npx.cmd) or use 'node' instead."
    }
    if (/is not recognized as the name of a cmdlet/i.test(err) && /^\s*(rm|cp|mv|ls|cat|touch|grep|which)\b/.test(command)) {
      return 'That looks like a Unix command. Use PowerShell cmdlets: Remove-Item, Copy-Item, Move-Item, Get-ChildItem, Get-Content.'
    }
    return null
  }
  // POSIX (macOS/Linux).
  if (/command not found|not recognized/i.test(err) && /\b(Remove-Item|Copy-Item|Move-Item|Get-ChildItem|Get-Content|New-Item)\b/.test(command)) {
    return 'That looks like a PowerShell cmdlet. Use Unix tools: rm, cp, mv, ls, cat, mkdir -p.'
  }
  if (/permission denied/i.test(err)) {
    return 'Permission denied. Make the file executable (chmod +x) or invoke it with the right interpreter (e.g. "node x", "sh x").'
  }
  return null
}

export const runShellTool: ToolDef<typeof schema> = {
  name: 'run_shell',
  description: `Run a ${SHELL_NAME} command in the workspace directory. Captures stdout, stderr, and exit code. Requires user approval.`,
  schema,
  mutating: true,
  category: 'shell',
  timeoutMs: LIMITS.SHELL_TIMEOUT_MS,
  preview(args): ToolPreview {
    return { kind: 'command', text: args.command }
  },
  async handler(args, ctx) {
    // Safety: never let the agent recursively delete its own workspace (or a parent / filesystem root).
    // Subfolder deletes still pass. This is a hard refusal even in Auto mode — a looping model once wiped a
    // whole project this way. Targeted file/subdir deletes remain allowed.
    const danger = dangerousRecursiveDelete(args.command, ctx.workspace.root)
    if (danger) return `ERROR: ${danger}`
    const res = await runShell({
      command: args.command,
      cwd: ctx.workspace.root,
      timeoutMs: LIMITS.SHELL_TIMEOUT_MS,
      signal: ctx.signal
    })
    const half = Math.floor(LIMITS.MAX_TOOL_OUTPUT_CHARS / 2)
    const out = truncateMiddle(res.stdout.trim() || '(no stdout)', half)
    const err = truncateMiddle(res.stderr.trim() || '(no stderr)', half)
    const status = res.timedOut ? `timed out after ${LIMITS.SHELL_TIMEOUT_MS}ms` : `exit code: ${res.code}`
    const hint = shellHint(args.command, res)
    return `${status}\n--- stdout ---\n${out}\n--- stderr ---\n${err}${hint ? `\n--- hint ---\n${hint}` : ''}`
  }
}
