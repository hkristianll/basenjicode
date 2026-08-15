import { describe, expect, it } from 'vitest'
import { looksBinary, planRewind } from './rewind'
import type { ChatMessage } from '../shared/domain-types'
import type { FileEdit } from './store/snapshots'

const user = (text: string, turnId?: string): ChatMessage => ({ role: 'user', content: text, ...(turnId ? { turnId } : {}) })
const assistant = (text: string): ChatMessage => ({ role: 'assistant', content: text })

const snapIndex = (index: Record<string, FileEdit[]>) => (turnId: string) => index[turnId] ?? null

describe('planRewind', () => {
  const messages: ChatMessage[] = [
    user('build the thing', 't1'),
    assistant('done'),
    user('now tweak it', 't2'),
    assistant('tweaked'),
    user('continue', 't3'), // a stamped turn with no snapshot (read-only turn)
    assistant('ok')
  ]

  it('picks the OLDEST before when several rewound turns touched the same file', () => {
    const plan = planRewind(
      messages,
      't1',
      snapIndex({
        t1: [{ path: 'src/a.ts', before: 'original' }],
        t2: [{ path: 'src/a.ts', before: 'after-turn-1' }]
      })
    )
    expect(plan?.restores).toEqual([{ path: 'src/a.ts', content: 'original' }])
    expect(plan?.turnIds).toEqual(['t1', 't2', 't3'])
    expect(plan?.keepCount).toBe(0)
  })

  it('rewinding a LATER turn leaves earlier turns alone and keeps the prefix', () => {
    const plan = planRewind(
      messages,
      't2',
      snapIndex({
        t1: [{ path: 'src/a.ts', before: 'original' }],
        t2: [{ path: 'src/a.ts', before: 'after-turn-1' }]
      })
    )
    expect(plan?.keepCount).toBe(2) // keeps turn 1's user+assistant
    expect(plan?.turnIds).toEqual(['t2', 't3'])
    expect(plan?.restores).toEqual([{ path: 'src/a.ts', content: 'after-turn-1' }])
    expect(plan?.composerText).toBe('now tweak it')
  })

  it('merges disjoint files across turns and deletes files a rewound turn created', () => {
    const plan = planRewind(
      messages,
      't1',
      snapIndex({
        t1: [{ path: 'src/a.ts', before: 'a-orig' }],
        t2: [
          { path: 'src/b.ts', before: 'b-orig' },
          { path: 'src/new.ts', before: null } // created in turn 2 → rewind deletes it
        ]
      })
    )
    expect(plan?.restores).toEqual([
      { path: 'src/a.ts', content: 'a-orig' },
      { path: 'src/b.ts', content: 'b-orig' },
      { path: 'src/new.ts', content: null }
    ])
    expect(plan?.binarySkipped).toEqual([])
  })

  it('fails closed on binary-looking snapshots and reports them', () => {
    const plan = planRewind(
      messages,
      't1',
      snapIndex({
        t1: [{ path: 'assets/logo.png', before: 'PNG\u0000�garbage' }],
        t2: [{ path: 'assets/logo.png', before: 'also\u0000binary' }]
      })
    )
    expect(plan?.restores).toEqual([])
    expect(plan?.binarySkipped).toEqual(['assets/logo.png'])
  })

  it('prefers displayContent for the composer restore', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'expanded @file contents …', displayContent: 'fix @main.ts', turnId: 't1' }]
    expect(planRewind(msgs, 't1', () => null)?.composerText).toBe('fix @main.ts')
  })

  it('ignores unstamped user messages (steer injections) when collecting turns', () => {
    const msgs: ChatMessage[] = [user('start', 't1'), { role: 'user', content: 'mid-turn steer' }, user('next', 't2')]
    expect(planRewind(msgs, 't1', () => null)?.turnIds).toEqual(['t1', 't2'])
  })

  it('returns null for an unknown or unstamped target', () => {
    expect(planRewind(messages, 'nope', () => null)).toBeNull()
    expect(planRewind([user('old session, no stamp')], 'any', () => null)).toBeNull()
  })
})

describe('looksBinary', () => {
  it('flags NUL and replacement chars, passes ordinary code', () => {
    expect(looksBinary('PNG\u0000data')).toBe(true)
    expect(looksBinary('bad�decode')).toBe(true)
    expect(looksBinary('const a = 1 // 日本語 comment, emoji 🎉')).toBe(false)
  })
})
