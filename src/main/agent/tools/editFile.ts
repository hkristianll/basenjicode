import fs from 'node:fs/promises'
import { z } from 'zod'
import { createTwoFilesPatch } from 'diff'
import type { ToolDef } from '../registry'
import type { ToolPreview } from '../../../shared/ipc-types'
import { applyEdit } from './editing'
import { aliasEditArgs } from './argAliases'
import { LIMITS } from '../util'
import { writeTextAtomic } from '../fsutil'

// preprocess: recover common alias keys (file→path, old/new→old_string/new_string) before validation.
const schema = z.preprocess(
  aliasEditArgs,
  z.object({
    path: z.string().describe('File path relative to the workspace root.'),
    old_string: z.string().describe('Exact text to replace. Must be unique unless replace_all is set.'),
    new_string: z.string().describe('Replacement text.'),
    replace_all: z.boolean().optional().describe('Replace every occurrence instead of requiring a unique match.')
  })
)

export const editFileTool: ToolDef<typeof schema> = {
  name: 'edit_file',
  description:
    'Replace an exact snippet in a file. old_string must match exactly once, unless replace_all is true (then every ' +
    'occurrence is replaced — handy for renaming a symbol). If old_string does not match, read_file again to copy ' +
    'the exact current text (including whitespace), or fall back to write_file with the complete file. Requires user approval.',
  schema,
  mutating: true,
  category: 'edit',
  async preview(args, ctx): Promise<ToolPreview> {
    const abs = ctx.workspace.resolve(args.path)
    const existing = await fs.readFile(abs, 'utf8').catch(() => null)
    if (existing === null) {
      return { kind: 'text', path: args.path, text: `(file not found: ${args.path})` }
    }
    const res = applyEdit(existing, args)
    if ('error' in res) {
      return { kind: 'text', path: args.path, text: `(edit will fail: ${res.error})` }
    }
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
      return `ERROR: ${args.path} changed on disk since you last read it. Use read_file again, then re-issue the edit with up-to-date old_string.`
    }

    const res = applyEdit(existing, args)
    if ('error' in res) return `ERROR: ${res.error}`
    if (Buffer.byteLength(res.updated, 'utf8') > LIMITS.MAX_FILE_WRITE_BYTES) {
      return `ERROR: the edit would grow ${args.path} past the ${LIMITS.MAX_FILE_WRITE_BYTES}-byte limit (no changes written).`
    }

    ctx.snapshots.record(abs, existing)
    await writeTextAtomic(abs, res.updated)
    const after = await fs.stat(abs).catch(() => null)
    if (after) ctx.reads.record(abs, after.mtimeMs)
    const diff = createTwoFilesPatch(args.path, args.path, existing, res.updated)
    return `Applied edit to ${args.path}.\n${diff}`
  }
}
