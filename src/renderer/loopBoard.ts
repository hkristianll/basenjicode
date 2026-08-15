// Pure board-grouping for the native Loop board — no electron / IPC / React, so it unit-tests headless.
import type { BoardTicketRow } from '../shared/ipc-types'

export type LaneKey = 'review' | 'in_progress' | 'ready' | 'blocked' | 'done'

export interface BoardLane {
  key: LaneKey
  label: string
  tickets: BoardTicketRow[]
}

const LANE_ORDER: { key: LaneKey; label: string }[] = [
  { key: 'review', label: 'Ready for review' },
  { key: 'in_progress', label: 'Working' },
  { key: 'ready', label: 'Ready' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'done', label: 'Done' }
]

function laneOf(t: BoardTicketRow): LaneKey {
  switch (t.status) {
    case 'review':
      return 'review'
    case 'in_progress':
      return 'in_progress'
    case 'done':
    case 'cancelled':
      return 'done'
    default:
      // todo → ready unless the board says it's blocked by unmet deps
      return t.blocked ? 'blocked' : 'ready'
  }
}

/** Bucket board tickets into the fixed ordered lane set (empty lanes preserved). */
export function groupLanes(tickets: BoardTicketRow[]): BoardLane[] {
  const buckets: Record<LaneKey, BoardTicketRow[]> = { review: [], in_progress: [], ready: [], blocked: [], done: [] }
  for (const t of tickets) buckets[laneOf(t)].push(t)
  return LANE_ORDER.map((l) => ({ ...l, tickets: buckets[l.key] }))
}

export type CardStateKind = 'review' | 'working' | 'claimed' | 'ready' | 'blocked' | 'done' | 'cancelled'

export interface CardState {
  kind: CardStateKind
  label: string
}

/** Per-card run state. The live active ticket (currently draining) reads as "working"; everything else
 *  derives from board status. Pure so the badge logic is unit-tested without the live loop. */
export function cardState(t: BoardTicketRow, activeId?: number): CardState {
  if (activeId != null && t.id === activeId && t.status === 'in_progress') return { kind: 'working', label: 'working' }
  switch (t.status) {
    case 'review':
      return { kind: 'review', label: 'review' }
    case 'in_progress':
      return { kind: 'claimed', label: 'claimed' }
    case 'done':
      return { kind: 'done', label: 'done' }
    case 'cancelled':
      return { kind: 'cancelled', label: 'cancelled' }
    default:
      return t.blocked ? { kind: 'blocked', label: 'blocked' } : { kind: 'ready', label: 'ready' }
  }
}
