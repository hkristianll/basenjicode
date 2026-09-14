import { z } from 'zod'
import type { Workspace } from './workspace'
import type { ChatTool } from './lmstudio'
import type { ToolPreview } from '../../shared/ipc-types'
import type { TodoItem, ImageConfig } from '../../shared/domain-types'

/** Lets the todo_write tool update the session's working task list (and stream it to the UI). */
export interface TodoController {
  set(items: TodoItem[]): void
  get(): TodoItem[]
}

/** Remembers which files were read this session (with their mtime) to guard edits against stale reads. */
export class ReadTracker {
  private mtimes = new Map<string, number>()
  /** Actual read_file targets (record() is also used after writes to refresh stale-read guards). */
  private fileReads = new Set<string>()
  /** Paths read in FULL (not just a line range) — the clobber guard requires a full read. */
  private fullReads = new Set<string>()
  record(absPath: string, mtimeMs: number, full = true): void {
    this.mtimes.set(absPath, mtimeMs)
    if (full) this.fullReads.add(absPath)
  }
  recordFileRead(absPath: string, mtimeMs: number, full = true): void {
    this.record(absPath, mtimeMs, full)
    this.fileReads.add(absPath)
  }
  readPaths(): string[] {
    return [...this.fileReads]
  }
  isStale(absPath: string, currentMtimeMs: number): boolean {
    const seen = this.mtimes.get(absPath)
    return seen !== undefined && currentMtimeMs > seen + 1
  }
  neverRead(absPath: string): boolean {
    return !this.mtimes.has(absPath)
  }
  /** True unless the file was read in FULL — a partial ranged read must NOT satisfy the clobber guard,
   *  or the model can overwrite a large file after seeing only a single line of it. */
  neverFullyRead(absPath: string): boolean {
    return !this.fullReads.has(absPath)
  }
}

/** Captures the pre-edit content of every file a turn touches, so the turn can be rolled back. */
export class SnapshotRecorder {
  private edits = new Map<string, string | null>()
  record(absPath: string, before: string | null): void {
    // Keep only the first capture per path = the true pre-turn state.
    if (!this.edits.has(absPath)) this.edits.set(absPath, before)
  }
  list(): { path: string; before: string | null }[] {
    return [...this.edits.entries()].map(([path, before]) => ({ path, before }))
  }
  get count(): number {
    return this.edits.size
  }
}

export interface ToolContext {
  workspace: Workspace
  signal: AbortSignal
  reads: ReadTracker
  snapshots: SnapshotRecorder
  /** Present during a live turn; used by todo_write to publish the task list. */
  todos?: TodoController
  /** The board project this session manages — set for Brooke so her control tools resolve HER project's
   *  controller (each project's manager is independently instanced). Unset for ordinary coding sessions. */
  hermesProject?: string
  /** Image-generation backend config (generate_image). */
  images?: ImageConfig
  /** Attach image data URLs to the running tool's result so the UI can show them inline. With `toModel: true`
   *  the images are ALSO fed back to the model (as a follow-up user message) so a vision-capable model can SEE
   *  them — e.g. preview_screenshot for visual review. Default (UI-only) preserves generate_image's behavior. */
  attachImages?: (dataUrls: string[], opts?: { toModel?: boolean }) => void
  /** Chat-only capability: re-root this session's sandbox at an existing directory (set_working_folder) and
   *  return the canonical new root. Absent for board/manager sessions — a worker must never re-root mid-ticket. */
  setWorkspaceRoot?: (absPath: string) => string
}

export interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  schema: S
  /** Pre-built JSON Schema for the parameters, advertised to the model verbatim instead of converting
   *  `schema`. Used by MCP tools, whose params arrive as JSON Schema from the upstream server (and whose
   *  `schema` is then a permissive passthrough so the loop's safeParse forwards the args untouched). */
  paramsJsonSchema?: Record<string, unknown>
  /** Mutating tools require approval; non-mutating tools auto-run. */
  mutating: boolean
  /** Drives "accept edits" mode: 'edit' tools auto-approve, 'shell' still prompts. */
  category?: 'read' | 'edit' | 'shell'
  timeoutMs?: number
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<string>
  /** Optional approval preview (diff / command / new-file head). */
  preview?: (args: z.infer<S>, ctx: ToolContext) => ToolPreview | Promise<ToolPreview>
}

export class ToolRegistry {
  private map = new Map<string, ToolDef>()

  register<S extends z.ZodTypeAny>(def: ToolDef<S>): void {
    this.map.set(def.name, def as unknown as ToolDef)
  }

  get(name: string): ToolDef | undefined {
    return this.map.get(name)
  }

  /** Remove a tool (used to refresh the external MCP tool set when servers change). */
  unregister(name: string): void {
    this.map.delete(name)
  }

  /** A NEW registry with the same tools minus the named ones (shares the ToolDefs; the original is untouched).
   *  Used to deny board-driving tools to a per-ticket worker — a worker that can `claim_next` steamrolls the
   *  whole board itself, bypassing the orchestrator's gates and replan loop. */
  without(names: Iterable<string>): ToolRegistry {
    const exclude = new Set(names)
    const r = new ToolRegistry()
    for (const def of this.map.values()) if (!exclude.has(def.name)) r.register(def)
    return r
  }

  list(): ToolDef[] {
    return [...this.map.values()]
  }

  toOpenAITools(): ChatTool[] {
    return this.list().map((d) => ({
      type: 'function',
      function: {
        name: d.name,
        description: d.description,
        parameters: d.paramsJsonSchema ?? toJsonSchema(d.schema)
      }
    }))
  }
}

function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>
  delete js.$schema
  return js
}
