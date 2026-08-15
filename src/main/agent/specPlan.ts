// Pure, model-free logic for Hermes decomposition: parse the decompose turn's JSON plan, validate it, and
// resolve the in-plan dependency graph into a safe board-creation order. Heavy/model-bound steps (running the
// turn, writing to the board) live in specOrchestrator.ts; everything here unit-tests headless.
import { z } from 'zod'

/** The departments Hermes' agents can belong to — the suggested set the decompose/critic turns pick from so
 *  each ticket is owned by a specialized "team". Free-form is tolerated (weak models drift), then normalized. */
export const DEPARTMENTS = ['architecture', 'implementation', 'design', 'testing', 'review', 'docs'] as const
export type Department = (typeof DEPARTMENTS)[number]

/** Normalize a model-supplied role string to one of the known departments (default: implementation). */
export function normalizeRole(role: string | undefined | null): Department {
  const r = (role ?? '').trim().toLowerCase()
  if (!r) return 'implementation'
  // UI/UX/front-end work → design. Checked BEFORE architecture (which used to swallow "design"). `\bu[ix]\b`
  // matches "ui"/"ux" as whole words only, so it never fires on "build"/"guide".
  if (/\bu[ix]\b|ui\/ux|ui-ux|front-?end|visual|css|styl|design/.test(r)) return 'design'
  if (/(arch|scaffold|plan)/.test(r)) return 'architecture'
  if (/(test|qa|verify|spec)/.test(r)) return 'testing'
  if (/(review|audit|critic|lead)/.test(r)) return 'review'
  if (/(doc|readme|guide|writ)/.test(r)) return 'docs'
  return (DEPARTMENTS as readonly string[]).includes(r) ? (r as Department) : 'implementation'
}

/** The department a ticket belongs to, parsed from its body banner ("**Department: …**"), normalized. Null
 *  when the ticket carries no banner (pre-departments tickets). Shared by the worker (to pick a registry),
 *  the flow (review → done), and the UI (badges). */
export function departmentOf(body: string | undefined | null): Department | null {
  const m = /\*\*Department:\s*([a-zA-Z]+)/.exec(body ?? '')
  return m ? normalizeRole(m[1]) : null
}

/** The file path(s) a ticket DECLARES it owns, parsed from its body banner ("**Files:** src/a.ts, src/b.ts").
 *  The parallel executor uses this to batch only file-DISJOINT tickets and serialize ones that share a file.
 *  Returns [] when none declared. */
