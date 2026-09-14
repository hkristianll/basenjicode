// Change a CHAT session's working folder (the sandbox root file tools and the shell operate in). The gap this
// closes: "make a new folder for the new project" used to end with the agent creating a subfolder while every
// tool, the Git panel, and the prompt stayed rooted in the old project. Board/manager sessions never get the
// backing capability (ctx.setWorkspaceRoot) — a worker re-rooting mid-ticket would corrupt its run.
import { z } from 'zod'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ToolDef } from '../registry'

const schema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'Directory to become the working folder. A relative path resolves against the current working folder. ' +
        'Must already exist — create it first (run_shell mkdir) if needed.'
    )
})

/** Structural guards on an already-realpathed directory. Returns a refusal reason, or null when acceptable.
 *  Pure → unit-tested. The sandbox check is deliberately absent: moving OUTSIDE the current root is the point;
 *  these rules replace it for the one path a re-root can take. */
export function refuseWorkingFolder(real: string, home = os.homedir()): string | null {
  const { root } = path.parse(real)
  if (real === root) return 'refusing a filesystem root as the working folder'
  if (real === path.resolve(home)) return 'refusing the home directory itself; pick or create a project folder inside it'
  // Hidden directories hold config and credentials (~/.ssh, ~/.config, ~/.nordcode) — never a project root.
  const segments = real.slice(root.length).split(path.sep)
  if (segments.some((s) => s.startsWith('.'))) return 'refusing a folder under a hidden (dot) directory'
  return null
}

export const setWorkingFolderTool: ToolDef<typeof schema> = {
  name: 'set_working_folder',
  description:
    "Change this chat's working folder — the root that file tools, the shell, and the Git panel operate in. " +
    'Use it after creating a folder for a new project, or when the user asks to work somewhere else. ' +
    'The target must be an existing directory. This does not move or copy any files.',
  schema,
  mutating: true,
  async handler(args, ctx) {
    if (!ctx.setWorkspaceRoot) {
      return 'ERROR: this session type cannot change its working folder. Work within the current folder.'
    }
    const target = path.isAbsolute(args.path) ? path.resolve(args.path) : path.resolve(ctx.workspace.root, args.path)
    let real: string
    try {
      real = fs.realpathSync.native(target)
    } catch {
      return `ERROR: "${args.path}" does not exist. Create the folder first (e.g. run_shell mkdir), then switch.`
    }
    if (!fs.statSync(real).isDirectory()) return `ERROR: "${args.path}" is a file, not a directory.`
    const refusal = refuseWorkingFolder(real)
    if (refusal) return `ERROR: ${refusal}.`
    const root = ctx.setWorkspaceRoot(real)
    return (
      `Working folder is now ${root}. File paths and shell commands resolve here from this point on; ` +
      'paths under the previous folder are out of scope. Re-read any file before editing it.'
    )
  }
}
