import { describe, it, expect } from 'vitest'
import { groupLanes, cardState } from './loopBoard'
import type { BoardTicketRow } from '../shared/ipc-types'

function t(id: number, status: string, extra: Partial<BoardTicketRow> = {}): BoardTicketRow {
  return { id, project: 'p', title: `T${id}`, status, ...extra }
}

describe('groupLanes', () => {
  it('buckets tickets into the right lane by status + ready/blocked', () => {
    const lanes = groupLanes([
      t(1, 'review'),
      t(2, 'in_progress'),
      t(3, 'todo', { ready: true, blocked: false }),
      t(4, 'todo', { ready: false, blocked: true }),
      t(5, 'done'),
      t(6, 'cancelled')
    ])
    const by = Object.fromEntries(lanes.map((l) => [l.key, l.tickets.map((x) => x.id)]))
    expect(by.review).toEqual([1])
    expect(by.in_progress).toEqual([2])
    expect(by.ready).toEqual([3])
    expect(by.blocked).toEqual([4])
    expect(by.done).toEqual([5, 6]) // cancelled folds into done
  })

  it('returns all lanes in order even when empty', () => {
    const lanes = groupLanes([])
    expect(lanes.map((l) => l.key)).toEqual(['review', 'in_progress', 'ready', 'blocked', 'done'])
    expect(lanes.every((l) => l.tickets.length === 0)).toBe(true)
  })

  it('treats a todo with no flags as ready', () => {
    const lanes = groupLanes([t(7, 'todo')])
    expect(lanes.find((l) => l.key === 'ready')?.tickets.map((x) => x.id)).toEqual([7])
  })
})

describe('cardState', () => {
  it('the live active in_progress ticket reads as working', () => {
    expect(cardState(t(1, 'in_progress'), 1)).toEqual({ kind: 'working', label: 'working' })
  })
  it('a non-active in_progress ticket reads as claimed', () => {
    expect(cardState(t(1, 'in_progress'), 2).kind).toBe('claimed')
    expect(cardState(t(1, 'in_progress')).kind).toBe('claimed') // no active id
  })
  it('maps review / done / cancelled directly', () => {
    expect(cardState(t(1, 'review')).kind).toBe('review')
    expect(cardState(t(1, 'done')).kind).toBe('done')
    expect(cardState(t(1, 'cancelled')).kind).toBe('cancelled')
  })
  it('todo → ready unless blocked', () => {
    expect(cardState(t(1, 'todo')).kind).toBe('ready')
    expect(cardState(t(1, 'todo', { blocked: true })).kind).toBe('blocked')
  })
})
