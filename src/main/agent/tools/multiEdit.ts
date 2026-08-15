import fs from 'node:fs/promises'
import { z } from 'zod'
import { createTwoFilesPatch } from 'diff'
import type { ToolDef } from '../registry'
import type { ToolPreview } from '../../../shared/ipc-types'
import { applyEdits } from './editing'
import { aliasMultiEditArgs } from './argAliases'
import { LIMITS } from '../util'
import { writeTextAtomic } from '../fsutil'

const editSchema = z.object({
  old_string: z.string().describe('Exact text to replace.'),
  new_string: z.string().describe('Replacement text.'),
  replace_all: z.boolean().optional().describe('Replace every occurrence of this old_string.')
})

// preprocess: recover the common mis-shaped args weak models emit (file→path, old/new aliases, a single
// inline edit instead of an `edits` array) before validation — see argAliases.ts.
const schema = z.preprocess(
  aliasMultiEditArgs,
  z.object({
    path: z.string().describe('File path relative to the workspace root.'),
    edits: z.array(editSchema).min(1).describe('Edits applied in order; each sees the result of the previous one.')
  })
)

export const multiEditTool: ToolDef<typeof schema> = {
  name: 'multi_edit',
  description:
    'Apply several edits to one file in a single, atomic step (all-or-nothing). Edits run in order, each operating on ' +
    'the result of the previous. One approval, one undo entry. Requires user approval.',
  schema,
  mutating: true,
  category: 'edit',
  async preview(args, ctx): Promise<ToolPreview> {
    const abs = ctx.workspace.resolve(args.path)
    const existing = await fs.readFile(abs, 'utf8').catch(() => null)
    if (existing === null) return { kind: 'text', path: args.path, text: `(file not found: ${args.path})` }
    const res = applyEdits(existing, args.edits)
    if ('error' in res) return { kind: 'text', path: args.path, text: `(${res.error})` }
    return {
      kind: 'diff',
      path: args.path,
      unified: createTwoFilesPatch(args.path, args.path, existing, res.updated)
    }
  },
  async handler(args, ctx) {
    const abs = ctx.workspace.resolve(args.path)
    const existing = await fs.readFile(abs, 'utf8').catch(() => null)
    if (existing === null) return `ERROR: file not found: ${args.path}`

    const stat = await fs.stat(abs).catch(() => null)
    if (stat && ctx.reads.isStale(abs, stat.mtimeMs)) {
      return `ERROR: ${args.path} changed on disk since you last read it. Read it again before editing.`
    }

    const res = applyEdits(existing, args.edits)
    if ('error' in res) return `ERROR: ${res.error} (no changes written).`
    if (Buffer.byteLength(res.updated, 'utf8') > LIMITS.MAX_FILE_WRITE_BYTES) {
      return `ERROR: the edits would grow ${args.path} past the ${LIMITS.MAX_FILE_WRITE_BYTES}-byte limit (no changes written).`
    }

    ctx.snapshots.record(abs, existing)
    await writeTextAtomic(abs, res.updated)
    const after = await fs.stat(abs).catch(() => null)
    if (after) ctx.reads.record(abs, after.mtimeMs)
    const diff = createTwoFilesPatch(args.path, args.path, existing, res.updated)
    return `Applied ${res.applied} edit(s) to ${args.path}.\n${diff}`
  }
}
