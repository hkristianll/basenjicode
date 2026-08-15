import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { ToolDef } from '../registry'
import { ToolRegistry } from '../registry'
import type { ToolPreview } from '../../../shared/ipc-types'
import type { AgentEvent } from '../../../shared/ipc-types'
import { AgentSession } from '../loop'
import { createConnectionClient } from '../lmstudio'
import { ensureModelLoaded } from '../../lmstudio/loadModel'
import { loadSettings } from '../../store/settings'
import { activeConnection } from '../../../shared/domain-types'
import { readFileTool } from './readFile'
import { listDirTool } from './listDir'
import { grepTool } from './grep'
import { globTool } from './glob'
import { webTools } from './web'
import { truncateMiddle } from '../util'

const schema = z.object({
  task: z
    .string()
    .min(1)
    .describe(
      'The self-contained task for the sub-agent. It does NOT see this conversation — include every file path, name, and piece of context it needs to do the job and report back.'
    ),
  connection: z
    .string()
    .optional()
    .describe(
      'Connection id or label to run the sub-agent on (default: the active backend). Route hard analysis to a stronger model, or cheap scans to a faster/cheaper one.'
    )
})

/**
 * Read-only research tools for a sub-agent: explore + report, never mutate. Built here (not via
 * buildRegistry) so a sub-agent can't edit files, run shell, or recursively spawn more sub-agents.
 */
export function childRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  r.register(readFileTool)
  r.register(listDirTool)
  r.register(grepTool)
  r.register(globTool)
  for (const t of webTools) r.register(t)
  return r
}

/**
 * Delegate a self-contained sub-task to a child AgentSession running on a CHOSEN backend connection.
 * The keystone payoff of multi-backend: route a hard sub-task to a strong API model while the main
 * chat stays on a fast local one (or vice-versa). The sub-agent is read-only (it explores with
 * read/grep/glob/list/web and writes nothing) and returns its findings as text into the parent turn.
 */
export const taskTool: ToolDef<typeof schema> = {
  name: 'task',
  description:
    'Delegate a self-contained, read-only sub-task to a sub-agent that explores the codebase (read_file, grep, glob, list_dir, web_fetch/web_search) and reports back a written answer. It runs on a chosen backend connection, so you can route hard analysis to a stronger model. The sub-agent cannot edit files or run shell. Returns its findings as text. Use it to parallelize investigation or to get a second model\'s read on something.',
  schema,
  mutating: true, // approval-gated: a sub-agent can burn tokens/cost on a remote backend
  timeoutMs: 600_000,
  preview(args): ToolPreview {
    const on = args.connection ? ` on “${args.connection}”` : ''
    return { kind: 'command', text: `Spawn sub-agent${on}:\n${args.task.slice(0, 400)}` }
  },
  async handler(args, ctx) {
    const settings = loadSettings()
    const want = args.connection?.trim().toLowerCase()
    const conn =
      (want && settings.connections.find((c) => c.id.toLowerCase() === want || c.label.toLowerCase() === want)) ||
      activeConnection(settings)
    if (!conn.model) {
      return `ERROR: connection "${conn.label}" has no model set — pick a connection that has a model, or set one in Settings.`
    }

    let ctxLimit = conn.contextLimitTokens ?? settings.contextLimitTokens
    // For an LM Studio child, pin the model to the window and clamp to what's ACTUALLY loaded — exactly
    // what the main turn does (ipc.ts ensureModelForTurn). Otherwise a JIT-reloaded local model runs at
    // its smaller default context and the child silently overflows. Best-effort; no-op for other kinds.
    if (conn.kind === 'lmstudio') {
      try {
        const res = await ensureModelLoaded(conn.baseURL, conn.model, ctxLimit)
        if (typeof res.ctx === 'number' && res.ctx > 0) ctxLimit = Math.min(ctxLimit, res.ctx)
      } catch {
        /* best-effort — fall back to LM Studio's own JIT load */
      }
    }

    const child = new AgentSession({
      id: `sub-${randomUUID().slice(0, 8)}`,
      workspaceRoot: ctx.workspace.root,
      client: createConnectionClient(conn),
      registry: childRegistry(),
      config: {
        model: conn.model,
        temperature: conn.temperature ?? settings.temperature,
        maxTokens: conn.maxTokens ?? settings.maxTokens,
        // A bounded budget so a delegated task can't run away; the parent can re-delegate if needed.
        maxTurns: 15,
        contextLimitTokens: ctxLimit,
        connectionKind: conn.kind,
        connectionLabel: conn.label
      },
      mode: 'plan', // read-only: the sub-agent investigates and reports; it never mutates the workspace
      history: []
    })

    // Wire the parent's cancel/timeout to the child so stopping the turn (or the 10-min cap) ends it too.
    const onAbort = (): void => child.cancel()
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    // Capture the stop reason (error OR notice, e.g. "hit the step limit" / "empty response") so an
    // unfinished sub-agent reports WHY instead of silently returning a stale mid-investigation line.
    let stopNote = ''
    const emit = (e: AgentEvent): void => {
      if (e.type === 'turn-done') stopNote = e.error || e.notice || stopNote
    }
    try {
      await child.runTurn(args.task, randomUUID(), emit)
    } catch (e) {
      return `ERROR: sub-agent failed — ${e instanceof Error ? e.message : String(e)}`
    } finally {
      ctx.signal.removeEventListener('abort', onAbort)
    }

    const header = `[sub-agent · ${conn.label}${conn.model ? ` · ${conn.model}` : ''}]\n`
    // A clean answer is the FINAL assistant message with text and no pending tool calls. If the last
    // assistant message instead carries tool calls (the child stopped mid-step: cancelled, errored, or
    // hit max-turns), don't pass off an earlier line as the conclusion — mark it incomplete.
    const last = [...child.getHistory()].reverse().find((m) => m.role === 'assistant')
    const text = last?.content?.trim() ?? ''
    const finishedCleanly = !!text && !(last?.toolCalls && last.toolCalls.length)
    if (finishedCleanly) {
      return header + truncateMiddle(text, 24_000)
    }
    const reason = stopNote || 'the sub-agent stopped before writing a final answer (it may have hit its step limit)'
    const partial = text ? `\n\nIts last partial output:\n${truncateMiddle(text, 12_000)}` : ''
    return `${header}(incomplete) ${reason}${partial}`
  }
}
