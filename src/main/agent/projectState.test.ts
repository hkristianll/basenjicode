import { describe, it, expect } from 'vitest'
import { renderProjectState } from './projectState'

describe('renderProjectState', () => {
  it('renders goal, the file manifest, and open todos', () => {
    const s = renderProjectState({
      goal: 'build a settlers game',
      files: [
        { path: 'index.html', action: 'created' },
        { path: 'game/main.js', action: 'edited' }
      ],
      todos: [
        { content: 'economy chains', status: 'pending' },
        { content: 'terrain', status: 'completed' }
      ]
    })
    expect(s).toContain('Goal: build a settlers game')
    expect(s).toContain('index.html (created)')
    expect(s).toContain('game/main.js') // edited → no annotation
    expect(s).not.toContain('game/main.js (edited)')
    expect(s).toContain('[ ] economy chains')
    expect(s).not.toContain('terrain') // completed todos are omitted
    expect(s).toMatch(/persists across compaction/)
    expect(s).toMatch(/do NOT recreate|Do NOT recreate/i) // anti-"start over" guard text
  })

  it('returns empty string when there is nothing to show', () => {
    expect(renderProjectState({})).toBe('')
    expect(
      renderProjectState({ files: [], todos: [{ content: 'x', status: 'completed' }], background: [], previewUrl: '  ' })
    ).toBe('')
  })

  it('renders live background handles with optional URLs and the last preview URL', () => {
    const s = renderProjectState({
      background: [
        { id: 'bg1', command: 'npm run dev', url: 'http://localhost:5173' },
        { id: 'bg2', command: 'npm run watch' }
      ],
      previewUrl: 'http://127.0.0.1:8471'
    })

    expect(s).toContain('bg1 `npm run dev` → http://localhost:5173')
    expect(s).toContain('bg2 `npm run watch`')
    expect(s).toContain('Preview: http://127.0.0.1:8471')
  })

  it('caps a huge file list and notes how many were omitted', () => {
    const files = Array.from({ length: 70 }, (_, i) => ({ path: `f${i}.ts`, action: 'edited' as const }))
    const s = renderProjectState({ files })
    expect(s).toContain('…and 20 more')
    expect(s).toContain('f69.ts') // keeps the most recent
    expect(s).not.toContain('f0.ts') // drops the oldest beyond the cap
  })
})
