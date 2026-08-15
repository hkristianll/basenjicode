import { z } from 'zod'
import type { ToolDef } from '../registry'
import { remember, forget } from '../memory'

const rememberSchema = z.object({
  fact: z
    .string()
    .min(1)
    .describe('ONE concise, durable fact worth recalling in a FUTURE session — a decision and why, a gotcha/workaround, where something important lives, or a user preference. One short line.')
})

export const rememberTool: ToolDef<typeof rememberSchema> = {
  name: 'remember',
  description:
    'Save a durable fact to project memory (.nordcode/memory.md), shown to you at the start of every future ' +
    'session. Use SPARINGLY — only non-obvious, cross-session facts (decisions + why, gotchas, where things ' +
    'live, user preferences). NEVER remember transient task state, or anything already in the code, git, or ' +
    'nordcode.md. Keep each fact to one short line; memory is capped and auto-drops the oldest entry when full.',
  schema: rememberSchema,
  mutating: false,
  async handler(args, ctx) {
    return remember(ctx.workspace.root, args.fact)
  }
}

const forgetSchema = z.object({
  query: z.string().min(1).describe('Text to match — every memory entry containing it (case-insensitive) is removed.')
})

export const forgetTool: ToolDef<typeof forgetSchema> = {
  name: 'forget',
  description:
    'Remove facts from project memory whose text contains `query`. Use it to prune a memory that has become ' +
    'wrong or obsolete (e.g. after a decision is reversed), so memory stays small and accurate.',
  schema: forgetSchema,
  mutating: false,
  async handler(args, ctx) {
    return forget(ctx.workspace.root, args.query)
  }
}