export function filesOf(body: string | undefined | null): string[] {
  const m = /\*\*Files:\*\*\s*([^\n]+)/i.exec(body ?? '')
  if (!m) return []
  return m[1]
    .split(/[,\s]+/)
    .map((s) => s.trim().replace(/[`'"]+/g, '').replace(/[.,;]+$/, ''))
    .filter(Boolean)
}

/** One unit of work the decompose turn proposes. `deps` are LOCAL indices into the plan's own `tickets`
 *  array (0-based) — NOT board ids — because the model can't know ids that don't exist yet. */
export const planTicketSchema = z.object({
  title: z.string().trim().min(1, 'ticket title is required'),
  body: z.string().default(''),
  /** Shell command the check-gate runs to verify the ticket. Hermes asks for one per ticket. */
  check: z.string().optional(),
  /** Owning department/team (architecture|implementation|testing|review|docs). Normalized on use. */
  role: z.string().optional(),
  /** Local indices (into this plan's tickets[]) that must be done first. */
  deps: z.array(z.number().int()).optional(),
  priority: z.number().int().optional(),
  /** File path(s) this ticket OWNS / creates — the planner declares them so the parallel executor can batch only
   *  tickets whose files are DISJOINT (and serialize ones that share a file). A best-effort plan-time hint; the
   *  runtime file-overlap check is the backstop. */
  files: z.array(z.string()).optional()
})

/** Hard ceiling on a single decompose. A weak model handed a big goal over-fans (the 237-ticket pathology);
 *  each ticket is a fresh ~100k worker session + a possible reviewer swap. A `.max()` here makes parsePlan
 *  reject an over-fan, which runDecompose feeds back to the model as a correction (reject-and-repair) — never
 *  truncates the array (that would orphan deps). Tune N from real board data. Raised 40→60 to give the finer
 *  slicing (one cohesive deliverable per ticket + impl tickets that carry their own focused test) room to breathe. */
export const MAX_DECOMPOSE_TICKETS = 60

export const decomposePlanSchema = z.object({
  /** The shared spec, stored project-level so the replan turn (and a human) can read the original intent. */
  spec: z.string().default(''),
  tickets: z
    .array(planTicketSchema)
    .min(1, 'plan must contain at least one ticket')
    .max(MAX_DECOMPOSE_TICKETS, `too many tickets (max ${MAX_DECOMPOSE_TICKETS}); merge into fewer real vertical slices`)
})

export type PlanTicket = z.infer<typeof planTicketSchema>
export type DecomposePlan = z.infer<typeof decomposePlanSchema>

/** Pull the first balanced top-level JSON object out of a model response that may wrap it in prose, ```json
 *  fences, or <tool_call> tags. Returns the raw object substring, or null if none is found. */
export function extractJsonObject(text: string): string | null {
  if (!text) return null
  // Strip the most common fence so the brace scan starts clean; harmless if absent.
  const unfenced = text.replace(/```(?:json)?/gi, '')
  const start = unfenced.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < unfenced.length; i++) {
    const c = unfenced[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return unfenced.slice(start, i + 1)
    }
  }
  return null // unbalanced — let the caller surface a parse error
}

/** Parse + validate a decompose turn's output into a DecomposePlan. Throws with an actionable message the
 *  orchestrator can feed back to the model on a retry. */
export function parsePlan(text: string): DecomposePlan {
  const json = extractJsonObject(text)
  if (!json) throw new Error('no JSON object found in the decompose output')
  let obj: unknown
  try {
    obj = JSON.parse(json)
  } catch (e) {
    throw new Error(`decompose output is not valid JSON: ${(e as Error).message}`)
  }
  const res = decomposePlanSchema.safeParse(obj)
  if (!res.success) {
    const first = res.error.issues[0]
    throw new Error(`decompose plan invalid: ${first.path.join('.') || '(root)'} — ${first.message}`)
  }
  return res.data
}

/* ----- Replan: the diff the replan turn emits against the LIVE board between drain settlements ----- */

/** A ticket the replan turn wants to add. Unlike a decompose PlanTicket, `deps` here are REAL board ids that
 *  already exist (the replan turn sees the live board), so no local-index resolution is needed. */
export const replanAddSchema = z.object({
  title: z.string().trim().min(1, 'added ticket needs a title'),
  body: z.string().default(''),
  check: z.string().optional(),
  /** Owning department/team — same set as decompose. Normalized on use. */
  role: z.string().optional(),
  deps: z.array(z.number().int().positive()).optional(),
  priority: z.number().int().optional()
})

export const replanDiffSchema = z.object({
  /** New tickets (split out of a parked ticket, or newly discovered work). */
  add: z.array(replanAddSchema).max(MAX_DECOMPOSE_TICKETS, `too many added tickets (max ${MAX_DECOMPOSE_TICKETS})`).default([]),
  /** Ids of now-obsolete tickets to cancel (cancelled clears them as deps for everything downstream). */
  cancel: z.array(z.number().int().positive()).default([]),
  /** Ids of review tickets to re-engage for another pass. */
  reopen: z.array(z.number().int().positive()).default([]),
  /** A short human-readable rationale for this round (shown on the replan timeline). */
  note: z.string().default('')
})

export type ReplanAdd = z.infer<typeof replanAddSchema>
export type ReplanDiff = z.infer<typeof replanDiffSchema>

/** Parse + validate a replan turn's output. Throws with an actionable message (fed back on retry). */
export function parseReplan(text: string): ReplanDiff {
  const json = extractJsonObject(text)
  if (!json) throw new Error('no JSON object found in the replan output')
  let obj: unknown
  try {
    obj = JSON.parse(json)
  } catch (e) {
    throw new Error(`replan output is not valid JSON: ${(e as Error).message}`)
  }
  const res = replanDiffSchema.safeParse(obj)
  if (!res.success) {
    const first = res.error.issues[0]
    throw new Error(`replan diff invalid: ${first.path.join('.') || '(root)'} — ${first.message}`)
  }
  return res.data
}

/** A replan that asks for no change — the signal to stop the long-running cycle (the model has nothing more). */
export function isReplanEmpty(diff: ReplanDiff): boolean {
  return diff.add.length === 0 && diff.cancel.length === 0 && diff.reopen.length === 0
}

/** True when every ticket is in a terminal state (done/cancelled) — the goal is met, end the orchestrator. */
export function allSettled(tickets: { status: string }[]): boolean {
  return tickets.length > 0 && tickets.every((t) => t.status === 'done' || t.status === 'cancelled')
}

/**
 * Topologically order the plan's tickets so every ticket is created AFTER its deps (the board rejects a dep to
 * a not-yet-existing ticket). Returns the local indices in a safe creation order. Throws on an out-of-range
 * dep, a self-dep, or a cycle — all of which would otherwise wedge board creation.
 */
export function orderForCreate(tickets: PlanTicket[]): number[] {
  const n = tickets.length
  const deps = tickets.map((t, i) => {
    const ds = t.deps ?? []
    for (const d of ds) {
      if (!Number.isInteger(d) || d < 0 || d >= n) throw new Error(`ticket ${i} has out-of-range dep ${d} (expected 0..${n - 1})`)
      if (d === i) throw new Error(`ticket ${i} depends on itself`)
    }
    return Array.from(new Set(ds))
  })
  // Kahn's algorithm: emit nodes whose deps are all already emitted.
  const indegree = deps.map((d) => d.length)
  const order: number[] = []
  const ready: number[] = []
  for (let i = 0; i < n; i++) if (indegree[i] === 0) ready.push(i)
  ready.sort((a, b) => a - b) // deterministic order among independent tickets
  // Build reverse edges: who depends on i.
  const dependents: number[][] = Array.from({ length: n }, () => [])
  deps.forEach((ds, i) => ds.forEach((d) => dependents[d].push(i)))
  while (ready.length) {
    const i = ready.shift()!
    order.push(i)
    for (const j of dependents[i]) {
      if (--indegree[j] === 0) {
        ready.push(j)
        ready.sort((a, b) => a - b)
      }
    }
  }
  if (order.length !== n) throw new Error('plan dependencies contain a cycle')
  return order
}
