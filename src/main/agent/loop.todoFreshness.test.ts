import { describe, expect, it } from 'vitest'
import type { TodoItem } from '../../shared/domain-types'
import {
  TODO_STALE_NUDGE_COOLDOWN_TURNS,
  TODO_STALE_MUTATION_THRESHOLD,
  TodoFreshnessTracker
} from './loop'

const todos: TodoItem[] = [
  { content: 'Sound effects module (audio.js)', status: 'in_progress' },
  { content: 'Wire the settings panel', status: 'pending' }
]

const edit = (tracker: TodoFreshnessTracker, index: number, list: readonly TodoItem[] = todos): string | null =>
  tracker.note('edit_file', true, JSON.stringify({ path: `src/audio${index === 0 ? '' : index}.js` }), list)

describe('TodoFreshnessTracker', () => {
  it('nudges once after four successful mutations and names the inferred todo item', () => {
    const tracker = new TodoFreshnessTracker()
    tracker.advanceTurn()

    for (let index = 0; index < TODO_STALE_MUTATION_THRESHOLD - 1; index++) expect(edit(tracker, index)).toBeNull()
    expect(edit(tracker, 0)).toBe(
      "You have finished work related to 'Sound effects module (audio.js)' — call todo_write NOW marking it completed and setting the next item in_progress. Pass the FULL list."
    )
    expect(edit(tracker, 5)).toBeNull()
  })

  it('a successful todo_write resets the mutation count', () => {
    const tracker = new TodoFreshnessTracker()
    tracker.advanceTurn()
    for (let index = 0; index < TODO_STALE_MUTATION_THRESHOLD - 1; index++) edit(tracker, index)

    expect(tracker.note('todo_write', true, '{}', todos)).toBeNull()
    for (let index = 0; index < TODO_STALE_MUTATION_THRESHOLD - 1; index++) expect(edit(tracker, index)).toBeNull()
    expect(edit(tracker, 0)).toContain("finished work related to 'Sound effects module (audio.js)'")
  })

  it('does not re-nudge inside the eight-turn cooldown', () => {
    const tracker = new TodoFreshnessTracker()
    tracker.advanceTurn()
    for (let index = 0; index < TODO_STALE_MUTATION_THRESHOLD; index++) edit(tracker, index)
    tracker.note('todo_write', true, '{}', todos)

    for (let turn = 1; turn < TODO_STALE_NUDGE_COOLDOWN_TURNS; turn++) tracker.advanceTurn()
    for (let index = 0; index < TODO_STALE_MUTATION_THRESHOLD; index++) expect(edit(tracker, index)).toBeNull()

    tracker.advanceTurn()
    expect(edit(tracker, 0)).toContain('call todo_write NOW')
  })

  it('uses the generic fallback without a file-to-item token match and stays silent when todos are absent', () => {
    const tracker = new TodoFreshnessTracker()
    tracker.advanceTurn()
    let nudge: string | null = null
    for (let index = 0; index < TODO_STALE_MUTATION_THRESHOLD; index++) {
      nudge = tracker.note('write_file', true, JSON.stringify({ path: `src/unrelated-${index}.ts` }), todos)
    }
    expect(nudge).toContain('implementation changes')
    expect(nudge).not.toContain('Sound effects module')

    const boardWorker = new TodoFreshnessTracker()
    boardWorker.advanceTurn()
    for (let index = 0; index < TODO_STALE_MUTATION_THRESHOLD + 2; index++) {
      expect(boardWorker.note('write_file', true, JSON.stringify({ path: `src/file-${index}.ts` }), [])).toBeNull()
    }
  })
})
