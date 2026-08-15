import fs from 'node:fs/promises'
import { z } from 'zod'
import { createTwoFilesPatch } from 'diff'
import type { ToolDef } from '../registry'
import type { ToolPreview } from '../../../shared/ipc-types'
import { aliasWriteArgs } from './argAliases'
import { LIMITS } from '../util'
import { writeTextAtomic } from '../fsutil'

/** Overwriting a substantial existing file with content that deletes most of its lines is the "recreate the whole
 *  file to fix one error" failure mode — a stuck model gutting working code. These bound when to block it. */
export const DESTRUCTIVE_MIN_LINES = 30
export const DESTRUCTIVE_SHRINK_RATIO = 0.5

/** Would overwriting `before` with `after` gut a substantial file? Only trips when the existing file is meaningful
 *  (>= MIN_LINES) AND the new content falls below SHRINK_RATIO of its line count — so growth, modest edits, and
 *  small files are never flagged. Pure → unit-tested. */
export function analyzeShrink(before: string, after: string): { destructive: boolean; beforeLines: number; afterLines: number } {
  const beforeLines = before.split('\n').length
  const afterLines = after.split('\n').length
  const destructive = beforeLines >= DESTRUCTIVE_MIN_LINES && afterLines < beforeLines * DESTRUCTIVE_SHRINK_RATIO
  return { destructive, beforeLines, afterLines }
}

// preprocess: recover alias keys (file→path, text/body→content) before validation — see argAliases.ts.
const schema = z.preprocess(
  aliasWriteArgs,
  z.object({
    path: z.string().describe('File path relative to the workspace root.'),
    content: z.string().describe('Full file content to write.'),
    allow_shrink: z
      .boolean()
      .optional()
      .describe(
        'Set TRUE only if you deliberately intend to replace most of an existing file (a real full rewrite). Default ' +
          'false BLOCKS an accidental gut of existing work — for changing one part, use edit_file/multi_edit instead.'
      )
  })
)

export const writeFileTool: ToolDef<typeof schema> = {
  name: 'write_file',
  description: 'Create a new file or overwrite an existing one with the given content. Requires user approval.',
  schema,
  mutating: true,
  category: 'edit',
  async preview(args, ctx): Promise<ToolPreview> {
    const abs = ctx.workspace.resolve(args.path)
    const existing = await fs.readFile(abs, 'utf8').catch(() => null)
    if (existing === null) {
      const head = args.content.split('\n').slice(0, 40).join('\n')
      return { kind: 'new-file', path: args.path, text: head }
    }
    return {
      kind: 'diff',
      path: args.path,
      unified: createTwoFilesPatch(args.path, args.path, existing, args.content)
    }
  },
  async handler(args, ctx) {
    if (Buffer.byteLength(args.content, 'utf8') > LIMITS.MAX_FILE_WRITE_BYTES) {
      return `ERROR: content exceeds the ${LIMITS.MAX_FILE_WRITE_BYTES}-byte limit.`
    }
    const abs = ctx.workspace.resolve(args.path)
    const existed = await fs
      .stat(abs)
      .then(() => true)
      .catch(() => false)
    if (existed && ctx.reads.neverFullyRead(abs)) {
      return `ERROR: ${args.path} already exists and has not been fully read this session. Use read_file (the whole file, not just a range) so you don't clobber it, or use edit_file for a targeted change.`
    }
    const stat = existed ? await fs.stat(abs).catch(() => null) : null
    if (stat && ctx.reads.isStale(abs, stat.mtimeMs)) {
      return `ERROR: ${args.path} changed on disk since you last read it. Use read_file again before overwriting it.`
    }
    const before = existed ? await fs.readFile(abs, 'utf8').catch(() => null) : null
    // Destructive-rewrite guard: a stuck model "recreating the whole file to fix one error" must not silently gut
    // existing work. Block a write that deletes most of a substantial file; steer to a surgical edit (or an explicit
    // allow_shrink for a deliberate full rewrite). The file has already been fully read by here (guard above).
    if (before !== null && !args.allow_shrink) {
      const s = analyzeShrink(before, args.content)
      if (s.destructive) {
        const dropped = s.beforeLines - s.afterLines
        return (
          `ERROR: this overwrites ${args.path} (${s.beforeLines} lines) with only ${s.afterLines} lines — deleting ` +
          `${dropped} lines (${Math.round((dropped / s.beforeLines) * 100)}%) of existing work. If you meant to change ` +
          `ONE part, use edit_file or multi_edit for a targeted change, NOT a full rewrite. If you are STUCK and ` +
          `rewriting to escape a problem, call escalate_to_lead instead of guessing. If you TRULY intend to replace ` +
          `the whole file, re-issue write_file with allow_shrink: true.`
        )
      }
    }
    ctx.snapshots.record(abs, before)
    await writeTextAtomic(abs, args.content)
    const after = await fs.stat(abs).catch(() => null)
    if (after) ctx.reads.record(abs, after.mtimeMs)
    const bytes = Buffer.byteLength(args.content, 'utf8')
    return `Wrote ${bytes} bytes to ${args.path} (${existed ? 'overwritten' : 'created'}).`
  }
}
