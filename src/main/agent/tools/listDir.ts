import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ToolDef } from '../registry'
import { LIMITS, humanSize } from '../util'

const SKIP = new Set(['node_modules', '.git', 'dist', 'out'])

const schema = z.object({
  path: z.string().default('.').describe('Directory relative to the workspace root.')
})

export const listDirTool: ToolDef<typeof schema> = {
  name: 'list_dir',
  description: 'List the entries of a directory (directories first, then files with sizes).',
  schema,
  mutating: false,
  async handler(args, ctx) {
    const abs = ctx.workspace.resolve(args.path)
    const stat = await fs.stat(abs).catch(() => null)
    if (!stat) return `ERROR: directory not found: ${args.path}`
    if (!stat.isDirectory()) return `ERROR: not a directory: ${args.path}`

    const entries = await fs.readdir(abs, { withFileTypes: true })
    const dirs = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
    const files = entries.filter((e) => !e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))

    const lines: string[] = []
    for (const d of dirs) {
      lines.push(SKIP.has(d.name) ? `[dir]  ${d.name}/  (skipped)` : `[dir]  ${d.name}/`)
    }
    for (const f of files) {
      if (lines.length >= LIMITS.MAX_LIST_ENTRIES) break
      const s = await fs.lstat(path.join(abs, f.name)).catch(() => null)
      lines.push(`[file] ${f.name}  (${s ? humanSize(s.size) : '?'})`)
    }
    const truncated =
      lines.length >= LIMITS.MAX_LIST_ENTRIES ? `\n... [truncated at ${LIMITS.MAX_LIST_ENTRIES} entries]` : ''
    return (lines.join('\n') || '(empty directory)') + truncated
  }
}
