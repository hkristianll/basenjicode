import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { ToolDef } from '../registry'
import { pathGlobToRegExp } from '../util'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.next', '.cache', '.turbo'])
const MAX_RESULTS = 300
const MAX_SCANNED = 60_000

const schema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe('Glob over workspace-relative paths, e.g. "**/*.test.ts", "src/**/*.tsx", "*.json".'),
  path: z.string().optional().describe('Optional subdirectory (relative to the workspace root) to search within.')
})

export const globTool: ToolDef<typeof schema> = {
  name: 'glob',
  description:
    'Find files by name/path pattern (NOT contents — use grep for contents). Returns workspace-relative paths ' +
    'sorted by most-recently modified. Supports **, *, and ?.',
  schema,
  mutating: false,
  async handler(args, ctx) {
    const root = ctx.workspace.root
    const start = args.path ? ctx.workspace.resolve(args.path) : root
    const startStat = await fs.promises.stat(start).catch(() => null)
    if (!startStat) return `ERROR: path not found: ${args.path}`
    if (!startStat.isDirectory()) return `ERROR: path is not a directory: ${args.path}`

    const re = pathGlobToRegExp(args.pattern)
    const matches: { rel: string; mtimeMs: number }[] = []
    const stack: string[] = [start]
    let scanned = 0
    let truncated = false

    while (stack.length && scanned < MAX_SCANNED) {
      const dir = stack.pop() as string
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        scanned++
        const full = path.join(dir, e.name)
        try {
          ctx.workspace.resolve(full) // keep symlinked entries from surfacing out-of-root paths
        } catch {
          continue
        }
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) stack.push(full)
          continue
        }
        const rel = path.relative(root, full).replace(/\\/g, '/')
        if (re.test(rel)) {
          if (matches.length >= MAX_RESULTS) {
            truncated = true
            continue
          }
          let mtimeMs = 0
          try {
            mtimeMs = fs.statSync(full).mtimeMs
          } catch {
            /* ignore */
          }
          matches.push({ rel, mtimeMs })
        }
      }
    }

    if (!matches.length) return `No files match ${args.pattern}${args.path ? ` under ${args.path}` : ''}.`
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const list = matches.map((m) => m.rel).join('\n')
    const note = truncated ? `\n... [more than ${MAX_RESULTS} matches; showing the ${MAX_RESULTS} most recent]` : ''
    return `${matches.length} match(es):\n${list}${note}`
  }
}
