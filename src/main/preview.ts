import { app, BrowserWindow, webContents, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { IPC, type PreviewControl } from '../shared/ipc-types'
import { log } from './logger'
import { isBlockedHostForPreview } from './web-util'
import { type ConsoleLine, type ConsoleLevel, type Viewport, parseConsoleMessage, filterByLevel, normalizeViewport } from './preview-util'

export type { ConsoleLine, ConsoleLevel } from './preview-util'

export interface ScreenshotResult {
  path: string
  width: number
  height: number
  /** The viewport the page was rendered at, or null when this is just the panel's own size. */
  emulated: Viewport | null
}

export interface PreviewInfo {
  available: boolean
  url: string
  title: string
}

/** Thrown when a tool needs the live preview but no <webview> is mounted/registered. */
export class PreviewUnavailable extends Error {
  constructor() {
    super('PREVIEW_UNAVAILABLE')
    this.name = 'PreviewUnavailable'
  }
}

import { fileStamp } from './time-util'

const MAX_CONSOLE = 300
const RELAYOUT_SETTLE_MS = 250 // let an emulated resize finish reflowing before capturing
const SNAPSHOT_MAX_TEXT = 8000
const EVAL_MAX_TEXT = 10_000 // cap preview_eval results, symmetric with web_fetch (15k) / snapshot (8k)

/**
 * Lets main-process agent tools drive the renderer's Preview <webview>.
 *
 * The <webview> lives in the renderer, but its *guest* page runs in its own WebContents, which
 * main can reach by id via `webContents.fromId`. The renderer reports that id on every dom-ready
 * (see PreviewPanel); this service then loads/reloads/evaluates/screenshots the guest directly and
 * buffers its console output, so the agent can verify web changes without a human in the loop.
 */
export class PreviewService {
  private guestId: number | null = null
  private registeredOrigin: string | null = null
  private url = ''
  private title = ''
  private console: ConsoleLine[] = []
  private lastLoadError: string | null = null
  private nonce = 0
  private registerWaiters = new Set<(ok: boolean) => void>()
  /** Listeners currently attached to the guest, so we can detach when it's replaced. */
  private detach: (() => void) | null = null

  // ---- renderer-driven lifecycle ----

  /** Called from IPC when the renderer's <webview> reaches dom-ready. */
  onRegister(p: { webContentsId: number; url: string; title: string }): void {
    const origin = previewOrigin(p.url)
    const alreadyRegistered = p.webContentsId === this.guestId && origin === this.registeredOrigin
    this.url = p.url
    this.title = p.title
    if (!alreadyRegistered) {
      if (p.webContentsId !== this.guestId) this.attach(p.webContentsId)
      this.guestId = p.webContentsId
      this.registeredOrigin = origin
      log('INFO', `preview: registered guest ${p.webContentsId} @ ${p.url}`)
    }
    const waiters = [...this.registerWaiters]
    this.registerWaiters.clear()
    for (const w of waiters) w(true)
  }

  /** Called from IPC when the <webview> is unmounted (panel closed). */
  onClosed(webContentsId: number): void {
    // Ignore a stale close for a guest we've already replaced with a newer one.
    if (this.guestId !== null && webContentsId !== this.guestId) return
    this.detach?.()
    this.detach = null
    this.guestId = null
    this.registeredOrigin = null
  }

  // ---- agent-facing operations ----

  hasGuest(): boolean {
    const g = this.peekGuest()
    return g !== null
  }

  info(): PreviewInfo {
    const g = this.peekGuest()
    if (!g) return { available: false, url: this.url, title: this.title }
    return { available: true, url: safeCall(() => g.getURL(), this.url), title: safeCall(() => g.getTitle(), this.title) }
  }

  /** Ask the renderer to open the Preview panel + navigate, then wait for the guest to register. */
  async open(url: string, timeoutMs = 20_000): Promise<{ info: PreviewInfo; registered: boolean; loadError: string | null }> {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('no application window is open')
    this.lastLoadError = null
    const registered = this.waitForRegister(timeoutMs)
    this.send(win.webContents, { action: 'open', url, nonce: ++this.nonce })
    log('INFO', `preview: open ${url} (nonce ${this.nonce})`)
    const ok = await registered
    // Give a freshly-registered guest a beat to settle its load before we report.
    if (ok) await this.waitForIdle(2_500)
    log('INFO', `preview: open ${url} → registered=${ok} guest=${this.guestId ?? 'none'}`)
    return { info: this.info(), registered: ok, loadError: this.lastLoadError }
  }

  async reload(timeoutMs = 20_000): Promise<{ info: PreviewInfo; loadError: string | null }> {
    const g = this.requireGuest()
    this.lastLoadError = null
    // Bypass the HTTP cache: the agent reloads right after a rebuild, and a plain reload() can serve
    // stale assets from the guest's cache (esp. for static servers that don't send no-cache headers).
    g.reloadIgnoringCache()
    await this.waitForStopLoading(g, timeoutMs)
    return { info: this.info(), loadError: this.lastLoadError }
  }

  /** Run a snippet as an async function body in the page; the snippet should `return` its value. */
  async evaluate(code: string, timeoutMs = 10_000): Promise<string> {
    const g = this.requireGuest()
    const wrapped =
      `(async () => { try {` +
      `  const __v = await (async () => {\n${code}\n})();` +
      `  try { return typeof __v === 'undefined' ? 'undefined' : JSON.stringify(__v); }` +
      `  catch { return String(__v); }` +
      `} catch (e) { return 'ERROR: ' + (e && e.message ? e.message : String(e)); } })()`
    const res = await withTimeout(g.executeJavaScript(wrapped, true), timeoutMs)
    const out = typeof res === 'string' ? res : JSON.stringify(res)
    return out.length > EVAL_MAX_TEXT ? `${out.slice(0, EVAL_MAX_TEXT)}\n… [truncated at ${EVAL_MAX_TEXT} characters]` : out
  }

  async snapshot(timeoutMs = 10_000): Promise<string> {
    const g = this.requireGuest()
    const res = await withTimeout(g.executeJavaScript(SNAPSHOT_SCRIPT, true), timeoutMs)
    return typeof res === 'string' ? res : JSON.stringify(res)
  }

  consoleLines(opts?: { clear?: boolean; level?: ConsoleLevel }): ConsoleLine[] {
    const out = filterByLevel(this.console, opts?.level).slice()
    if (opts?.clear) this.console = []
    return out
  }

  /**
   * Capture the previewed page. With no `opts`, this captures the Preview panel exactly as laid out —
   * whatever shape the user happens to have dragged it to. Pass width/height to render at a specific
   * viewport instead, so `100vh` and media queries evaluate against the size the agent is reasoning
   * about rather than the panel's incidental one.
   */
  async screenshot(opts: { width?: number; height?: number } = {}, timeoutMs = 15_000): Promise<ScreenshotResult> {
    const g = this.requireGuest()
    const want = normalizeViewport(opts)
    if (!want) return this.capturePanel(g, timeoutMs)
    try {
      return await this.captureAtViewport(g, want, timeoutMs)
    } catch (e) {
      // Emulation is best-effort (the debugger can be occupied by open devtools). A panel-sized shot
      // with `emulated: null` is still useful, and the tool tells the model which one it got.
      log('ERROR', `preview: ${want.width}×${want.height} capture failed (${String(e)}) — falling back to the panel size`)
      return this.capturePanel(g, timeoutMs)
    }
  }

  private async capturePanel(g: WebContents, timeoutMs: number): Promise<ScreenshotResult> {
    const img = await withTimeout(g.capturePage(), timeoutMs)
    const { width, height } = img.getSize()
    return { path: this.writeShot(img.toPNG()), width, height, emulated: null }
  }

  /**
   * Render at an exact viewport via CDP device-metrics emulation. `capturePage()` cannot do this —
   * it only ever returns the panel as it currently sits, which is why a landscape layout reviewed in
   * a tall narrow panel reads as broken and sends the agent chasing phantom overflow.
   */
  private async captureAtViewport(g: WebContents, view: Viewport, timeoutMs: number): Promise<ScreenshotResult> {
    const dbg = g.debugger
    // Devtools (or a previous caller) may already own the debugger; borrow it and leave it attached.
    const preAttached = dbg.isAttached()
    if (!preAttached) dbg.attach('1.3')
    try {
      await withTimeout(
        dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: view.width,
          height: view.height,
          deviceScaleFactor: 1,
          mobile: false
        }),
        timeoutMs
      )
      // Media queries and vh units re-evaluate synchronously, but transitions and webfont reflow land
      // a frame or two later — capturing immediately catches the layout mid-move.
      await delay(RELAYOUT_SETTLE_MS)
      const shot = (await withTimeout(dbg.sendCommand('Page.captureScreenshot', { format: 'png' }), timeoutMs)) as {
        data: string
      }
      return { path: this.writeShot(Buffer.from(shot.data, 'base64')), width: view.width, height: view.height, emulated: view }
    } finally {
      // ALWAYS restore, on the error path too: a leaked override leaves the user's Preview panel stuck
      // at the emulated size long after the tool call returned.
      try {
        await dbg.sendCommand('Emulation.clearDeviceMetricsOverride')
      } catch {
        /* guest already gone */
      }
      if (!preAttached) {
        try {
          dbg.detach()
        } catch {
          /* already detached */
        }
      }
    }
  }

  private writeShot(png: Buffer): string {
    const dir = path.join(app.getPath('temp'), 'nordcode-preview')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `preview-${fileStamp()}-${randomUUID().slice(0, 6)}.png`)
    fs.writeFileSync(file, png)
    return file
  }

  // ---- internals ----

  private requireGuest(): WebContents {
    const g = this.peekGuest()
    if (!g) throw new PreviewUnavailable()
    return g
  }

  private peekGuest(): WebContents | null {
    if (this.guestId === null) return null
    const g = webContents.fromId(this.guestId)
    if (!g || g.isDestroyed()) {
      this.guestId = null
      this.registeredOrigin = null
      return null
    }
    return g
  }

  private send(host: WebContents, c: PreviewControl): void {
    if (!host.isDestroyed()) host.send(IPC.previewControl, c)
  }

  private waitForRegister(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let done = false
      const finish = (ok: boolean): void => {
        if (done) return
        done = true
        this.registerWaiters.delete(finish)
        resolve(ok)
      }
      this.registerWaiters.add(finish)
      setTimeout(() => finish(false), timeoutMs)
    })
  }

  /** Resolve once the guest stops loading, or after `timeoutMs` (best-effort settle). */
  private async waitForIdle(timeoutMs: number): Promise<void> {
    const g = this.peekGuest()
    if (!g || !g.isLoading()) return
    await this.waitForStopLoading(g, timeoutMs)
  }

  /**
   * Resolve on the guest's next did-stop-loading or after timeoutMs — and ALWAYS detach the listener
   * (the old inline versions leaked the handler on every timeout, accumulating on a long-lived guest).
   */
  private waitForStopLoading(g: WebContents, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        try {
          g.off('did-stop-loading', on)
        } catch {
          /* guest already gone */
        }
        resolve()
      }
      const on = (): void => finish()
      const timer = setTimeout(finish, timeoutMs)
      g.on('did-stop-loading', on)
    })
  }

  private attach(id: number): void {
    this.detach?.()
    this.detach = null
    const g = webContents.fromId(id)
    if (!g) return
    const onConsole = (...a: unknown[]): void => this.pushConsole(a)
    const onFail = (...a: unknown[]): void => {
      // (event, errorCode, errorDescription, validatedURL, isMainFrame)
      const code = a[1]
      const desc = a[2]
      const main = a[4]
      if (main === false) return // ignore subframe/asset failures
      this.lastLoadError = `did-fail-load (${String(code)}): ${String(desc)}`
      this.pushConsole([{ level: 'error', message: `Page failed to load: ${String(desc)} (${String(code)})` }])
    }
    // Defense-in-depth: a previewed (loopback) page must not be able to redirect the guest into the
    // LAN/link-local where preview_eval/snapshot could then read it. Block such top-level navigations.
    const onNavigate = (e: { preventDefault: () => void }, url: string): void => {
      try {
        const host = new URL(url).hostname
        if (isBlockedHostForPreview(host)) {
          e.preventDefault()
          this.lastLoadError = `blocked navigation to a private host (${host})`
          this.pushConsole([{ level: 'error', message: `Blocked navigation to a private host: ${host}` }])
        }
      } catch {
        /* unparseable URL — let Electron handle it */
      }
    }
    g.on('console-message', onConsole as never)
    g.on('did-fail-load', onFail as never)
    g.on('will-navigate', onNavigate as never)
    g.on('will-redirect', onNavigate as never)
    this.detach = (): void => {
      try {
        g.off('console-message', onConsole as never)
        g.off('did-fail-load', onFail as never)
        g.off('will-navigate', onNavigate as never)
        g.off('will-redirect', onNavigate as never)
      } catch {
        /* guest already gone */
      }
    }
    log('INFO', `preview: attached to guest webContents ${id}`)
  }

  private pushConsole(a: unknown[]): void {
    const { level, message } = parseConsoleMessage(a)
    this.console.push({ ts: Date.now(), level, message })
    if (this.console.length > MAX_CONSOLE) this.console.splice(0, this.console.length - MAX_CONSOLE)
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function previewOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/** Runs in the guest page; returns a compact JSON view of the DOM for a text-only model. */
const SNAPSHOT_SCRIPT = `(() => {
  const clip = (s, n) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  const list = (sel, n, f) => Array.from(document.querySelectorAll(sel)).slice(0, n).map(f).filter(Boolean);
  const text = ((document.body && document.body.innerText) || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, ${SNAPSHOT_MAX_TEXT});
  const out = {
    url: location.href,
    title: document.title,
    headings: list('h1,h2,h3,h4', 40, (e) => clip(e.innerText, 120)),
    links: list('a[href]', 40, (a) => { const t = clip(a.innerText, 80); return t ? t + ' -> ' + a.getAttribute('href') : ''; }),
    buttons: list('button,[role=button]', 40, (e) => clip(e.innerText || e.getAttribute('aria-label'), 80)),
    inputs: list('input,textarea,select', 40, (i) => clip((i.name || i.id || i.getAttribute('placeholder') || i.type || i.tagName), 60)),
    text
  };
  return JSON.stringify(out);
})()`

export const previewService = new PreviewService()
