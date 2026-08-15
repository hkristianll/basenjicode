import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ToolDef } from '../registry'
import type { ToolPreview } from '../../../shared/ipc-types'

const schema = z.object({
  from: z.string().describe('Existing file path (relative to the workspace root).'),
  to: z.string().describe('New file path (relative to the workspace root). Its parent dirs are created.')
})

export const moveFileTool: ToolDef<typeof schema> = {
  name: 'move_file',
  description:
    'Move or rename a file within the workspace. Snapshot-recorded so the turn can be undone. Refuses to overwrite ' +
    'an existing destination. Requires user approval.',
  schema,
  mutating: true,
  category: 'edit',
  preview(args): ToolPreview {
    return { kind: 'text', path: args.to, text: `Move ${args.from} → ${args.to}` }
  },
  async handler(args, ctx) {
    const absFrom = ctx.workspace.resolve(args.from)
    const absTo = ctx.workspace.resolve(args.to)
    const fromStat = await fs.stat(absFrom).catch(() => null)
    if (!fromStat) return `ERROR: source not found: ${args.from}`
    if (fromStat.isDirectory()) return `ERROR: ${args.from} is a directory; this tool only moves files.`
    if (absFrom === absTo) return `ERROR: source and destination are the same path.`
    const toExists = await fs
      .stat(absTo)
      .then(() => true)
      .catch(() => false)
    if (toExists) return `ERROR: destination already exists: ${args.to}. Delete it first or choose another name.`

    const content = await fs.readFile(absFrom, 'utf8').catch(() => null)
    // Undo: recreate `from` with its content, and delete `to` (it didn't exist before).
    ctx.snapshots.record(absFrom, content)
    ctx.snapshots.record(absTo, null)

    await fs.mkdir(path.dirname(absTo), { recursive: true })
    try {
      await fs.rename(absFrom, absTo)
    } catch (e) {
      // Cross-device (EXDEV) or similar — fall back to copy + remove.
      if ((e as NodeJS.ErrnoException)?.code === 'EXDEV') {
        await fs.copyFile(absFrom, absTo)
        await fs.rm(absFrom, { force: true })
      } else {
        throw e
      }
    }
    return `Moved ${args.from} → ${args.to}.`
  }
}
