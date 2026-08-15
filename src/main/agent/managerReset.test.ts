import { describe, it, expect } from 'vitest'
import { estimateHistoryTokens, managerResetSeed } from './managerReset'
import type { ChatMessage } from '../../shared/domain-types'

describe('estimateHistoryTokens', () => {
  it('estimates ~chars/4 across message contents', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'a'.repeat(400) },
      { role: 'assistant', content: 'b'.repeat(400) }
    ]
    expect(estimateHistoryTokens(history)).toBe(200) // 800 chars / 4
  })
  it('tolerates messages with no content', () => {
    expect(estimateHistoryTokens([{ role: 'assistant', content: undefined } as unknown as ChatMessage])).toBe(0)
    expect(estimateHistoryTokens([])).toBe(0)
  })
})

describe('managerResetSeed', () => {
  it('opens with the reset framing + goal, then instructs a board re-ground', () => {
    const seed = managerResetSeed('build a 3d slicer', [])
    expect(seed).toHaveLength(2)
    expect(seed[0].role).toBe('user')
    expect(seed[0].content).toMatch(/# Goal\nbuild a 3d slicer/)
    expect(seed[0].content).toMatch(/team_status/)
    expect(seed[1].role).toBe('assistant')
  })
  it('omits the goal heading when there is no goal', () => {
    const seed = managerResetSeed('   ', [])
    expect(seed[0].content).not.toMatch(/# Goal/)
    expect(seed[0].content).toMatch(/team_status/)
  })
  it('appends the recent tail after the re-seed for continuity', () => {
    const tail: ChatMessage[] = [
      { role: 'user', content: 'how is testing going?' },
      { role: 'assistant', content: 'two tickets left' }
    ]
    const seed = managerResetSeed('goal', tail)
    expect(seed).toHaveLength(4)
    expect(seed.slice(-2)).toEqual(tail)
  })
})
