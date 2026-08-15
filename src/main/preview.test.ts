import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  log: vi.fn(),
  fromId: vi.fn(),
  on: vi.fn(),
  off: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { fromId: mocks.fromId }
}))
vi.mock('./logger', () => ({ log: mocks.log }))

import { PreviewService } from './preview'

describe('preview guest registration', () => {
  beforeEach(() => {
    mocks.log.mockReset()
    mocks.fromId.mockReset().mockReturnValue({ on: mocks.on, off: mocks.off, isDestroyed: () => false })
    mocks.on.mockReset()
    mocks.off.mockReset()
  })

  it('registers and logs the same guest and origin only once', () => {
    const service = new PreviewService()

    service.onRegister({ webContentsId: 2, url: 'http://127.0.0.1:8471/', title: 'Preview' })
    service.onRegister({ webContentsId: 2, url: 'http://127.0.0.1:8471/page', title: 'Preview page' })

    expect(mocks.fromId).toHaveBeenCalledTimes(1)
    expect(mocks.on).toHaveBeenCalledTimes(4)
    expect(mocks.log.mock.calls.filter(([, message]) => String(message).startsWith('preview: registered guest'))).toEqual([
      ['INFO', 'preview: registered guest 2 @ http://127.0.0.1:8471/']
    ])
  })
})
