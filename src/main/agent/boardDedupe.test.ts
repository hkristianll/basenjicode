import { describe, it, expect } from 'vitest'
import { dedupeKey, planBoardDedupe } from './boardDedupe'

describe('dedupeKey', () => {
  it('folds case, punctuation, and a trailing parenthetical annotation', () => {
    expect(dedupeKey('Implement Theme Switcher')).toBe('implement theme switcher')
    expect(dedupeKey('implement   theme  switcher!')).toBe('implement theme switcher')
    expect(dedupeKey('Implement Theme Switcher (Fixed Check)')).toBe('implement theme switcher')
  })
  it('does NOT merge titles that differ by a content word (conservative)', () => {
    expect(dedupeKey('Implement visible Theme Switcher')).not.toBe(dedupeKey('Implement Theme Switcher'))
  })
})

describe('planBoardDedupe', () => {
  it('keeps the most-advanced copy and cancels the rest (incl. a trailing-annotation variant)', () => {
    const plan = planBoardDedupe([
      { id: 1, title: 'Build X', status: 'todo' },
      { id: 2, title: 'build x', status: 'done' }, // most-advanced → kept
      { id: 3, title: 'Build X (Fixed Check)', status: 'todo' },
      { id: 9, title: 'Unrelated', status: 'todo' }
    ])
    expect(plan).toHaveLength(1)
    expect(plan[0].keepId).toBe(2)
    expect([...plan[0].cancelIds].sort((a, b) => a - b)).toEqual([1, 3])
  })

  it('ignores already-cancelled tickets and singletons', () => {
    const plan = planBoardDedupe([
      { id: 1, title: 'A', status: 'todo' },
      { id: 2, title: 'A', status: 'cancelled' }, // already cancelled → not a live duplicate
      { id: 3, title: 'B', status: 'todo' }
    ])
    expect(plan).toHaveLength(0)
  })

  it('breaks ties to the lowest id when status rank is equal', () => {
    const plan = planBoardDedupe([
      { id: 5, title: 'T', status: 'todo' },
      { id: 2, title: 'T', status: 'todo' },
      { id: 8, title: 'T', status: 'todo' }
    ])
    expect(plan[0].keepId).toBe(2)
    expect([...plan[0].cancelIds].sort((a, b) => a - b)).toEqual([5, 8])
  })

  it('handles many copies of one title (the 21× pathology)', () => {
    const tickets = Array.from({ length: 21 }, (_, i) => ({ id: 100 + i, title: 'Add Production Deployment Guide', status: 'todo' }))
    const plan = planBoardDedupe(tickets)
    expect(plan).toHaveLength(1)
    expect(plan[0].cancelIds).toHaveLength(20) // 21 → keep 1, cancel 20
    expect(plan[0].keepId).toBe(100) // lowest id
  })
})
