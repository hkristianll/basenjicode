import { afterEach, describe, expect, it, vi } from 'vitest'
import { treeKill } from './powershell'

afterEach(() => vi.restoreAllMocks())

describe('treeKill POSIX group-kill semantics (A2, testable from any OS)', () => {
  it('signals the whole process GROUP via the negative pid', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    treeKill(4321, { platform: 'linux' })
    expect(kill).toHaveBeenCalledWith(-4321, 'SIGKILL')
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('falls back to a direct child kill when the group kill fails (non-leader)', () => {
    const kill = vi
      .spyOn(process, 'kill')
      .mockImplementationOnce(() => {
        throw new Error('ESRCH')
      })
      .mockImplementation(() => true)
    treeKill(4321, { platform: 'darwin' })
    expect(kill).toHaveBeenNthCalledWith(1, -4321, 'SIGKILL')
    expect(kill).toHaveBeenNthCalledWith(2, 4321, 'SIGKILL')
  })

  it('swallows total failure (already-dead child) without throwing', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })
    expect(() => treeKill(4321, { platform: 'linux' })).not.toThrow()
  })
})
