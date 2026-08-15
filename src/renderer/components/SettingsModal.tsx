import { useEffect, useRef, useState } from 'react'
import type {
  AgentMode,
  Connection,
  ConnectionKind,
  ImageProvider,
  MCPServerConfig,
  MCPServerStatus,
  MCPTransport,
  Settings,
  Theme,
  Verbosity
} from '../../shared/domain-types'
import type { UpdateStatus } from '../../shared/ipc-types'
import { CONNECTION_KINDS, DEFAULT_BASE_URL } from '../../shared/domain-types'
import { VOICE_FEATURE_ENABLED } from '../../shared/features'
import { MODE_META, MODE_ORDER } from '../modeMeta'

/** Read-only capability line under the model picker — what the harness knows about this model
 *  (seeded registry + runtime-learned facts), so the toggles below have honest context. */
function ModelProfileHint({ model }: { model: string }) {
  const [line, setLine] = useState('')
  useEffect(() => {
    let alive = true
    if (!model) {
      setLine('')
      return
    }
    window.api.lmstudio
      .profileDescribe(model)
      .then((s) => {
        if (alive) setLine(s)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [model])
  if (!line) return null
  return <p className="settings-hint">{line}</p>
}

const KIND_LABELS: Record<ConnectionKind, string> = {
  lmstudio: 'LM Studio (local)',
  ollama: 'Ollama (local)',
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  'openai-compat': 'OpenAI-compatible (custom)',
  gemini: 'Google Gemini'
}
/** Local backends ignore keys; cloud ones need one. */
const KIND_NEEDS_KEY: Record<ConnectionKind, boolean> = {
  lmstudio: false,
  ollama: false,
  openai: true,
  anthropic: true,
  'openai-compat': true,
  gemini: true
}

const SETTINGS_NAV = [
  { id: 'settings-overview', label: 'Overview', detail: 'Current shape' },
  { id: 'settings-connections', label: 'Backends', detail: 'Providers and keys' },
  { id: 'settings-chat', label: 'Chat', detail: 'Defaults and memory' },
  { id: 'settings-runs', label: 'Runs', detail: 'Worker routing' },
  { id: 'settings-image', label: 'Images', detail: 'Generation tools' },
  { id: 'settings-tools', label: 'Tools', detail: 'MCP servers' },
  { id: 'settings-voice', label: 'Voice', detail: 'Speech sidecar' }
] as const

/** Model picker for the Loop drain: a dropdown of the backend's probed models (typing an id is error-prone),
 *  with "backend default" and any already-saved value preserved as options so a selection is never lost. */
function ModelSelect({
  value,
  models,
  onChange
}: {
  value: string
  /** undefined = not probed yet; [] = backend reachable but listed nothing (or offline). */
  models: string[] | undefined
  onChange: (v: string) => void
}) {
  const list = models ?? []
  const savedMissing = value.trim() !== '' && !list.includes(value)
  const note =
    models === undefined ? 'probing…' : list.length === 0 && !savedMissing ? 'no models — start the backend, then reopen Settings' : ''
  return (
    <>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— backend default —</option>
        {list.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        {savedMissing && <option value={value}>{value} (not loaded)</option>}
      </select>
      {note && <span className="settings-hint settings-hint-inline">{note}</span>}
    </>
  )
}

export function SettingsModal({
  settings,
  onClose,
  onSave
}: {
  settings: Settings
  onClose: () => void
  onSave: (patch: Partial<Settings>) => void
}) {
  const [connections, setConnections] = useState<Connection[]>(settings.connections.map((c) => ({ ...c })))
  const [activeId, setActiveId] = useState(settings.activeConnectionId)
  const [temperature, setTemperature] = useState(String(settings.temperature))
  const [maxTurns, setMaxTurns] = useState(String(settings.maxTurns))
  const [contextLimit, setContextLimit] = useState(String(settings.contextLimitTokens))
  const [maxTokens, setMaxTokens] = useState(settings.maxTokens === null ? '' : String(settings.maxTokens))
  const [theme, setTheme] = useState<Theme>(settings.theme)
  const [mode, setMode] = useState<AgentMode>(settings.mode)
  const [verbosity, setVerbosity] = useState<Verbosity>(settings.verbosity)
  const [mascotEnabled, setMascotEnabled] = useState(settings.mascotEnabled !== false)
  const [autoMemory, setAutoMemory] = useState(settings.autoMemory !== false)
  const [shellScreening, setShellScreening] = useState(settings.shellScreening !== 'off')
  // W4a self-update: installed-vs-pending build status + the pending-build folder.
  const [updateSourceDir, setUpdateSourceDir] = useState(settings.updateSourceDir ?? '')
  const [updStatus, setUpdStatus] = useState<UpdateStatus | null>(null)
  const [updError, setUpdError] = useState('')
  useEffect(() => {
    void window.api.update.status().then(setUpdStatus)
  }, [])
  const onInstallUpdate = (): void => {
    setUpdError('')
    void window.api.update.install().then((r) => {
      // ok → the app quits under us; only a refusal comes back.
      if (!r.ok) setUpdError(r.error ?? 'Install failed.')
    })
  }
  const [imgProvider, setImgProvider] = useState<ImageProvider>(settings.image.provider)
  const [imgBaseURL, setImgBaseURL] = useState(settings.image.baseURL)
  const [imgApiKey, setImgApiKey] = useState(settings.image.apiKey)
  const [imgModel, setImgModel] = useState(settings.image.model)
  const [imgSize, setImgSize] = useState(settings.image.size)
  const [imgSteps, setImgSteps] = useState(String(settings.image.steps))
  const [voiceEnabled, setVoiceEnabled] = useState(settings.voice.enabled)
  const [voiceURL, setVoiceURL] = useState(settings.voice.sidecarURL)
  const [voiceName, setVoiceName] = useState(settings.voice.voice)
  const [voiceAutoSend, setVoiceAutoSend] = useState(settings.voice.autoSend)
  const [voiceSpeak, setVoiceSpeak] = useState(settings.voice.speakReplies)
  const [voiceWake, setVoiceWake] = useState(settings.voice.wakeWord)
  const [mcpServers, setMcpServers] = useState<MCPServerConfig[]>(settings.mcpServers.map((s) => ({ ...s })))
  // args/env are edited as raw text and parsed only at save, so typing never round-trips through the array/object.
  const [mcpArgsText, setMcpArgsText] = useState<Record<string, string>>(() =>
    Object.fromEntries(settings.mcpServers.map((s) => [s.id, (s.args ?? []).join('\n')]))
  )
  const [mcpEnvText, setMcpEnvText] = useState<Record<string, string>>(() =>
    Object.fromEntries(settings.mcpServers.map((s) => [s.id, envToText(s.env)]))
  )
  const [mcpStatus, setMcpStatus] = useState<MCPServerStatus[]>([])
  const [loopWorker, setLoopWorker] = useState(settings.loopWorkerConnectionId ?? settings.activeConnectionId)
  const [loopWorkerModel, setLoopWorkerModel] = useState(settings.loopWorkerModel ?? '')
  const [loopReviewer, setLoopReviewer] = useState(settings.loopReviewerConnectionId ?? '')
  const [loopReviewerModel, setLoopReviewerModel] = useState(settings.loopReviewerModel ?? '')
  const [loopPlanner, setLoopPlanner] = useState(settings.hermesPlannerConnectionId ?? '')
  const [loopPlannerModel, setLoopPlannerModel] = useState(settings.hermesPlannerModel ?? '')
  const [loopDesigner, setLoopDesigner] = useState(settings.hermesDesignerConnectionId ?? '')
  const [loopDesignerModel, setLoopDesignerModel] = useState(settings.hermesDesignerModel ?? '')
  const [loopParallelism, setLoopParallelism] = useState(settings.loopParallelism ?? 1)
  const [loopSwap, setLoopSwap] = useState(settings.loopSwapModels ?? true)
  const [keepReviewer, setKeepReviewer] = useState(settings.keepReviewerResident ?? false)
  const [lazyOrch, setLazyOrch] = useState(settings.hermesLazyOrchestration ?? false)
  const [boardPath, setBoardPath] = useState(settings.ticketBoardPath ?? '')
  // Live model lists per backend (probed from /models) so the Loop drain picks a model from a dropdown
  // instead of a typed id — `undefined` = not probed yet, `[]` = backend reachable but no models listed.
  const [modelsByConn, setModelsByConn] = useState<Record<string, string[] | undefined>>({})
  const [error, setError] = useState('')
  const modalRef = useRef<HTMLDivElement>(null)

  // Probe the selected worker + reviewer backends for their available models. Re-runs when either
  // selection (or its connection details) changes; the 5s-timeout probe degrades to an empty list offline.
  const loopWorkerConn = connections.find((c) => c.id === loopWorker)
  const loopReviewerConn = connections.find((c) => c.id === loopReviewer)
  const loopPlannerConn = connections.find((c) => c.id === loopPlanner)
  const loopDesignerConn = connections.find((c) => c.id === loopDesigner)
  useEffect(() => {
    let active = true
    const probe = async (conn?: Connection): Promise<void> => {
      if (!conn) return
      try {
        // listModels (not probe): LM Studio returns UNLOADED installed models too, so a swap-based loop can
        // pick a model that isn't currently resident.
        const models = await window.api.lmstudio.models({ baseURL: conn.baseURL, apiKey: conn.apiKey, kind: conn.kind })
        if (active) setModelsByConn((m) => ({ ...m, [conn.id]: models }))
      } catch {
        if (active) setModelsByConn((m) => ({ ...m, [conn.id]: [] }))
      }
    }
    const seen = new Set<string>()
    for (const conn of [loopWorkerConn, loopReviewerConn, loopPlannerConn, loopDesignerConn]) {
      if (!conn || seen.has(conn.id)) continue
      seen.add(conn.id)
      void probe(conn)
    }
    return () => {
      active = false
    }
  }, [
    loopWorkerConn?.id,
    loopWorkerConn?.baseURL,
    loopWorkerConn?.apiKey,
    loopWorkerConn?.kind,
    loopReviewerConn?.id,
    loopReviewerConn?.baseURL,
    loopReviewerConn?.apiKey,
    loopReviewerConn?.kind,
    loopPlannerConn?.id,
    loopPlannerConn?.baseURL,
    loopPlannerConn?.apiKey,
    loopPlannerConn?.kind,
    loopDesignerConn?.id,
    loopDesignerConn?.baseURL,
    loopDesignerConn?.apiKey,
    loopDesignerConn?.kind
  ])

  // Suggest the conventional default URL when switching providers (only if the field still holds another
  // provider's default), so the form stays sensible without clobbering a custom URL.
  const PROVIDER_DEFAULTS: Record<ImageProvider, string> = {
    a1111: 'http://127.0.0.1:7860',
    comfyui: 'http://127.0.0.1:8188',
    openai: 'https://api.openai.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta'
  }
  function onProviderChange(p: ImageProvider): void {
    const wasDefault = Object.values(PROVIDER_DEFAULTS).includes(imgBaseURL.trim())
    setImgProvider(p)
    if (!imgBaseURL.trim() || wasDefault) setImgBaseURL(PROVIDER_DEFAULTS[p])
  }

  // ---- Connections (multi-backend) ----
  function patchConn(id: string, patch: Partial<Connection>): void {
    setConnections((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }
  function onConnKind(id: string, kind: ConnectionKind): void {
    setConnections((cs) =>
      cs.map((c) => {
        if (c.id !== id) return c
        // Swap in the kind's default URL only if the field is empty or still holds another kind's default.
        const wasDefault = Object.values(DEFAULT_BASE_URL).includes(c.baseURL.trim())
        return { ...c, kind, baseURL: !c.baseURL.trim() || wasDefault ? DEFAULT_BASE_URL[kind] : c.baseURL }
      })
    )
  }
  function addConn(): void {
    const id = `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    setConnections((cs) => [
      ...cs,
      {
        id,
        label: 'New backend',
        kind: 'openai-compat',
        baseURL: DEFAULT_BASE_URL['openai-compat'],
        apiKey: '',
        model: '',
        temperature: null,
        maxTokens: null,
        contextLimitTokens: null
      }
    ])
  }
  function removeConn(id: string): void {
    setConnections((cs) => {
      const next = cs.filter((c) => c.id !== id)
      if (id === activeId && next[0]) setActiveId(next[0].id)
      return next
    })
  }

  // ---- MCP servers (external tools) ----
  function patchMcp(id: string, patch: Partial<MCPServerConfig>): void {
    setMcpServers((ss) => ss.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }
  function addMcp(): void {
    const id = `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    setMcpServers((ss) => [...ss, { id, label: 'board', transport: 'http', enabled: true, url: 'http://127.0.0.1:8930/mcp' }])
    setMcpArgsText((t) => ({ ...t, [id]: '' }))
    setMcpEnvText((t) => ({ ...t, [id]: '' }))
  }
  function removeMcp(id: string): void {
    setMcpServers((ss) => ss.filter((s) => s.id !== id))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Poll live MCP connection status while the dialog is open, so the user sees servers connect/fail.
  useEffect(() => {
    let alive = true
    const load = (): void => {
      window.api.mcp
        .status()
        .then((s) => alive && setMcpStatus(s))
        .catch(() => undefined)
    }
    load()
    const iv = setInterval(load, 2500)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [])

  // Trap Tab focus within the dialog.
  useEffect(() => {
    const node = modalRef.current
    if (!node) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const f = node.querySelectorAll<HTMLElement>('input, select, textarea, button, [tabindex]:not([tabindex="-1"])')
      if (!f.length) return
      const first = f[0]
      const last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    node.addEventListener('keydown', onKey)
    return () => node.removeEventListener('keydown', onKey)
  }, [])

  function save(): void {
    if (connections.length === 0) {
      setError('Add at least one backend connection.')
      return
    }
    const cleanConns: Connection[] = connections.map((c) => ({
      ...c,
      label: c.label.trim() || KIND_LABELS[c.kind],
      baseURL: c.baseURL.trim(),
      apiKey: c.apiKey.trim(),
      model: c.model.trim()
    }))
    for (const c of cleanConns) {
      try {
        const u = new URL(c.baseURL)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol')
      } catch {
        setError(`Connection “${c.label}” needs a valid http(s) Base URL, e.g. http://127.0.0.1:1234/v1`)
        return
      }
    }
    const active = cleanConns.some((c) => c.id === activeId) ? activeId : cleanConns[0].id
    const imgUrl = imgBaseURL.trim()
    if (imgUrl) {
      try {
        const u = new URL(imgUrl)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol')
      } catch {
        setError('Image base URL must be a valid http(s) URL, e.g. http://127.0.0.1:7860')
        return
      }
    }
    const voiceUrl = voiceURL.trim() || 'http://127.0.0.1:8123'
    try {
      const u = new URL(voiceUrl)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol')
    } catch {
      setError('Voice sidecar URL must be a valid http(s) URL, e.g. http://127.0.0.1:8123')
      return
    }
    // Validate + normalize MCP servers.
    const cleanMcp: MCPServerConfig[] = []
    for (const s of mcpServers) {
      const label = s.label.trim()
      if (!label) {
        setError('Every MCP server needs a label (it prefixes its tool names).')
        return
      }
      if (s.transport === 'http') {
        const url = (s.url ?? '').trim()
        try {
          const u = new URL(url)
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol')
        } catch {
          setError(`MCP server “${label}” needs a valid http(s) URL, e.g. http://127.0.0.1:8930/mcp`)
          return
        }
        cleanMcp.push({ id: s.id, label, transport: 'http', enabled: s.enabled, url })
      } else {
        const command = (s.command ?? '').trim()
        if (!command) {
          setError(`MCP server “${label}” (stdio) needs a command, e.g. npx`)
          return
        }
        const args = parseArgs(mcpArgsText[s.id] ?? '')
        const env = parseEnv(mcpEnvText[s.id] ?? '')
        cleanMcp.push({
          id: s.id,
          label,
          transport: 'stdio',
          enabled: s.enabled,
          command,
          ...(args.length ? { args } : {}),
          ...(Object.keys(env).length ? { env } : {})
        })
      }
    }
    // Two enabled servers that sanitize to the same prefix would shadow each other's tools.
    const prefixes = cleanMcp.filter((s) => s.enabled).map((s) => mcpPrefix(s.label))
    const dupPrefix = prefixes.find((p, i) => prefixes.indexOf(p) !== i)
    if (dupPrefix) {
      setError(`Two enabled MCP servers resolve to the same tool prefix “${dupPrefix}”. Give them distinct labels.`)
      return
    }
    onSave({
      // Mirror the active connection into the legacy flat field so it stays a valid http(s) URL.
      baseURL: cleanConns.find((c) => c.id === active)?.baseURL || settings.baseURL,
      connections: cleanConns,
      activeConnectionId: active,
      temperature: clampNum(temperature, 0, 2, settings.temperature),
      maxTurns: Math.round(clampNum(maxTurns, 1, 200, settings.maxTurns)),
      contextLimitTokens: Math.round(clampNum(contextLimit, 1024, 2_000_000, settings.contextLimitTokens)),
      maxTokens: maxTokens.trim() === '' ? null : Math.round(clampNum(maxTokens, 1, 1_000_000, settings.maxTokens ?? 4096)),
      theme,
      mode,
      verbosity,
      mascotEnabled,
      autoMemory,
      shellScreening: shellScreening ? 'screen' : 'off',
      updateSourceDir: updateSourceDir.trim(),
      image: {
        provider: imgProvider,
        baseURL: imgUrl,
        apiKey: imgApiKey.trim(),
        model: imgModel.trim(),
        size: imgSize.trim() || '1024x1024',
        steps: Math.round(clampNum(imgSteps, 1, 150, settings.image.steps))
      },
      voice: {
        enabled: voiceEnabled,
        sidecarURL: voiceUrl,
        voice: voiceName,
        autoSend: voiceAutoSend,
        speakReplies: voiceSpeak,
        wakeWord: voiceWake
      },
      mcpServers: cleanMcp,
      loopWorkerConnectionId: loopWorker,
      loopWorkerModel: loopWorkerModel.trim() || undefined,
      loopReviewerConnectionId: loopReviewer || undefined,
      loopReviewerModel: loopReviewerModel.trim() || undefined,
      hermesPlannerConnectionId: loopPlanner || undefined,
      hermesPlannerModel: loopPlannerModel.trim() || undefined,
      hermesDesignerConnectionId: loopDesigner || undefined,
      hermesDesignerModel: loopDesignerModel.trim() || undefined,
      loopParallelism: loopParallelism > 1 ? loopParallelism : undefined,
      loopSwapModels: loopSwap,
      keepReviewerResident: keepReviewer,
      hermesLazyOrchestration: lazyOrch || undefined,
      ticketBoardPath: boardPath.trim() || undefined
    })
    onClose()
  }

  const connectionLabel = (id?: string): string => {
    if (!id) return 'Worker default'
    return connections.find((c) => c.id === id)?.label || 'Missing backend'
  }
  const activeConn = connections.find((c) => c.id === activeId)
  const enabledMcpCount = mcpServers.filter((s) => s.enabled).length
  const connectedMcpCount = mcpStatus.filter((s) => s.status === 'connected').length
  const runRoles = [
    { key: 'worker', label: 'Worker', conn: connectionLabel(loopWorker), model: loopWorkerModel || 'backend default', tone: 'green' },
    { key: 'reviewer', label: 'Reviewer', conn: loopReviewer ? connectionLabel(loopReviewer) : 'Human/check only', model: loopReviewerModel || 'backend default', tone: 'amber' },
    { key: 'planner', label: 'Planner', conn: loopPlanner ? connectionLabel(loopPlanner) : 'Worker fallback', model: loopPlannerModel || 'backend default', tone: 'accent' },
    { key: 'designer', label: 'Designer', conn: loopDesigner ? connectionLabel(loopDesigner) : 'Worker fallback', model: loopDesignerModel || 'backend default', tone: 'blue' }
  ] as const

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-top">
          <div className="settings-title-block">
            <span className="settings-kicker">Control center</span>
            <h2 id="settings-title">Settings</h2>
            <p>Route models, tools, voice, and the interface from one place.</p>
          </div>
          <div className="settings-health-row" aria-label="Settings summary">
            <div className="settings-health-card">
              <span>Chat backend</span>
              <b>{activeConn?.label || 'Not set'}</b>
            </div>
            <div className="settings-health-card">
              <span>Runs</span>
              <b>{loopReviewer ? 'reviewed' : 'human check'}</b>
            </div>
            <div className="settings-health-card">
              <span>Tools</span>
              <b>{connectedMcpCount}/{enabledMcpCount || 0} online</b>
            </div>
          </div>
        </div>
        {error && <div className="modal-error">{error}</div>}

        <div className="settings-body">
          <aside className="settings-nav" aria-label="Settings sections">
            {SETTINGS_NAV.filter((item) => VOICE_FEATURE_ENABLED || item.id !== 'settings-voice').map((item) => (
              <a key={item.id} href={`#${item.id}`}>
                <span>{item.label}</span>
                <small>{item.detail}</small>
              </a>
            ))}
          </aside>

          <div className="settings-main">
            <section className="settings-card settings-overview-card" id="settings-overview">
              <div className="settings-card-headline">
                <div>
                  <span className="settings-section">Overview</span>
                  <h3>How BasenjiCode is wired right now</h3>
                </div>
              </div>
              <div className="settings-route-map" aria-label="Runs model routing">
                {runRoles.map((role, i) => (
                  <div className={`settings-route-node route-${role.tone}`} key={role.key}>
                    <span className="route-index">{i + 1}</span>
                    <b>{role.label}</b>
                    <span>{role.conn}</span>
                    <small>{role.model}</small>
                  </div>
                ))}
              </div>
              <div className="settings-overview-grid">
                <div>
                  <span>Interface</span>
                  <b>{theme === 'light' ? 'Light' : 'Dark'} / {MODE_META[mode].label}</b>
                </div>
                <div>
                  <span>Transcript</span>
                  <b>{verbosity === 'compact' ? 'Compact summaries' : 'Verbose output'}</b>
                </div>
                <div>
                  <span>Mascot</span>
                  <b>{mascotEnabled ? 'Composer nook on' : 'Hidden'}</b>
                </div>
              </div>
            </section>

            <section className="settings-card" id="settings-connections">
              <div className="settings-card-headline">
                <div>
                  <span className="settings-section">Backends / connections</span>
                  <h3>Model providers</h3>
                </div>
                <button className="btn conn-add" onClick={addConn}>
                  + Add connection
                </button>
              </div>
        <p className="settings-hint">
          Add any OpenAI-compatible backend — LM Studio, Ollama, OpenAI, Anthropic (Claude), OpenRouter, etc.
          The active one runs your chat; sub-agents can route to any of them.
        </p>
        {connections.map((c, i) => (
          <div className="conn-card" key={c.id}>
            <div className="conn-card-head">
              <label className="settings-check conn-active">
                <input
                  type="radio"
                  name="active-conn"
                  checked={activeId === c.id}
                  onChange={() => setActiveId(c.id)}
                />
                Active
              </label>
              <input
                className="conn-label"
                value={c.label}
                onChange={(e) => patchConn(c.id, { label: e.target.value })}
                placeholder="Label"
                aria-label="Connection label"
                autoFocus={i === 0}
              />
              <button
                className="icon-btn conn-remove"
                onClick={() => removeConn(c.id)}
                disabled={connections.length === 1}
                title={connections.length === 1 ? 'At least one connection is required' : 'Remove connection'}
                aria-label="Remove connection"
              >
                ✕
              </button>
            </div>
            <div className="settings-row">
              <label>
                Kind
                <select value={c.kind} onChange={(e) => onConnKind(c.id, e.target.value as ConnectionKind)}>
                  {CONNECTION_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Model {c.kind === 'lmstudio' || c.kind === 'ollama' ? '(blank = server default)' : ''}
                <input
                  value={c.model}
                  onChange={(e) => patchConn(c.id, { model: e.target.value })}
                  placeholder={c.kind === 'anthropic' ? 'claude-opus-4-8' : c.kind === 'openai' ? 'gpt-4o' : ''}
                />
              </label>
            </div>
            <ModelProfileHint model={c.model} />
            <label>
              Base URL
              <input
                value={c.baseURL}
                onChange={(e) => patchConn(c.id, { baseURL: e.target.value })}
                placeholder={DEFAULT_BASE_URL[c.kind]}
              />
            </label>
            {KIND_NEEDS_KEY[c.kind] && (
              <label>
                API key
                <input
                  type="password"
                  value={c.apiKey}
                  onChange={(e) => patchConn(c.id, { apiKey: e.target.value })}
                  placeholder={c.kind === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
                />
              </label>
            )}
            <div className="settings-row">
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={!!c.preferTextToolCalls}
                  onChange={(e) => patchConn(c.id, { preferTextToolCalls: e.target.checked })}
                />
                Text tool-call mode
              </label>
              <label>
                Reasoning
                <select
                  value={c.reasoningEffort ?? ''}
                  onChange={(e) =>
                    patchConn(c.id, { reasoningEffort: (e.target.value || undefined) as Connection['reasoningEffort'] })
                  }
                >
                  <option value="">Model default</option>
                  <option value="off">Off (no thinking)</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </label>
            </div>
            <p className="settings-hint">
              Text tool-call mode helps weak local models that emit empty/truncated native tool calls. Reasoning
              “Off” stops a thinking model from spending its output budget before the tool call.
            </p>
          </div>
        ))}
            </section>

            <section className="settings-card" id="settings-chat">
              <div className="settings-card-headline">
                <div>
                  <span className="settings-section">Chat / interface</span>
                  <h3>Conversation defaults</h3>
                </div>
              </div>
              <p className="settings-hint">Applied to every connection unless overridden per-connection.</p>
        <div className="settings-row">
          <label>
            Theme
            <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <label>
            Default approval mode
            <select value={mode} onChange={(e) => setMode(e.target.value as AgentMode)}>
              {MODE_ORDER.map((m) => (
                <option key={m} value={m}>
                  {MODE_META[m].label} - {MODE_META[m].desc}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Temperature
          <input type="number" min="0" max="2" step="0.05" value={temperature} onChange={(e) => setTemperature(e.target.value)} />
        </label>
        <label>
          Max turns per message
          <input value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} />
        </label>
        <label>
          Context window (tokens)
          <input value={contextLimit} onChange={(e) => setContextLimit(e.target.value)} />
        </label>
        <label>
          Max tokens per reply (blank = model default)
          <input value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
        </label>
        {maxTokens.trim() !== '' && Number(maxTokens) > 0 && Number(maxTokens) < 4096 && (
          <p className="settings-hint">
            ⚠ {Number(maxTokens).toLocaleString()} is low for tool use — the model can truncate a write_file /
            edit_file argument before it finishes. Recommend ≥ 8192 for agentic / file-writing work.
          </p>
        )}
        <label>
          Transcript density
          <select value={verbosity} onChange={(e) => setVerbosity(e.target.value as Verbosity)}>
            <option value="compact">Compact — one-line tool summaries (Ctrl+O)</option>
            <option value="verbose">Verbose — full tool output</option>
          </select>
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={mascotEnabled} onChange={(e) => setMascotEnabled(e.target.checked)} />
          Show mascot above composer
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={autoMemory} onChange={(e) => setAutoMemory(e.target.checked)} />
          Auto-memory — save durable facts at compaction and a lesson when a task gets stuck
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={shellScreening} onChange={(e) => setShellScreening(e.target.checked)} />
          Shell screening — in Auto mode, dangerous commands (writes outside the workspace, download-and-run,
          system/registry changes, credential paths) ask first in chat and are refused with guidance in Runs
        </label>
        {updStatus?.packaged && (
          <>
            <label>
              Pending-build folder (…\dist\win-unpacked)
              <input value={updateSourceDir} onChange={(e) => setUpdateSourceDir(e.target.value)} placeholder="C:\path\to\your\repo\dist\win-unpacked" />
            </label>
            <p className="settings-hint">
              {updStatus.state === 'pending' && `A newer build is ready (packaged ${new Date(updStatus.pendingAt ?? 0).toLocaleString()}).`}
              {updStatus.state === 'up-to-date' && `This build is current (installed ${new Date(updStatus.installedAt ?? 0).toLocaleString()}).`}
              {updStatus.state === 'no-pending-build' && 'No packaged build found in the folder above.'}
              {updStatus.state === 'pending-invalid' && 'The packaged build looks incomplete (undersized app.asar) — repackage before installing.'}
              {updStatus.state === 'unconfigured' && 'Point this at the repo build output to enable one-click updates.'}
              {updStatus.lastResult && !updStatus.lastResult.ok && ` Last self-update FAILED (robocopy rc=${updStatus.lastResult.rc ?? '?'}).`}
            </p>
            <button className="btn" disabled={updStatus.state !== 'pending'} onClick={onInstallUpdate}>
              Install pending build & restart
            </button>
            {updError && <p className="settings-hint">{updError}</p>}
          </>
        )}
        <p className="settings-hint">
          Writes to the same capped project memory (.nordcode/memory.md) as remember/forget; entries are tagged
          [auto] / [lesson] so you can spot and prune them. Off → only manual remember() writes.
        </p>

            </section>

            <section className="settings-card" id="settings-runs">
              <div className="settings-card-headline">
                <div>
                  <span className="settings-section">Runs</span>
                  <h3>Worker routing and policies</h3>
                </div>
              </div>
        <p className="settings-hint">
          The Runs worker writes each ticket; the reviewer judges its diff and sends it back for revision
          until approved. Pick a backend (where) <em>and</em> a model (what) for each — they can share one backend
          (e.g. a big worker model + a small reviewer model on the same LM Studio). Leave the reviewer as “none” for
          check/human-only.
        </p>
        <div className="settings-row">
          <label>
            Worker backend
            <select value={loopWorker} onChange={(e) => setLoopWorker(e.target.value)}>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Worker model (blank = backend default)
            <ModelSelect value={loopWorkerModel} models={modelsByConn[loopWorker]} onChange={setLoopWorkerModel} />
          </label>
        </div>
        <div className="settings-row">
          <label>
            Reviewer backend
            <select value={loopReviewer} onChange={(e) => setLoopReviewer(e.target.value)}>
              <option value="">— none (check / human only) —</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reviewer model (blank = backend default)
            {loopReviewer ? (
              <ModelSelect value={loopReviewerModel} models={modelsByConn[loopReviewer]} onChange={setLoopReviewerModel} />
            ) : (
              <select disabled>
                <option>— pick a reviewer backend first —</option>
              </select>
            )}
          </label>
        </div>
        <div className="settings-row">
          <label>
            Planner backend (decompose / replan / critic)
            <select value={loopPlanner} onChange={(e) => setLoopPlanner(e.target.value)}>
              <option value="">— none (use the worker) —</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Planner model (blank = backend default)
            {loopPlanner ? (
              <ModelSelect value={loopPlannerModel} models={modelsByConn[loopPlanner]} onChange={setLoopPlannerModel} />
            ) : (
              <select disabled>
                <option>— pick a planner backend first —</option>
              </select>
            )}
          </label>
        </div>
        <div className="settings-row">
          <label>
            Designer backend (design / visual / art tickets)
            <select value={loopDesigner} onChange={(e) => setLoopDesigner(e.target.value)}>
              <option value="">— none (use the worker/coder) —</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Designer model (blank = backend default)
            {loopDesigner ? (
              <ModelSelect value={loopDesignerModel} models={modelsByConn[loopDesigner]} onChange={setLoopDesignerModel} />
            ) : (
              <select disabled>
                <option>— pick a designer backend first —</option>
              </select>
            )}
          </label>
        </div>
        <label>
          Parallel coding tickets (independent implementation tickets drained concurrently; 1 = sequential)
          <select value={loopParallelism} onChange={(e) => setLoopParallelism(Number(e.target.value))}>
            <option value={1}>1 — sequential (default)</option>
            <option value={2}>2 — parallel ×2</option>
            <option value={3}>3 — parallel ×3</option>
            <option value={4}>4 — parallel ×4</option>
          </select>
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={loopSwap} onChange={(e) => setLoopSwap(e.target.checked)} />
          Swap models in/out of VRAM so only one is resident at a time
        </label>
        {loopSwap && (
          <label className="settings-check" style={{ marginLeft: 24 }}>
            <input type="checkbox" checked={keepReviewer} onChange={(e) => setKeepReviewer(e.target.checked)} />
            Keep coder + reviewer/visual worker resident together (no code↔review swap) — only when they fit in VRAM; the planner still swaps
          </label>
        )}
        <label className="settings-check">
          <input type="checkbox" checked={lazyOrch} onChange={(e) => setLazyOrch(e.target.checked)} />
          Manager-owned (lazy) orchestration — attempt the whole goal as one coarse ticket and split only what parks, instead of eager decomposition (experimental)
        </label>
        <label>
          Ticket board project path — BasenjiCode auto-starts it on launch when it isn&rsquo;t already running
          <input value={boardPath} onChange={(e) => setBoardPath(e.target.value)} placeholder="folder containing src/server.js" />
        </label>
        <button className="btn" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => void window.api.dialog.pickDirectory().then((d) => d && setBoardPath(d))}>
          Browse for board folder…
        </button>

            </section>

            <section className="settings-card" id="settings-image">
              <div className="settings-card-headline">
                <div>
                  <span className="settings-section">Image generation</span>
                  <h3>Visual tool backend</h3>
                </div>
              </div>
        <label>
          Provider
          <select value={imgProvider} onChange={(e) => onProviderChange(e.target.value as ImageProvider)}>
            <option value="a1111">Automatic1111 / Forge (local Stable Diffusion)</option>
            <option value="comfyui">ComfyUI (local)</option>
            <option value="openai">OpenAI-compatible (gpt-image-1 / DALL·E / any /v1)</option>
            <option value="gemini">Google Gemini / Imagen (cloud)</option>
          </select>
        </label>
        <label>
          Image base URL
          <input value={imgBaseURL} onChange={(e) => setImgBaseURL(e.target.value)} placeholder={PROVIDER_DEFAULTS[imgProvider]} />
        </label>
        {imgProvider === 'openai' && (
          <label>
            API key (cloud only)
            <input type="password" value={imgApiKey} onChange={(e) => setImgApiKey(e.target.value)} placeholder="sk-…" />
          </label>
        )}
        <label>
          {imgProvider === 'openai' ? 'Model (e.g. gpt-image-1)' : 'Checkpoint / model (blank = server default)'}
          <input value={imgModel} onChange={(e) => setImgModel(e.target.value)} placeholder={imgProvider === 'openai' ? 'gpt-image-1' : ''} />
        </label>
        <div className="settings-row">
          <label>
            Default size
            <input value={imgSize} onChange={(e) => setImgSize(e.target.value)} placeholder="1024x1024" />
          </label>
          {imgProvider !== 'openai' && (
            <label>
              Steps
              <input value={imgSteps} onChange={(e) => setImgSteps(e.target.value)} placeholder="28" />
            </label>
          )}
        </div>

            </section>

            <section className="settings-card" id="settings-tools">
              <div className="settings-card-headline">
                <div>
                  <span className="settings-section">MCP servers</span>
                  <h3>External tools</h3>
                </div>
                <button className="btn conn-add" onClick={addMcp}>
                  + Add MCP server
                </button>
              </div>
        <p className="settings-hint">
          Connect external Model Context Protocol servers — their tools become available to the model, namespaced{' '}
          <code>label__tool</code>. Point one at the local ticket board over HTTP, or run any stdio server via npx.
          External MCP tools always ask for approval before running.
        </p>
        {mcpServers.map((s) => {
          const st = mcpStatus.find((x) => x.id === s.id)
          return (
            <div className="conn-card" key={s.id}>
              <div className="conn-card-head">
                <label className="settings-check conn-active">
                  <input type="checkbox" checked={s.enabled} onChange={(e) => patchMcp(s.id, { enabled: e.target.checked })} />
                  Enabled
                </label>
                <input
                  className="conn-label"
                  value={s.label}
                  onChange={(e) => patchMcp(s.id, { label: e.target.value })}
                  placeholder="label (tool prefix)"
                  aria-label="MCP server label"
                />
                <button className="icon-btn conn-remove" onClick={() => removeMcp(s.id)} aria-label="Remove MCP server" title="Remove MCP server">
                  ✕
                </button>
              </div>
              <div className="settings-row">
                <label>
                  Transport
                  <select value={s.transport} onChange={(e) => patchMcp(s.id, { transport: e.target.value as MCPTransport })}>
                    <option value="http">Streamable HTTP</option>
                    <option value="stdio">stdio (local process)</option>
                  </select>
                </label>
                {st && (
                  <span className={`settings-hint mcp-status mcp-${st.status}`}>
                    {st.status === 'connected' ? `● connected — ${st.toolCount} tool(s)` : `● ${st.error ?? 'error'}`}
                  </span>
                )}
              </div>
              {s.transport === 'http' ? (
                <label>
                  URL
                  <input value={s.url ?? ''} onChange={(e) => patchMcp(s.id, { url: e.target.value })} placeholder="http://127.0.0.1:8930/mcp" />
                </label>
              ) : (
                <>
                  <label>
                    Command
                    <input value={s.command ?? ''} onChange={(e) => patchMcp(s.id, { command: e.target.value })} placeholder="npx" />
                  </label>
                  <label>
                    Arguments (one per line)
                    <textarea
                      value={mcpArgsText[s.id] ?? ''}
                      onChange={(e) => setMcpArgsText((t) => ({ ...t, [s.id]: e.target.value }))}
                      rows={3}
                      placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\path with spaces'}
                    />
                  </label>
                  <label>
                    Environment (KEY=VALUE per line)
                    <textarea
                      value={mcpEnvText[s.id] ?? ''}
                      onChange={(e) => setMcpEnvText((t) => ({ ...t, [s.id]: e.target.value }))}
                      rows={2}
                      placeholder="API_TOKEN=…"
                    />
                  </label>
                </>
              )}
            </div>
          )
        })}
            </section>

        {VOICE_FEATURE_ENABLED && (
            <section className="settings-card" id="settings-voice">
              <div className="settings-card-headline">
                <div>
                  <span className="settings-section">Voice</span>
                  <h3>Speech in / out</h3>
                </div>
              </div>
        <label className="settings-check">
          <input type="checkbox" checked={voiceEnabled} onChange={(e) => setVoiceEnabled(e.target.checked)} />
          Enable voice mode — hold the orb to talk; replies are spoken back
        </label>
        <p className="settings-hint">
          Needs the local voice sidecar running (faster-whisper + Kokoro). Start it with{' '}
          <code>voice-sidecar/run.ps1</code>.
        </p>
        <label>
          Voice sidecar URL
          <input value={voiceURL} onChange={(e) => setVoiceURL(e.target.value)} placeholder="http://127.0.0.1:8123" />
        </label>
        <label>
          Voice
          <select value={voiceName} onChange={(e) => setVoiceName(e.target.value)}>
            <option value="bm_george">George — British male (default)</option>
            <option value="bm_lewis">Lewis — British male</option>
            <option value="bf_emma">Emma — British female</option>
            <option value="am_michael">Michael — American male</option>
            <option value="am_adam">Adam — American male</option>
            <option value="af_heart">Heart — American female</option>
          </select>
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={voiceSpeak} onChange={(e) => setVoiceSpeak(e.target.checked)} />
          Speak replies aloud as they stream
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={voiceAutoSend} onChange={(e) => setVoiceAutoSend(e.target.checked)} />
          Send automatically after a push-to-talk transcription
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={voiceWake} onChange={(e) => setVoiceWake(e.target.checked)} />
          Hands-free — listen for “Hey Jarvis” (mic stays on; spoken commands always send)
        </label>
            </section>
        )}

          </div>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn approve" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function clampNum(s: string, lo: number, hi: number, fallback: number): number {
  if (s.trim() === '') return fallback
  const n = Number(s)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

function envToText(env?: Record<string, string>): string {
  return env
    ? Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
    : ''
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  return out
}

// One argument per line, so an argument may contain spaces (e.g. a Windows path).
function parseArgs(text: string): string[] {
  return text
    .split('\n')
    .map((a) => a.trim())
    .filter(Boolean)
}

// Mirror of translate.sanitizeLabel — the prefix two servers would collide on.
function mcpPrefix(label: string): string {
  return (
    label
      .trim()
      .replace(/[^a-zA-Z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'mcp'
  )
}
