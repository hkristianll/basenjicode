import { describe, it, expect } from 'vitest'
import { IPC } from './ipc-types'

describe('loop IPC channels', () => {
  it('exposes the five loop:* channel names', () => {
    expect(IPC.loopStart).toBe('loop:start')
    expect(IPC.loopPause).toBe('loop:pause')
    expect(IPC.loopStop).toBe('loop:stop')
    expect(IPC.loopStatus).toBe('loop:status')
    expect(IPC.loopEvent).toBe('loop:event')
  })
})
