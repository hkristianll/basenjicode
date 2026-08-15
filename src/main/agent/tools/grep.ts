import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ToolDef } from '../registry'
import { LIMITS, truncateMiddle, globToRegExp } from '../util'

const SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.next', '.cache'])

const schema = z.object({
  pattern: z.string().describe('Regular expression to search for.'),
  path: z.string().optional().describe('Subdirectory to search; defaults to the workspace root.'),
  glob: z.string().optional().describe('Only search files whose name matches this glob, e.g. "*.ts".')
})

export const grepTool: ToolDef<typeof schema> = {
  name: 'grep',
  description: 'Search file contents by regular expression. Returns matching lines as "path:line: text".',
  schema,
  mutating: false,
  async handler(args, ctx) {
    let re: RegExp
    try {
      re = new RegExp(args.pattern)
    } catch (e) {
      return `ERROR: invalid regular expression: ${(e as Error).message}`
    }
    const globRe = args.glob ? globToRegExp(args.glob) : null
    const root = ctx.workspace.resolve(args.path ?? '.')

    const matches: string[] = []
    let fileCount = 0
    const stack: string[] = [root]

    while (stack.length) {
      if (ctx.signal.aborted) break
      const dir = stack.pop() as string
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        // Re-validate every entry through the sandbox so a symlink/junction can't escape the workspace.
        try {
          ctx.workspace.resolve(full)
        } catch {
          continue
        }
        if (e.isDirectory()) {
          if (!SKIP.has(e.name)) stack.push(full)
          continue
        }
        if (globRe && !globRe.test(e.name)) continue
        // Skip huge files (vendored bundles, lockfiles, logs) — slurping them freezes the main process.
        try {
          const st = await fs.stat(full)
          if (st.size > LIMITS.MAX_GREP_FILE_BYTES) continue
        } catch {
          continue
        }
        let buf: Buffer
        try {
          buf = await fs.readFile(full)
        } catch {
          continue
        }
        if (buf.includes(0)) continue // skip binary files
        fileCount++
        const rel = path.relative(ctx.workspace.root, full)
        const lines = buf.toString('utf8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matches.push(`${rel}:${i + 1}: ${lines[i].slice(0, 200)}`)
            if (matches.length >= LIMITS.MAX_GREP_MATCHES) break
          }
        }
        if (matches.length >= LIMITS.MAX_GREP_MATCHES) break
      }
      if (matches.length >= LIMITS.MAX_GREP_MATCHES) break
    }

    if (matches.length === 0) return 'No matches.'
    const capped = matches.length >= LIMITS.MAX_GREP_MATCHES ? '+' : ''
    const header = `${matches.length}${capped} matches across ${fileCount} files:\n`
    return truncateMiddle(header + matches.join('\n'))
  }
}
