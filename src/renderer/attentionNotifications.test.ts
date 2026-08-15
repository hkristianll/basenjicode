import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttentionItem } from './components/NeedsMePanel'
import { notifyWhenUnfocused, syncAttentionNotifications } from './attentionNotifications'

afterEach(() => vi.unstubAllGlobals())

function item(id: string, notify = true): AttentionItem {
  return { id, notify, tone: 'warn', title: id, detail: `${id} detail` }
}

describe('syncAttentionNotifications', () => {
  it('returns only newly-visible actionable items', () => {
    const result = syncAttentionNotifications([item('approval-1'), item('context', false), item('status-auth')], new Set(['approval-1']))

    expect(result.fresh.map((entry) => entry.id)).toEqual(['status-auth'])
    expect([...result.liveIds]).toEqual(['approval-1', 'status-auth'])
  })

  it('allows a resolved blocker to notify if it later reappears', () => {
    const resolved = syncAttentionNotifications([], new Set(['status-unreachable']))
    const returned = syncAttentionNotifications([item('status-unreachable')], resolved.liveIds)

    expect(returned.fresh.map((entry) => entry.id)).toEqual(['status-unreachable'])
  })
})

describe('notifyWhenUnfocused', () => {
  it('does not alert while the app has focus', () => {
    const shown: unknown[] = []
    vi.stubGlobal('document', { hasFocus: () => true })
    vi.stubGlobal('Notification', class {
      static permission = 'granted'
      constructor(...args: unknown[]) {
        shown.push(args)
      }
    })

    notifyWhenUnfocused('Needs Me', 'Approval waiting')
    expect(shown).toEqual([])
  })

  it('creates a native notification and runs the focus action when clicked', () => {
    const shown: Array<{ onclick: (() => void) | null; close: ReturnType<typeof vi.fn> }> = []
    const onClick = vi.fn()
    vi.stubGlobal('document', { hasFocus: () => false })
    vi.stubGlobal('Notification', class {
      static permission = 'granted'
      onclick: (() => void) | null = null
      close = vi.fn()
      constructor() {
        shown.push(this)
      }
    })

    notifyWhenUnfocused('Needs Me', 'Approval waiting', onClick)
    expect(shown).toHaveLength(1)
    shown[0].onclick?.()
    expect(onClick).toHaveBeenCalledOnce()
    expect(shown[0].close).toHaveBeenCalledOnce()
  })
})
