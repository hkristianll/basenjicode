import fs from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDef } from '../registry'
import type { ToolPreview } from '../../../shared/ipc-types'

const schema = z.object({
  path: z.string().describe('File path (relative to the workspace root) to delete.')
})

export const deleteFileTool: ToolDef<typeof schema> = {
  name: 'delete_file',
  description:
    'Delete a single file. Snapshot-recorded so the turn can be undone (unlike Remove-Item via run_shell). ' +
    'Refuses directories. Requires user approval.',
  schema,
  mutating: true,
  category: 'edit',
  async preview(args, ctx): Promise<ToolPreview> {
    const abs = ctx.workspace.resolve(args.path)
    const existing = await fs.readFile(abs, 'utf8').catch(() => null)
    const head = existing ? existing.split('\n').slice(0, 20).join('\n') : '(file not found or binary)'
    return { kind: 'text', path: args.path, text: `Delete ${args.path}\n\n${head}` }
  },
  async handler(args, ctx) {
    const abs = ctx.workspace.resolve(args.path)
    const stat = await fs.stat(abs).catch(() => null)
    if (!stat) return `ERROR: file not found: ${args.path}`
    if (stat.isDirectory()) return `ERROR: ${args.path} is a directory; this tool only deletes files.`
    // Same stale-read guard as the write tools: don't delete a file that changed since the model last
    // read it (it may be acting on a stale view of what the file contains).
    if (ctx.reads.isStale(abs, stat.mtimeMs)) {
      return `ERROR: ${args.path} changed on disk since you last read it. Use read_file again before deleting it.`
    }
    // Capture content first so Undo can restore it.
    const before = await fs.readFile(abs, 'utf8').catch(() => null)
    ctx.snapshots.record(abs, before)
    await fs.rm(abs, { force: true })
    return `Deleted ${args.path}.`
  }
}
