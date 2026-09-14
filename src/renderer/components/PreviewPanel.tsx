import { useEffect, useRef, useState, type Ref } from 'react'
import { Icon } from './Icon'

const DEFAULT_URL = 'http://localhost:5173'
const QUICK_URLS = [
  { label: 'Vite', url: 'http://localhost:5173' },
  { label: 'Next', url: 'http://localhost:3000' },
  { label: 'API', url: 'http://localhost:8000' }
]

type LoadState = 'loading' | 'ready' | 'error'

/** Minimal typing for the Electron <webview> element methods we read. */
interface WebviewElement extends HTMLElement {
  getWebContentsId(): number
  getURL(): string
  getTitle(): string
  reload(): void
  reloadIgnoringCache(): void
}

/** When the agent calls preview_open, App passes a new target down to navigate the webview. */
export interface PreviewTarget {
  url: string
  nonce: number
}

function normalize(u: string): string {
  const s = u.trim()
  if (!s) return ''
  return /^https?:\/\//i.test(s) ? s : `http://${s}`
}

function hostLabel(value: string): string {
  try {
    const u = new URL(value)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return 'No URL'
  }
}

export function PreviewPanel({ target }: { target?: PreviewTarget }) {
  const initialUrl = target?.url ?? DEFAULT_URL
  const [url, setUrl] = useState(initialUrl) // URL-bar text
  const [src, setSrc] = useState(initialUrl) // <webview> src; changing it navigates the guest.
  const [title, setTitle] = useState('Local preview')
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const srcRef = useRef(initialUrl)
  const webviewRef = useRef<WebviewElement | null>(null)
  const guestIdRef = useRef<number | null>(null)
  // Skip the navigate-effect for the nonce we mounted with; the src already points there.
  const appliedNonce = useRef<number | undefined>(target?.nonce)

  // Navigate by updating the reactive `src` attribute. Imperative loadURL can throw if the webview
  // is not attached yet, which would trip the ErrorBoundary and wedge the UI.
  function navigate(to: string): void {
    setLoadState('loading')
    setLoadError(null)
    if (srcRef.current === to) {
      // Same URL: the attribute will not change, so force a reload and bypass cache.
      try {
        webviewRef.current?.reloadIgnoringCache()
      } catch {
        /* not attached yet; dom-ready will register */
      }
    } else {
      srcRef.current = to
      setSrc(to)
    }
  }

  function go(value?: string): void {
    const u = normalize(value ?? url)
    if (!u) return
    setUrl(u)
    navigate(u)
  }

  function reload(): void {
    setLoadState('loading')
    setLoadError(null)
    try {
      webviewRef.current?.reloadIgnoringCache()
    } catch {
      /* not attached */
    }
  }

  // Register the guest's webContents id with main so agent tools can drive it.
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const register = (ready = true): void => {
      try {
        const id = wv.getWebContentsId()
        const currentUrl = wv.getURL()
        const currentTitle = wv.getTitle()
        guestIdRef.current = id
        setTitle(currentTitle || hostLabel(currentUrl))
        window.api.preview.register({ webContentsId: id, url: currentUrl, title: currentTitle, ready })
      } catch {
        /* not attached yet */
      }
    }
    const onStart = (): void => {
      setLoadState('loading')
      setLoadError(null)
    }
    const onReady = (): void => {
      setLoadState('ready')
      setLoadError(null)
      try {
        setUrl(wv.getURL())
        setTitle(wv.getTitle() || hostLabel(wv.getURL()))
      } catch {
        /* ignore */
      }
      register(true)
    }
    const onAttach = (): void => register(false)
    const onDomReady = (): void => register(true)
    const onFail = (event: Event): void => {
      const e = event as Event & { errorDescription?: string; validatedURL?: string; isMainFrame?: boolean }
      if (e.isMainFrame === false) return
      setLoadState('error')
      setLoadError(e.errorDescription || 'Preview could not be loaded.')
      if (e.validatedURL) setUrl(e.validatedURL)
      register(true)
    }
    const onNavigate = (): void => {
      try {
        setUrl(wv.getURL())
        setTitle(wv.getTitle() || hostLabel(wv.getURL()))
      } catch {
        /* ignore */
      }
      register(false)
    }
    // Register as soon as the guest attaches so main captures startup errors from the first scripts,
    // then again on navigation to keep URL/title current.
    wv.addEventListener('did-attach', onAttach)
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onReady)
    wv.addEventListener('did-finish-load', onReady)
    wv.addEventListener('did-fail-load', onFail)
    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate)
    return () => {
      wv.removeEventListener('did-attach', onAttach)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onReady)
      wv.removeEventListener('did-finish-load', onReady)
      wv.removeEventListener('did-fail-load', onFail)
      wv.removeEventListener('dom-ready', onDomReady)
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigate)
      if (guestIdRef.current !== null) window.api.preview.closed(guestIdRef.current)
    }
  }, [])

  // Navigate when the agent requests a new URL (nonce changes).
  useEffect(() => {
    if (target?.nonce === undefined || target.nonce === appliedNonce.current) return
    appliedNonce.current = target.nonce
    setUrl(target.url)
    navigate(target.url)
  }, [target?.nonce, target?.url])

  return (
    <div className="panel preview-panel">
      <div className="preview-console">
        <PreviewScope state={loadState} />
        <div className="preview-command">
          <span className={`preview-led ${loadState}`} aria-hidden="true" />
          <label className="preview-address">
            <Icon name="eye" size={14} />
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') go()
              }}
              placeholder={DEFAULT_URL}
              aria-label="Preview URL"
              spellCheck={false}
            />
          </label>
          <button className="icon-btn preview-action" onClick={() => go()} title="Load" aria-label="Load URL">
            <Icon name="chevron-right" size={16} />
          </button>
          <button className="icon-btn preview-action" onClick={reload} title="Reload" aria-label="Reload preview">
            <Icon name="refresh" size={15} />
          </button>
        </div>
        <div className="preview-meta">
          <span className={`preview-state ${loadState}`} role="status" aria-live="polite">
            {loadState === 'loading' ? 'Loading' : loadState === 'error' ? 'Offline' : 'Live'}
          </span>
          <span className="preview-title">{title}</span>
        </div>
        <div className="preview-quick">
          {QUICK_URLS.map((quick) => (
            <button
              key={quick.url}
              className={hostLabel(src) === hostLabel(quick.url) ? 'active' : ''}
              type="button"
              aria-pressed={hostLabel(src) === hostLabel(quick.url)}
              aria-label={`Open ${quick.label} preview at ${quick.url}`}
              onClick={() => go(quick.url)}
            >
              {quick.label}
            </button>
          ))}
        </div>
      </div>
      {/* <webview> embeds the dev server in an isolated guest page. A single persistent element keeps
          the guest's webContents id stable so main can keep driving it. */}
      <div className={`preview-stage ${loadState}`}>
        <webview
          ref={webviewRef as unknown as Ref<HTMLElement>}
          src={src}
          className="preview-frame"
          partition="preview"
          aria-label="Embedded preview"
        />
        {loadState === 'loading' && (
          <div className="preview-overlay loading" aria-hidden="true">
            <span className="preview-spinner" />
            <span>Loading preview</span>
          </div>
        )}
        {loadState === 'error' && (
          <div className="preview-overlay error">
            <div className="preview-error-card">
              <span className="preview-error-icon" aria-hidden="true">
                <Icon name="slash" size={18} />
              </span>
              <strong>Preview is offline</strong>
              <span>{loadError ?? 'The local page did not respond.'}</span>
              <button type="button" className="btn ghost" onClick={reload}>
                <Icon name="refresh" size={13} />
                Try again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function PreviewScope({ state }: { state: LoadState }) {
  const label = state === 'ready' ? 'Viewport ready' : state === 'loading' ? 'Viewport loading' : 'Viewport offline'
  const detail = state === 'ready' ? 'Connected' : state === 'loading' ? 'Navigating' : 'Server check'
  return (
    <div className={`preview-scope ${state}`}>
      <svg className="preview-scope-art" viewBox="0 0 164 82" aria-hidden="true" focusable="false">
        <path className="preview-scope-grid" d="M16 16H148M16 41H148M16 66H148M42 8V74M82 8V74M122 8V74" />
        <rect className="preview-scope-frame" x="27" y="20" width="72" height="42" rx="6" />
        <path className="preview-scope-ray" d="M20 62C48 23 75 58 99 36S134 18 148 30" />
        <circle className="preview-scope-node start" cx="27" cy="62" r="4" />
        <circle className="preview-scope-node mid" cx="99" cy="36" r="5" />
        <circle className="preview-scope-node end" cx="148" cy="30" r="4" />
      </svg>
      <div className="preview-scope-copy">
        <span>Preview lens</span>
        <b>{label}</b>
        <small>{detail}</small>
      </div>
    </div>
  )
}
