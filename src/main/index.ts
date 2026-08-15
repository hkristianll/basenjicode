import { app, BrowserWindow, Menu, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { resolveUserDataDir } from './userData'
import { registerIpc } from './ipc'
import { bgTasks } from './bgtasks'
import { killAllForeground } from './shell/powershell'
import { log } from './logger'
import { parseConsoleMessage } from './preview-util'

// Opt-in Chrome DevTools Protocol endpoint for visual review (scripts/peek.mjs attaches and
// screenshots the live renderer). OFF unless NORDCODE_REMOTE_DEBUG is set — used for `npm run dev`.
// The installed build doesn't need this: Electron honours `--remote-debugging-port` straight off the
// command line (see scripts/launch-debug.ps1). Chromium binds the port to 127.0.0.1 (loopback) only;
// must be appended before app is ready, so it runs here at module load.
if (process.env['NORDCODE_REMOTE_DEBUG']) {
  const v = process.env['NORDCODE_REMOTE_DEBUG']
  app.commandLine.appendSwitch('remote-debugging-port', v === '1' ? '9222' : v)
}

// NordCode → BasenjiCode rename: pin userData to the legacy directory so existing sessions,
// settings, snapshots, and the board database survive the rename (see userData.ts). MUST run at
// module load, before anything touches userData.
{
  const legacyUserData = resolveUserDataDir(app.getPath('userData'), (p) => fs.existsSync(p))
  if (legacyUserData) app.setPath('userData', legacyUserData)
}

/** Only http(s)/mailto links may be handed to shell.openExternal — every other scheme (file:, smb:,
 *  ms-msdt:, custom protocol handlers) is an OS-level launch surface and is refused. */
function isSafeExternalUrl(url: string): boolean {
  try {
    const p = new URL(url).protocol
    return p === 'http:' || p === 'https:' || p === 'mailto:'
  } catch {
    return false
  }
}

/** Build a context-menu template for the right-clicked target (editable field or selected text). */
function editContextMenu(params: Electron.ContextMenuParams): Electron.MenuItemConstructorOptions[] {
  const { isEditable, editFlags, selectionText } = params
  if (isEditable) {
    return [
      { role: 'undo', enabled: editFlags.canUndo },
      { role: 'redo', enabled: editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: editFlags.canCut },
      { role: 'copy', enabled: editFlags.canCopy },
      { role: 'paste', enabled: editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll' }
    ]
  }
  if (selectionText.trim().length > 0) {
    return [
      { role: 'copy', enabled: editFlags.canCopy },
      { type: 'separator' },
      { role: 'selectAll' }
    ]
  }
  return []
}

function createWindow(): BrowserWindow {
  // Window chrome: frameless with the custom in-app title bar on Windows (overlay controls) and macOS
  // (inset traffic lights). On Linux the Window Controls Overlay isn't reliable across desktop
  // environments, so use a native frame to guarantee working minimize/maximize/close.
  const chrome: Electron.BrowserWindowConstructorOptions =
    process.platform === 'linux'
      ? { frame: true }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#1b1b1d', symbolColor: '#9b9ba3', height: 44 } }
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 540,
    show: false,
    title: 'BasenjiCode',
    // Dev/taskbar icon. Packaged builds get their icon from electron-builder (resources/icon.ico).
    ...(app.isPackaged ? {} : { icon: path.join(__dirname, '../../resources/icon.png') }),
    backgroundColor: '#1b1b1d',
    ...chrome,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Enables the <webview> used by the Preview panel to embed a local dev server.
      webviewTag: true,
      // Let voice-mode TTS audio start playing without a per-clip user gesture.
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  win.once('ready-to-show', () => win.show())

  // Voice mode needs the microphone (getUserMedia). Grant only 'media'; deny every other
  // permission (camera-only requests, geolocation, notifications, …) so enabling the mic
  // doesn't widen the renderer's reach. This is stricter than Electron's no-handler default.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'))

  // External links open in the OS browser, never in-app — but only safe web/mail schemes. The renderer
  // displays model-generated/untrusted content, so a crafted window.open with a dangerous scheme
  // (file:, smb:, ms-msdt:, a custom protocol handler) would otherwise be launched at the OS level on
  // click. Allowlist http/https/mailto and drop everything else.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    else log('INFO', `blocked openExternal for disallowed scheme: ${url.slice(0, 120)}`)
    return { action: 'deny' }
  })

  // Native right-click menu: cut/copy/paste in inputs, copy on selected text.
  win.webContents.on('context-menu', (_e, params) => {
    const items = editContextMenu(params)
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    log('ERROR', 'render-process-gone', details.reason)
  })

  // Surface renderer-side errors (React render throws / ErrorBoundary) in main.log — otherwise they
  // only reach the in-page console and a UI crash is invisible to anyone reading the logs.
  win.webContents.on('console-message', ((...a: unknown[]) => {
    const { level, message } = parseConsoleMessage(a)
    if (level === 'error') log('ERROR', `renderer: ${message}`)
  }) as never)

  // Keep the renderer pinned to our own content; block navigation to arbitrary URLs.
  win.webContents.on('will-navigate', (e, url) => {
    const ok = url.startsWith('file://') || (process.env['ELECTRON_RENDERER_URL'] && url.startsWith(process.env['ELECTRON_RENDERER_URL']))
    if (!ok) e.preventDefault()
  })
  // Allow the Preview panel's <webview>, but strip privileges and only permit http(s) guests.
  win.webContents.on('will-attach-webview', (e, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    if (!/^https?:\/\//i.test(params.src ?? '')) e.preventDefault()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return win
}

// Single instance only. Without this, launching the shortcut again spawns a second app that loads and
// re-saves settings.json concurrently — the instances clobber each other's settings. A second launch
// instead focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  void app.whenReady().then(() => {
    registerIpc()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

// If the stdout/stderr pipe's reader closes, writing to it throws EPIPE. Swallow it at the stream level
// (the canonical Node fix) so it never surfaces as an uncaught exception.
for (const s of [process.stdout, process.stderr]) {
  s.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EPIPE') throw e
  })
}
process.on('uncaughtException', (err) => {
  // Never re-log a broken-pipe write — doing so writes to the same dead pipe and self-feeds a ~2000/sec
  // EPIPE storm that fills the disk (observed: an 800MB main.log of identical EPIPE lines).
  if ((err as NodeJS.ErrnoException)?.code === 'EPIPE') return
  log('ERROR', 'uncaughtException', err)
})
process.on('unhandledRejection', (reason) => {
  if ((reason as NodeJS.ErrnoException)?.code === 'EPIPE') return
  log('ERROR', 'unhandledRejection', reason)
})

let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  quitting = true
  e.preventDefault()
  bgTasks.killAll()
  killAllForeground()
  app.exit(0)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
