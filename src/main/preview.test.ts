import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  log: vi.fn(),
  fromId: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  onErrorOccurred: vi.fn(),
  onCompleted: vi.fn(),
  send: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  BrowserWindow: { getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: mocks.send } }] },
  webContents: { fromId: mocks.fromId }
}))
vi.mock('./logger', () => ({ log: mocks.log }))

import { PreviewService } from './preview'

describe('preview guest registration', () => {
  beforeEach(() => {
    mocks.log.mockReset()
    mocks.fromId.mockReset().mockReturnValue({
      id: 2,
      on: mocks.on,
      off: mocks.off,
      isDestroyed: () => false,
      isLoading: () => false,
      getURL: () => 'http://127.0.0.1:8471/',
      getTitle: () => 'Preview',
      session: { webRequest: { onErrorOccurred: mocks.onErrorOccurred, onCompleted: mocks.onCompleted } }
    })
    mocks.on.mockReset()
    mocks.off.mockReset()
    mocks.onErrorOccurred.mockReset()
    mocks.onCompleted.mockReset()
    mocks.send.mockReset()
  })

  it('registers and logs the same guest and origin only once', () => {
    const service = new PreviewService()

    service.onRegister({ webContentsId: 2, url: 'http://127.0.0.1:8471/', title: 'Preview' })
    service.onRegister({ webContentsId: 2, url: 'http://127.0.0.1:8471/page', title: 'Preview page' })

    expect(mocks.fromId).toHaveBeenCalledTimes(1)
    expect(mocks.on).toHaveBeenCalledTimes(4)
    expect(mocks.onErrorOccurred).toHaveBeenCalledTimes(1)
    expect(mocks.onCompleted).toHaveBeenCalledTimes(1)
    expect(mocks.log.mock.calls.filter(([, message]) => String(message).startsWith('preview: registered guest'))).toEqual([
      ['INFO', 'preview: registered guest 2 @ http://127.0.0.1:8471/']
    ])
  })

  it('captures failed network requests as pending agent diagnostics', () => {
    const service = new PreviewService()
    service.onRegister({ webContentsId: 2, url: 'http://127.0.0.1:8471/', title: 'Preview' })

    const onComplete = mocks.onCompleted.mock.calls[0][0]
    onComplete({
      webContentsId: 2,
      method: 'GET',
      resourceType: 'xhr',
      url: 'http://127.0.0.1:8471/api/items?token=secret',
      statusCode: 500
    })

    expect(service.diagnostics()).toMatchObject([
      { level: 'error', message: '[network] GET xhr http://127.0.0.1:8471/api/items?… returned HTTP 500' }
    ])
    expect(service.diagnostics()).toEqual([])
    expect(service.consoleLines({ level: 'error' })).toHaveLength(1)
  })

  it('attaches early without releasing open waiters before the guest is ready', async () => {
    vi.useFakeTimers()
    try {
      const service = new PreviewService()
      const opening = service.open('http://127.0.0.1:8471/', 100)
      service.onRegister({ webContentsId: 2, url: 'about:blank', title: '', ready: false })
      await vi.advanceTimersByTimeAsync(1)
      let settled = false
      void opening.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      service.onRegister({ webContentsId: 2, url: 'http://127.0.0.1:8471/', title: 'Preview', ready: true })
      await expect(opening).resolves.toMatchObject({ registered: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves explicit console history across navigation while clearing pending auto-diagnostics', async () => {
    const service = new PreviewService()
    service.onRegister({ webContentsId: 2, url: 'http://127.0.0.1:8471/', title: 'Preview' })
    const onConsole = mocks.on.mock.calls.find(([event]) => event === 'console-message')?.[1]
    onConsole({ level: 'error', message: 'one-shot startup race' })
    expect(service.diagnostics({ clear: false })).toHaveLength(1)

    const opening = service.open('http://127.0.0.1:8471/', 100)
    service.onRegister({ webContentsId: 2, url: 'http://127.0.0.1:8471/', title: 'Preview', ready: true })
    await opening

    expect(service.diagnostics()).toEqual([])
    expect(service.consoleLines({ level: 'error' })).toMatchObject([{ message: 'one-shot startup race' }])
  })
})
