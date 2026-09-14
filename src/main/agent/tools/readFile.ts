import fs from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDef } from '../registry'
import { LIMITS, humanSize, truncateMiddle } from '../util'
import { aliasPathArgs } from './argAliases'

// preprocess: recover an aliased path key (file/filename→path) before validation — see argAliases.ts.
const schema = z.preprocess(
  aliasPathArgs,
  z.object({
    path: z.string().describe('File path relative to the workspace root.'),
    start_line: z.number().int().min(1).optional().describe('1-based start line.'),
    end_line: z.number().int().min(1).optional().describe('1-based inclusive end line.')
  })
)

export const readFileTool: ToolDef<typeof schema> = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file, or a line range of it. Returns content prefixed with 1-based line numbers.',
  schema,
  mutating: false,
  async handler(args, ctx) {
    const abs = ctx.workspace.resolve(args.path)
    const stat = await fs.stat(abs).catch(() => null)
    if (!stat) return `ERROR: file not found: ${args.path}`
    if (stat.isDirectory()) return `ERROR: path is a directory: ${args.path}`
    // Don't slurp a giant file into the Electron main process (OOM/freeze). A ranged read is fine.
    const ranged = args.start_line !== undefined || args.end_line !== undefined
    if (!ranged && stat.size > LIMITS.MAX_READ_BYTES) {
      return `ERROR: file too large to read whole (${humanSize(stat.size)}). Pass start_line/end_line to read a slice, or grep it.`
    }

    const buf = await fs.readFile(abs)
    if (buf.includes(0)) return `ERROR: file appears to be binary: ${args.path}`
    // Only a FULL read arms write_file's clobber guard — a ranged read saw just a slice.
    ctx.reads.recordFileRead(abs, stat.mtimeMs, !ranged)

    const lines = buf.toString('utf8').split('\n')
    const start = Math.max(0, (args.start_line ?? 1) - 1)
    if (args.start_line !== undefined && start >= lines.length) {
      return `ERROR: start_line ${args.start_line} is past the end of ${args.path} (${lines.length} lines).`
    }
    const end = args.end_line ?? Math.min(lines.length, start + LIMITS.MAX_READ_LINES)
    const slice = lines.slice(start, end)
    const width = String(start + slice.length).length
    const body = slice
      .map((l, i) => `${String(start + i + 1).padStart(width, ' ')}| ${l}`)
      .join('\n')

    const truncated =
      args.end_line === undefined && lines.length > start + slice.length
        ? `\n... [truncated at ${slice.length} lines; pass start_line/end_line to read more]`
        : ''
    // R3: cap the result like every other read/run tool (run_shell/grep already do). read_file was the ONE tool
    // that returned its slice verbatim — 2000 wide/minified lines could inject 30-40k tokens into a single turn,
    // ballooning the worker/Brooke history toward the context cliff. Keep head+tail so the strong model still sees
    // the start and end of the file (don't blind-cut), just bounded.
    return truncateMiddle(body, LIMITS.MAX_TOOL_OUTPUT_CHARS) + truncated
  }
}
