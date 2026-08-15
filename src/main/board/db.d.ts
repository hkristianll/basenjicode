// Type declarations for the verbatim-copied board store (db.js). Kept as a .d.ts (not a TS port) so the
// concurrency-critical store ships byte-identical to the proven ticket-board source — zero behavior drift.

export const STATUSES: readonly string[]

export class ValidationError extends Error {}
export class NotFoundError extends Error {}
export class ConflictError extends Error {}

export interface Ticket {
  id: number
  project: string
  title: string
  body: string
  status: string
  priority: number
  assignee: string | null
  deps: number[]
  spec_ref: string | null
  check: string | null
  created_at: string
  updated_at: string
  ready?: boolean
  blocked?: boolean
  blocked_by?: number[]
  comments?: unknown[]
}

export interface Spec {
  project: string
  title: string | null
  content: string
  updated_at: string
}

export interface BoardStore {
  db: unknown
  subscribe(fn: (evt: Record<string, unknown>) => void): () => void
  addTicket(input: Record<string, unknown>): Ticket
  getTicket(id: number | string): Ticket
  listTickets(filter?: { project?: string; status?: string }): Ticket[]
  updateStatus(id: number | string, status: string, opts?: { note?: string; author?: string }): Ticket
  updateTicket(id: number | string, patch: Record<string, unknown>): Ticket
  claim(id: number | string, assignee: string): Ticket
  nextReady(filter?: { project?: string }): Ticket | null
  claimNext(filter?: { project?: string; assignee?: string }): Ticket | null
  addDependency(id: number | string, dependsOn: number | string): Ticket
  comment(id: number | string, author: string, text: string): Ticket
  summary(filter?: { project?: string }): Record<string, number>
  setSpec(input: { project?: string; title?: string; content?: string }): Spec
  getSpec(project?: string): Spec | null
  projects(): string[]
}

export function createStore(dbPath: string): BoardStore
