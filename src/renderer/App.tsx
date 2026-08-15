import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { AgentMode, ComposerSessionState, Session, SessionMeta, Settings, Theme, Verbosity } from '../shared/domain-types'
import { activeConnection } from '../shared/domain-types'
import type { AgentEvent, ApprovalDecision, BgTask, ConnectionStatus, RewindPlanSummary } from '../shared/ipc-types'
import { chatReducer, deriveItems, initialChatState, initialSessionChats, type ToolItem, type UIItem } from './store'
import { useResizable } from './hooks/useResizable'
import { MODE_META, MODE_ORDER } from './modeMeta'
import type { ChatEffort } from './components/EffortSelector'
import { Sidebar } from './components/Sidebar'
import { LoopsRail } from './components/LoopsRail'
import { TopBar } from './components/TopBar'
import { LoopView } from './components/LoopView'
import { HermesView } from './components/HermesView'
import type { AppView } from './components/AppViewTabs'
import { ToolCallCard } from './components/ToolCallCard'
import { ToolTurnGroup, isQuietActivityGroup } from './components/ToolTurnGroup'
import { SettingsModal } from './components/SettingsModal'
import { Markdown } from './components/Markdown'
import { CollapsibleText } from './components/CollapsibleText'
import { CopyButton } from './components/CopyButton'
import { Icon } from './components/Icon'
import { Composer, type SlashCommand } from './components/Composer'
import type { PetState } from './components/BasenjiPet'
import { useVoice, type VoiceApi } from './voice/useVoice'
import type { OrbState } from './components/VoiceOrb'
import { CommandPalette, type PaletteItem } from './components/CommandPalette'
import { RightDock, type DockTab } from './components/RightDock'
import type { AttentionItem } from './components/NeedsMePanel'
import type { PreviewTarget } from './components/PreviewPanel'
import { TodoList } from './components/TodoList'
import { Toaster } from './components/Toaster'
import { BrandMark } from './components/BrandMark'
import { toast } from './toast'
import thinkingArt from './assets/basenji/thinking-basenji-laptop.png'
import {
  EMPTY_COMPOSER_STATE,
  enqueuePrompt,
  normalizeComposerState,
  promptHistory,
  removeQueuedPrompt,
  takeNextPrompt,
  updateQueuedPrompt
} from './composerState'
import { groupChatItems, isAgentItem } from './chatPresentation'
import { visibleAssistantText } from './chatText'
import { notifyWhenUnfocused, syncAttentionNotifications } from './attentionNotifications'
import { buildFixOnlyThisPrompt } from './diffFix'

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('checking')
  const [models, setModels] = useState<string[]>([])
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [cwd, setCwd] = useState<string | null>(null)
  // The Loop/Hermes work folder is selected independently of which chat happens to be open.
  const [loopCwd, setLoopCwd] = useState('')
  const [mode, setMode] = useState<AgentMode>('ask')
  const [appView, setAppView] = useState<AppView>('chat')
  const [loopProject, setLoopProject] = useState('demo')
  const [composerBySession, setComposerBySession] = useState<Record<string, ComposerSessionState>>({})
  const [showSettings, setShowSettings] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth <= 1050)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [dock, setDock] = useState<DockTab | null>(null)
  // Resizable: the right dock (Review / Preview / Tasks) width is user-draggable + persisted.
  const appRef = useRef<HTMLDivElement>(null)
  const dockW = useResizable({ axis: 'x', initial: 430, min: 300, reserve: 540, invert: true, storageKey: 'nc.dock.w', containerRef: appRef })
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | undefined>(undefined)
  const [bgTasks, setBgTasks] = useState<BgTask[]>([])
  const [effectiveContextLimit, setEffectiveContextLimit] = useState<number | null>(null)
  const [dismissedAttentionIds, setDismissedAttentionIds] = useState<Set<string>>(() => new Set())
  const notifiedAttentionIds = useRef<Set<string>>(new Set())
  const activeSessionIdRef = useRef<string | null>(null)
  const [petHappy, setPetHappy] = useState(false)
  const prevRunning = useRef(false)

  const [chats, dispatch] = useReducer(chatReducer, initialSessionChats)
  const turnSession = useRef(new Map<string, string>()) // turnId -> sessionId
  const turnBySession = useRef(new Map<string, string>()) // sessionId -> active turnId
  const pendingEvents = useRef(new Map<string, AgentEvent[]>())
  const composerBySessionRef = useRef<Record<string, ComposerSessionState>>({})
  const composerSaveTimers = useRef(new Map<string, number>())
  const drainQueueRef = useRef<(sessionId: string) => void>(() => undefined)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const chatInnerRef = useRef<HTMLDivElement | null>(null)
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  // Coalesce streamed assistant tokens: buffer per turn and flush once per animation frame instead of
  // dispatching (and re-rendering) on every token — the main cause of streaming jank on long replies.
  const deltaBuf = useRef(new Map<string, { sid: string; text: string }>())
  const flushHandle = useRef<number | null>(null)
  // Only auto-scroll while the user is parked at the bottom, so reading scrollback isn't yanked away.
  const stickToBottom = useRef(true)
  const lastScrollTop = useRef(0)
  const followRaf = useRef<number | null>(null)
  const followTimers = useRef<number[]>([])
  // Voice: refs so the (once-attached) agent-event listener and sendText can reach the live hook
  // without re-subscribing or creating a definition cycle.
  const voiceFeedRef = useRef<VoiceApi['feed'] | null>(null)
  const voiceRef = useRef<VoiceApi | null>(null)

  const activeChat = chats[sessionId ?? ''] ?? initialChatState
  activeSessionIdRef.current = sessionId
  const activeComposer = sessionId ? (composerBySession[sessionId] ?? EMPTY_COMPOSER_STATE) : EMPTY_COMPOSER_STATE
  const input = activeComposer.draft
  const images = activeComposer.images
  const editingQueueId = activeComposer.editingQueueId ?? null
  // Latest items, read by stable callbacks (e.g. onRetry) so they don't change identity every token.
  const itemsRef = useRef(activeChat.items)
  itemsRef.current = activeChat.items

  const storeComposer = useCallback((sid: string, next: ComposerSessionState, immediate = false) => {
    composerBySessionRef.current = { ...composerBySessionRef.current, [sid]: next }
    setComposerBySession((prev) => ({ ...prev, [sid]: next }))
    const old = composerSaveTimers.current.get(sid)
    if (old !== undefined) window.clearTimeout(old)
    const save = (): void => {
      composerSaveTimers.current.delete(sid)
      void window.api.sessions.setComposer({ id: sid, composer: composerBySessionRef.current[sid] ?? next })
    }
    if (immediate) save()
    else composerSaveTimers.current.set(sid, window.setTimeout(save, 250))
  }, [])

  const patchComposer = useCallback(
    (sid: string, update: (current: ComposerSessionState) => ComposerSessionState, immediate = false) => {
      const current = composerBySessionRef.current[sid] ?? EMPTY_COMPOSER_STATE
      storeComposer(sid, update(current), immediate)
    },
    [storeComposer]
  )

  const setInput = useCallback(
    (value: string | ((previous: string) => string)) => {
      if (sessionId) {
        patchComposer(sessionId, (current) => ({
          ...current,
          draft: typeof value === 'function' ? value(current.draft) : value
        }))
      }
    },
    [patchComposer, sessionId]
  )

  const setImages = useCallback(
    (value: string[] | ((previous: string[]) => string[])) => {
      if (!sessionId) return
      patchComposer(sessionId, (current) => ({
        ...current,
        images: typeof value === 'function' ? value(current.images) : value
      }))
    },
    [patchComposer, sessionId]
  )

  const flushDeltas = useCallback(() => {
    flushHandle.current = null
    if (deltaBuf.current.size === 0) return
    const buf = deltaBuf.current
    deltaBuf.current = new Map()
    for (const [turnId, { sid, text }] of buf) {
      dispatch({ type: 'event', sessionId: sid, event: { type: 'assistant-delta', turnId, text } })
    }
  }, [])

  const scheduleFlush = useCallback(() => {
    if (flushHandle.current === null) flushHandle.current = requestAnimationFrame(flushDeltas)
  }, [flushDeltas])

  function applySession(sess: Session): void {
    setSessionId(sess.id)
    setCwd(sess.cwd)
    setMode(sess.mode)
    const composer = normalizeComposerState(sess.composer)
    composerBySessionRef.current = { ...composerBySessionRef.current, [sess.id]: composer }
    setComposerBySession((prev) => ({ ...prev, [sess.id]: composer }))
    dispatch({ type: 'reset', sessionId: sess.id, items: deriveItems(sess.messages) })
  }

  async function refreshSessions(): Promise<SessionMeta[]> {
    const list = await window.api.sessions.list()
    setSessions(list)
    return list
  }

  async function switchToCwd(dir: string): Promise<void> {
    const meta = await window.api.sessions.create(dir)
    const sess = await window.api.sessions.load(meta.id)
    if (sess) applySession(sess)
    setSettings(await window.api.settings.set({ lastCwd: dir, lastSessionId: meta.id }))
    await refreshSessions()
  }

  const onWorkingCwdChange = useCallback((dir: string): void => {
    setLoopCwd(dir)
    void window.api.settings.set({ lastCwd: dir }).then(setSettings)
  }, [])
  // Bootstrap.
  useEffect(() => {
    // Register the event listener SYNCHRONOUSLY (not after awaits): if we subscribed inside the async
    // IIFE, a StrictMode/HMR unmount whose cleanup runs before the assignment would call the no-op unsub
    // and leak the real listener. The handler only touches refs/stable callbacks, so attaching it before
    // the settings/session bootstrap completes is safe.
    const unsub = window.api.agent.onEvent((e) => {
      if (e.type === 'session-titled') {
        setSessions((prev) => prev.map((s) => (s.id === e.sessionId ? { ...s, title: e.title } : s)))
        return
      }
      const sid = turnSession.current.get(e.turnId)
      if (!sid) {
        const queued = pendingEvents.current.get(e.turnId) ?? []
        queued.push(e)
        pendingEvents.current.set(e.turnId, queued)
        // Bound the buffer: drop the oldest pending bucket if turns keep failing to register (e.g. a
        // startTurn that errored before returning its id) so events can't accumulate without limit.
        if (pendingEvents.current.size > 50) {
          const oldest = pendingEvents.current.keys().next().value
          if (oldest !== undefined) pendingEvents.current.delete(oldest)
        }
        return
      }
      if (e.type === 'assistant-delta') {
        const cur = deltaBuf.current.get(e.turnId)
        if (cur) cur.text += e.text
        else deltaBuf.current.set(e.turnId, { sid, text: e.text })
        scheduleFlush()
        voiceFeedRef.current?.(sid, e)
        return
      }
      // Any non-delta event must see buffered text first, so ordering is preserved.
      flushDeltas()
      dispatch({ type: 'event', sessionId: sid, event: e })
      voiceFeedRef.current?.(sid, e)
      if (e.type === 'turn-done') {
        turnSession.current.delete(e.turnId)
        if (turnBySession.current.get(sid) === e.turnId) turnBySession.current.delete(sid)
        void refreshSessions()
        // A queued prompt is deliberately promoted only after the previous turn is complete, so its
        // text remains outside model context while waiting.
        window.setTimeout(() => drainQueueRef.current(sid), 0)
      }
    })
    void (async () => {
      const s = await window.api.settings.get()
      setSettings(s)
      setCwd(s.lastCwd)
      setMode(s.mode)
      await refreshSessions()
      if (s.lastSessionId) {
        const sess = await window.api.sessions.load(s.lastSessionId)
        if (sess) applySession(sess)
      }
    })()
    return () => {
      unsub()
      if (flushHandle.current !== null) cancelAnimationFrame(flushHandle.current)
      for (const [sid, timer] of composerSaveTimers.current) {
        window.clearTimeout(timer)
        const composer = composerBySessionRef.current[sid]
        if (composer) void window.api.sessions.setComposer({ id: sid, composer })
      }
      composerSaveTimers.current.clear()
    }
  }, [flushDeltas, scheduleFlush])

  // Apply theme + match the native title-bar overlay to it.
  useEffect(() => {
    if (!settings) return
    document.documentElement.dataset.theme = settings.theme
    const colors =
      settings.theme === 'light'
        ? { color: '#f3f1ee', symbolColor: '#3a3a3a' }
        : { color: '#1b1b1d', symbolColor: '#9b9ba3' }
    void window.api.ui.setTitleBarOverlay(colors)
  }, [settings?.theme])

  // The connection the main chat talks to (multi-backend: LM Studio / Ollama / OpenAI / Anthropic / …).
  const activeConn = useMemo(() => (settings ? activeConnection(settings) : null), [settings])

  // Poll the active backend's reachability + model list.
  useEffect(() => {
    if (!activeConn) return
    let active = true
    setStatus('checking')
    const run = async (): Promise<void> => {
      const r = await window.api.lmstudio.probe({
        baseURL: activeConn.baseURL,
        apiKey: activeConn.apiKey,
        kind: activeConn.kind
      })
      if (!active) return
      setStatus(r.status)
      setModels(r.models)
    }
    void run()
    const t = setInterval(() => void run(), 5000)
    return () => {
      active = false
      clearInterval(t)
    }
  }, [activeConn?.baseURL, activeConn?.apiKey])

  // Background tasks: initial list + live updates.
  useEffect(() => {
    void window.api.bgtasks.list().then(setBgTasks)
    const unsub = window.api.bgtasks.onEvent(setBgTasks)
    return () => unsub()
  }, [])

  // The context window a turn will really use — the setting trimmed to the model's loaded length. Pulled
  // on mount because the startup refresh can complete before this window exists, then kept live.
  useEffect(() => {
    void window.api.lmstudio.contextLimit().then(setEffectiveContextLimit)
    const unsub = window.api.lmstudio.onContextLimit(setEffectiveContextLimit)
    return () => unsub()
  }, [])

  // The agent's preview tools ask (via main) to open/navigate the Preview panel.
  useEffect(() => {
    const unsub = window.api.preview.onControl((c) => {
      setDock('preview')
      if (c.action === 'open' && c.url) setPreviewTarget({ url: c.url, nonce: c.nonce })
    })
    return () => unsub()
  }, [])

  const clearFollowTimers = useCallback(() => {
    if (followRaf.current !== null) {
      cancelAnimationFrame(followRaf.current)
      followRaf.current = null
    }
    for (const timer of followTimers.current) window.clearTimeout(timer)
    followTimers.current = []
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    lastScrollTop.current = el.scrollTop
    setAwayFromBottom(false)
  }, [])

  const scheduleFollowBottom = useCallback(() => {
    if (!stickToBottom.current) return
    clearFollowTimers()
    followRaf.current = requestAnimationFrame(() => {
      followRaf.current = null
      if (!stickToBottom.current) return
      scrollToBottom()
      requestAnimationFrame(() => {
        if (stickToBottom.current) scrollToBottom()
      })
    })
    followTimers.current = [80, 220].map((ms) =>
      window.setTimeout(() => {
        if (stickToBottom.current) scrollToBottom()
      }, ms)
    )
  }, [clearFollowTimers, scrollToBottom])

  useEffect(() => clearFollowTimers, [clearFollowTimers])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickToBottom.current) return
    // Defer one frame: streaming flushes via RAF so the DOM height isn't settled yet at
    // effect time. Scrolling to stale scrollHeight lands short → stickToBottom flips false → stuck.
    const raf = requestAnimationFrame(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [activeChat.items])

  useEffect(() => {
    scheduleFollowBottom()
  }, [activeChat.items, activeChat.todos, activeChat.running, activeChat.thinkingProgress, scheduleFollowBottom])

  useEffect(() => {
    const target = chatInnerRef.current
    if (!target || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) scheduleFollowBottom()
    })
    observer.observe(target)
    return () => observer.disconnect()
  }, [scheduleFollowBottom])

  const scrollToLatest = useCallback(() => {
    stickToBottom.current = true
    scheduleFollowBottom()
  }, [scheduleFollowBottom])

  const onChatScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distance < 96
    const movedUp = el.scrollTop < lastScrollTop.current - 2
    lastScrollTop.current = el.scrollTop
    if (atBottom) {
      stickToBottom.current = true
      setAwayFromBottom(false)
      return
    }
    if (movedUp) {
      stickToBottom.current = false
      setAwayFromBottom(true)
      return
    }
    if (stickToBottom.current) {
      setAwayFromBottom(false)
      scheduleFollowBottom()
    } else {
      setAwayFromBottom(true)
    }
  }, [scheduleFollowBottom])

  // On session switch, start pinned to the latest message (don't inherit the previous chat's scroll).
  useEffect(() => {
    scrollToLatest()
  }, [scrollToLatest, sessionId])

  const onPickDir = useCallback(async () => {
    const dir = await window.api.dialog.pickDirectory()
    if (dir) {
      await switchToCwd(dir)
      toast.info(`Opened ${basename(dir)}`)
    }
  }, [])

  const onNewSession = useCallback(async () => {
    if (cwd) await switchToCwd(cwd)
    else await onPickDir()
  }, [cwd, onPickDir])

  const onSelectSession = useCallback(async (id: string) => {
    const sess = await window.api.sessions.load(id)
    if (!sess) return
    applySession(sess)
    setSettings(await window.api.settings.set({ lastSessionId: id, lastCwd: sess.cwd }))
  }, [])

  const onDeleteSession = useCallback(
    async (id: string) => {
      await window.api.sessions.remove(id)
      const list = await refreshSessions()
      if (id === sessionId) {
        if (list.length) {
          const sess = await window.api.sessions.load(list[0].id)
          if (sess) {
            applySession(sess)
            setSettings(await window.api.settings.set({ lastSessionId: list[0].id, lastCwd: sess.cwd }))
          }
        } else {
          setSessionId(null)
          setCwd(null)
          setSettings(await window.api.settings.set({ lastSessionId: null }))
        }
      }
    },
    [sessionId]
  )

  // Model picker writes to the ACTIVE connection (not the legacy flat field).
  const onChangeModel = useCallback(
    async (model: string) => {
      if (!settings) return
      const connections = settings.connections.map((c) =>
        c.id === settings.activeConnectionId ? { ...c, model } : c
      )
      setSettings(await window.api.settings.set({ connections }))
    },
    [settings]
  )

  const onChangeConnection = useCallback(async (id: string) => {
    setSettings(await window.api.settings.set({ activeConnectionId: id }))
  }, [])

  const onChangeMode = useCallback(
    async (m: AgentMode) => {
      setMode(m)
      setSettings(await window.api.settings.set({ mode: m }))
      if (sessionId) await window.api.agent.setMode({ sessionId, mode: m })
    },
    [sessionId]
  )

  // Per-chat reasoning-effort dial (frontier-CLI convention: lives under the chatbox, not in
  // Settings). '' = connection/profile default. Kept per session in renderer state only.
  const [effortBySession, setEffortBySession] = useState<Record<string, ChatEffort>>({})
  const chatEffort: ChatEffort = (sessionId && effortBySession[sessionId]) || ''
  const onChangeEffort = useCallback(
    async (v: ChatEffort) => {
      if (!sessionId) return
      setEffortBySession((prev) => ({ ...prev, [sessionId]: v }))
      await window.api.agent.setEffort({ sessionId, effort: v === '' ? null : v })
    },
    [sessionId]
  )

  const onToggleTheme = useCallback(async () => {
    const next: Theme = settings?.theme === 'light' ? 'dark' : 'light'
    setSettings(await window.api.settings.set({ theme: next }))
  }, [settings?.theme])

  const onToggleVerbosity = useCallback(async () => {
    const next: Verbosity = settings?.verbosity === 'verbose' ? 'compact' : 'verbose'
    setSettings(await window.api.settings.set({ verbosity: next }))
    toast.info(next === 'verbose' ? 'Verbose — showing full tool output' : 'Compact — tool summaries')
  }, [settings?.verbosity])

  const sendText = useCallback(
    async (text: string, imgs: string[] = [], targetSessionId?: string) => {
      const t = text.trim()
      const sid = targetSessionId ?? sessionId
      if ((!t && imgs.length === 0) || !sid) return
      voiceRef.current?.stopSpeaking() // a fresh message cuts off any reply still being spoken
      dispatch({ type: 'addUser', sessionId: sid, text: t, images: imgs.length ? imgs : undefined })
      try {
        const { turnId } = await window.api.agent.startTurn({
          sessionId: sid,
          userText: t,
          images: imgs.length ? imgs : undefined
        })
        turnSession.current.set(turnId, sid)
        turnBySession.current.set(sid, turnId)
        // The turn id exists only now — stamp it onto the just-added user item so rewind works live.
        dispatch({ type: 'stampUserTurn', sessionId: sid, turnId })
        const queued = pendingEvents.current.get(turnId)
        if (queued) {
          pendingEvents.current.delete(turnId)
          for (const event of queued) {
            dispatch({ type: 'event', sessionId: sid, event })
            if (event.type === 'turn-done') {
              turnSession.current.delete(turnId)
              if (turnBySession.current.get(sid) === turnId) turnBySession.current.delete(sid)
              void refreshSessions()
              window.setTimeout(() => drainQueueRef.current(sid), 0)
            }
          }
        }
      } catch (e) {
        dispatch({
          type: 'event',
          sessionId: sid,
          event: { type: 'turn-done', turnId: '', stopReason: 'error', error: e instanceof Error ? e.message : String(e) }
        })
      }
    },
    [sessionId]
  )

  const onSend = useCallback(() => {
    const t = input.trim()
    if ((!t && images.length === 0) || !sessionId) return
    if (editingQueueId) {
      storeComposer(sessionId, updateQueuedPrompt(activeComposer, editingQueueId, t, images), true)
      return
    }
    if (activeChat.running) {
      storeComposer(sessionId, enqueuePrompt(activeComposer, t, images), true)
      toast.info('Message queued')
      return
    }
    storeComposer(sessionId, { ...activeComposer, draft: '', images: [] }, true)
    void sendText(t, images)
  }, [activeChat.running, activeComposer, editingQueueId, images, input, sendText, sessionId, storeComposer])

  const onFixDiffSelection = useCallback(
    (path: string, selection: string) => {
      if (!sessionId || !selection.trim()) return
      const prompt = buildFixOnlyThisPrompt(path, selection)
      setAppView('chat')
      if (activeChat.running) {
        const queued = enqueuePrompt(activeComposer, prompt)
        // A context action must not destroy a draft the user was already composing.
        storeComposer(
          sessionId,
          {
            ...queued,
            draft: activeComposer.draft,
            images: activeComposer.images,
            editingQueueId: activeComposer.editingQueueId
          },
          true
        )
        toast.info('Selected fix queued')
        return
      }
      void sendText(prompt)
    },
    [activeChat.running, activeComposer, sendText, sessionId, storeComposer]
  )

  const onSteer = useCallback(() => {
    const t = input.trim()
    if (!t || images.length > 0 || !sessionId || !activeChat.running || editingQueueId) return
    storeComposer(sessionId, { ...activeComposer, draft: '', images: [] }, true)
    void sendText(t)
  }, [activeChat.running, activeComposer, editingQueueId, images.length, input, sendText, sessionId, storeComposer])

  const onEditQueue = useCallback(
    (id: string) => {
      if (!sessionId) return
      const entry = activeComposer.queue.find((item) => item.id === id)
      if (!entry) return
      storeComposer(sessionId, {
        ...activeComposer,
        draft: entry.text,
        images: [...(entry.images ?? [])],
        editingQueueId: id
      })
    },
    [activeComposer, sessionId, storeComposer]
  )

  const onRemoveQueue = useCallback(
    (id: string) => {
      if (!sessionId) return
      storeComposer(sessionId, removeQueuedPrompt(activeComposer, id), true)
    },
    [activeComposer, editingQueueId, sessionId, storeComposer]
  )

  const onPromoteQueue = useCallback(
    (id: string) => {
      if (!sessionId) return
      const entry = activeComposer.queue.find((item) => item.id === id)
      if (!entry) return
      // While a task runs, promoting a TEXT prompt steers it immediately (same mechanic as
      // Ctrl+Enter). Steering can't carry images, so image entries still wait for the next turn.
      if (activeChat.running && entry.images?.length) return
      storeComposer(sessionId, removeQueuedPrompt(activeComposer, id), true)
      void sendText(entry.text, entry.images ?? [])
    },
    [activeChat.running, activeComposer, editingQueueId, sendText, sessionId, storeComposer]
  )

  drainQueueRef.current = (sid: string): void => {
    if (turnBySession.current.has(sid)) return
    const current = composerBySessionRef.current[sid] ?? EMPTY_COMPOSER_STATE
    const next = takeNextPrompt(current)
    if (!next.prompt) return
    storeComposer(sid, next.state, true)
    void sendText(next.prompt.text, next.prompt.images ?? [], sid)
  }

  // Plan → Act: flip out of read-only Plan mode into Accept-edits and tell the agent to carry out the
  // plan it just laid out. The plan is already in the transcript, so a fresh turn executes it.
  const onAct = useCallback(async () => {
    if (!sessionId) return
    setMode('acceptEdits')
    await window.api.agent.setMode({ sessionId, mode: 'acceptEdits' })
    void sendText(
      'Proceed with the plan you just outlined — implement it step by step using your tools: make the edits, run what is needed, and verify. If a detail is ambiguous, make a reasonable choice and keep going.'
    )
  }, [sessionId, sendText])

  // Voice transcript → send immediately (push-to-talk auto-send, or any hands-free command) or
  // just fill the composer.
  const onTranscript = useCallback(
    (text: string, o?: { forceSend?: boolean }) => {
      if (o?.forceSend || settings?.voice.autoSend) void sendText(text)
      else setInput((prev) => (prev ? `${prev} ${text}` : text))
    },
    [settings?.voice.autoSend, sendText, setInput]
  )
  const voice = useVoice({ settings, activeSessionId: sessionId, onTranscript })
  // Kept in refs so the once-attached event listener (TTS) and sendText (barge-in) reach the live hook.
  voiceRef.current = voice
  voiceFeedRef.current = voice.feed

  const onRetry = useCallback(() => {
    const items = itemsRef.current
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.kind === 'user') {
        void sendText(it.text, it.images ?? [])
        return
      }
    }
  }, [sendText])

  const onEditUser = useCallback((text: string) => setInput(text), [setInput])

  const onUndo = useCallback(
    (turnId: string) => {
      if (!sessionId) return
      void window.api.agent.undoTurn({ sessionId, turnId }).then((r) => {
        const restored = r?.restored ?? 0
        const total = r?.total ?? restored
        if (total > 0 && restored < total) {
          // Don't mark it done — the snapshot is kept so the user can retry the remaining files.
          toast.error(`Reverted ${restored} of ${total} file${total === 1 ? '' : 's'} — ${total - restored} could not be restored.`)
        } else {
          dispatch({ type: 'markUndone', sessionId, turnId })
          if (restored > 0) toast.success(`Reverted ${restored} file${restored === 1 ? '' : 's'}.`)
        }
      })
    },
    [sessionId]
  )

  // W5c conversation rewind: hover action on a user message → plan (confirm dialog) → execute.
  const [rewindReq, setRewindReq] = useState<{ turnId: string; plan: RewindPlanSummary } | null>(null)

  const onRewindRequest = useCallback(
    (turnId: string) => {
      if (!sessionId) return
      if (activeChat.running) {
        toast.error('Stop the running turn before rewinding.')
        return
      }
      void window.api.agent.rewindPlan({ sessionId, turnId }).then((plan) => {
        if (!plan) toast.error('This message cannot be rewound (it predates rewind support).')
        else setRewindReq({ turnId, plan })
      })
    },
    [sessionId, activeChat.running]
  )

  const onRewindConfirm = useCallback(() => {
    const req = rewindReq
    setRewindReq(null)
    if (!sessionId || !req) return
    void window.api.agent.rewindExecute({ sessionId, turnId: req.turnId }).then((r) => {
      if (!r.ok) {
        toast.error(r.error ?? 'Rewind failed.')
        return
      }
      if (r.messages) dispatch({ type: 'reset', sessionId, items: deriveItems(r.messages) })
      if (r.composerText) setInput(r.composerText)
      const failed = r.failed ?? 0
      const restored = r.restored ?? 0
      if (failed > 0) toast.error(`Rewound, but ${failed} file${failed === 1 ? '' : 's'} could not be restored (snapshots kept).`)
      else if ((r.binarySkipped?.length ?? 0) > 0) toast.info(`Rewound. ${r.binarySkipped!.length} binary file(s) were left untouched.`)
      else toast.success(restored > 0 ? `Rewound — ${restored} file${restored === 1 ? '' : 's'} restored.` : 'Rewound.')
      void refreshSessions()
    })
  }, [rewindReq, sessionId, setInput])

  const onStop = useCallback(() => {
    const tid = sessionId ? turnBySession.current.get(sessionId) : undefined
    if (tid) void window.api.agent.cancel(tid)
  }, [sessionId, setInput])

  const onDecide = useCallback(
    (callId: string, decision: ApprovalDecision, note?: string) => {
      const tid = sessionId ? turnBySession.current.get(sessionId) : undefined
      if (tid) void window.api.agent.decide({ turnId: tid, callId, decision, note })
    },
    [sessionId]
  )

  const onSaveSettings = useCallback((patch: Partial<Settings>) => {
    void window.api.settings.set(patch).then((s) => {
      setSettings(s)
      toast.success('Settings saved')
    })
  }, [])

  const onAddFiles = useCallback(async () => {
    if (!sessionId) return
    const files = await window.api.dialog.pickFiles({ sessionId })
    if (files.length) {
      setInput((prev) => `${prev ? `${prev} ` : ''}${files.map((f) => `@${f}`).join(' ')} `)
    }
  }, [sessionId])

  const toggleDock = useCallback((t: DockTab) => setDock((d) => (d === t ? null : t)), [])

  // A sidebar + dock + mascot can otherwise leave less than half the window for the actual work.
  // Preserve the dock, but yield the navigation rail automatically on ordinary laptop widths.
  useEffect(() => {
    if (dock && window.innerWidth < 1500) setSidebarCollapsed(true)
  }, [dock])

  useEffect(() => {
    let wasCompact = window.innerWidth <= 1050
    const onResize = (): void => {
      const compact = window.innerWidth <= 1050
      if (compact && !wasCompact) setSidebarCollapsed(true)
      wasCompact = compact
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return
      const k = e.key.toLowerCase()
      if (k === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      } else if (k === 'b') {
        e.preventDefault()
        setSidebarCollapsed((v) => !v)
      } else if (k === 'n') {
        e.preventDefault()
        void onNewSession()
      } else if (k === 'o') {
        e.preventDefault()
        void onToggleVerbosity()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onNewSession, onToggleVerbosity])

  const slashCommands: SlashCommand[] = useMemo(
    () => [
      { name: 'ask', desc: 'Approve each change', run: () => void onChangeMode('ask') },
      { name: 'accept', desc: 'Auto-apply edits, ask for commands', run: () => void onChangeMode('acceptEdits') },
      { name: 'auto', desc: 'Run everything without asking', run: () => void onChangeMode('auto') },
      { name: 'plan', desc: 'Read-only planning', run: () => void onChangeMode('plan') },
      { name: 'new', desc: 'Start a new chat', run: () => void onNewSession() },
      { name: 'theme', desc: 'Toggle light / dark', run: () => void onToggleTheme() },
      { name: 'verbose', desc: 'Toggle compact / verbose transcript', run: () => void onToggleVerbosity() },
      { name: 'settings', desc: 'Open settings', run: () => setShowSettings(true) },
      {
        name: 'clear-approvals',
        desc: 'Forget "always allow" for this chat',
        run: () => {
          if (sessionId) void window.api.agent.clearApprovals(sessionId)
        }
      }
    ],
    [onChangeMode, onNewSession, onToggleTheme, onToggleVerbosity, sessionId]
  )

  const paletteItems: PaletteItem[] = useMemo(() => {
    const actions: PaletteItem[] = [
      { label: 'New chat', hint: 'Ctrl+N', run: () => void onNewSession() },
      { label: `Switch to ${settings?.theme === 'light' ? 'dark' : 'light'} mode`, run: () => void onToggleTheme() },
      {
        label: `Transcript: switch to ${settings?.verbosity === 'verbose' ? 'compact' : 'verbose'} view`,
        hint: 'Ctrl+O',
        run: () => void onToggleVerbosity()
      },
      { label: 'Open settings', run: () => setShowSettings(true) },
      { label: 'Toggle sidebar', hint: 'Ctrl+B', run: () => setSidebarCollapsed((v) => !v) },
      { label: 'Choose working folder…', run: () => void onPickDir() },
      { label: 'Panel: Needs Me', run: () => setDock('needs') },
      { label: 'Panel: Review (changed files)', run: () => setDock('git') },
      { label: 'Panel: Response (saved replies)', run: () => setDock('plan') },
      { label: 'Panel: Preview', run: () => setDock('preview') },
      { label: 'Panel: Background Tasks', run: () => setDock('tasks') },
      {
        label: 'Clear approvals (this chat)',
        run: () => {
          if (sessionId) void window.api.agent.clearApprovals(sessionId)
        }
      },
      ...MODE_ORDER.map((m) => ({ label: `Mode: ${MODE_META[m].label}`, hint: MODE_META[m].desc, run: () => void onChangeMode(m) }))
    ]
    const sess: PaletteItem[] = sessions.map((s) => ({
      label: `Chat: ${s.title || 'Untitled'}`,
      hint: basename(s.cwd),
      run: () => void onSelectSession(s.id)
    }))
    return [...actions, ...sess]
  }, [sessions, settings?.theme, settings?.verbosity, sessionId, onNewSession, onToggleTheme, onToggleVerbosity, onPickDir, onChangeMode, onSelectSession])

  const estimatedTokens = useMemo(() => {
    let chars = 0
    for (const it of activeChat.items) {
      if (it.kind === 'tool') chars += it.argsText.length + (it.result?.length ?? 0)
      else if (it.kind === 'undo') continue
      else chars += it.text.length
      // Attached images cost ~1500 tokens each (vision models tile by resolution, not data-URL length) —
      // mirror the main-process estimate so the pre-first-reply context gauge isn't wildly low.
      if (it.kind === 'user' && it.images) chars += it.images.length * 1500 * 4
    }
    return Math.ceil(chars / 4)
  }, [activeChat.items])

  // Prefer LM Studio's real usage; fall back to the chars/4 estimate before the first reply.
  const tokensUsed = activeChat.tokens?.used ?? estimatedTokens
  // Prefer the CURRENT effective window over the one recorded on the last reply, so the meter mirrors what
  // shouldCompact() actually compares (last prompt size against the live cap) and a model/connection switch
  // is reflected immediately. The raw setting is the last resort: it can claim a window the model never
  // loaded — 150k configured against 134107 actually loaded — and overstate the headroom.
  const tokenLimit = effectiveContextLimit ?? activeChat.tokens?.limit ?? settings?.contextLimitTokens ?? 32768
  const todoActivitySinceUpdate = useMemo(() => meaningfulActionsSinceTodoUpdate(activeChat.items), [activeChat.items])

  const planText = useMemo(() => {
    for (let i = activeChat.items.length - 1; i >= 0; i--) {
      const it = activeChat.items[i]
      if (it.kind === 'assistant' && it.text.trim()) return it.text
    }
    return ''
  }, [activeChat.items])

  const snapshot = useMemo(() => {
    for (let i = activeChat.items.length - 1; i >= 0; i--) {
      const it = activeChat.items[i]
      if (it.kind === 'undo') return { turnId: it.turnId, count: it.count, undone: it.undone }
    }
    return undefined
  }, [activeChat.items])

  const runningTasks = bgTasks.filter((t) => t.status === 'running').length
  const rawAttentionItems = useMemo<AttentionItem[]>(() => {
    const out: AttentionItem[] = []
    if (status === 'unreachable') {
      out.push({
        id: 'status-unreachable',
        tone: 'error',
        title: 'Backend is offline',
        detail: 'The active connection is not reachable.',
        source: 'Connection',
        notify: true
      })
    } else if (status === 'auth') {
      out.push({
        id: 'status-auth',
        tone: 'warn',
        title: 'Connection needs credentials',
        detail: 'The active backend rejected the current key.',
        source: 'Connection',
        notify: true
      })
    } else if (status === 'no-model') {
      out.push({
        id: 'status-no-model',
        tone: 'warn',
        title: 'No model selected',
        detail: 'Pick a model before starting the next turn.',
        source: 'Model',
        notify: true
      })
    }

    let approvals = 0
    let failures = 0
    let turnErrors = 0
    for (let i = activeChat.items.length - 1; i >= 0; i--) {
      const it = activeChat.items[i]
      if (it.kind === 'tool' && it.status === 'awaiting' && approvals < 3) {
        approvals += 1
        out.push({
          id: `approval-${it.id}`,
          tone: 'warn',
          title: 'Approval waiting',
          detail: toolSubject(it),
          source: it.name,
          notify: true
        })
      } else if (it.kind === 'tool' && it.ok === false && failures < 3) {
        failures += 1
        out.push({
          id: `failure-${it.id}`,
          tone: 'error',
          title: 'Tool failed',
          detail: shortLine(it.result ?? it.name, 132),
          source: it.name
        })
      } else if (it.kind === 'error' && turnErrors < 2) {
        turnErrors += 1
        out.push({
          id: `error-${it.id}`,
          tone: 'error',
          title: 'Turn failed',
          detail: shortLine(it.text, 132),
          source: 'Chat',
          notify: true
        })
      }
    }

    if (snapshot && snapshot.count > 0 && !snapshot.undone) {
      out.push({
        id: `snapshot-${snapshot.turnId}`,
        tone: 'info',
        title: 'Reviewable file changes',
        detail: `${snapshot.count} file${snapshot.count === 1 ? '' : 's'} can still be reverted.`,
        source: 'Review'
      })
    }

    const tokenPct = Math.round((tokensUsed / Math.max(1, tokenLimit)) * 100)
    if (tokenPct >= 85) {
      out.push({
        id: 'context-pressure',
        tone: 'warn',
        title: 'Context is getting full',
        detail: `${tokenPct}% of the current context window is in use.`,
        source: 'Context'
      })
    }

    if (runningTasks > 0) {
      out.push({
        id: 'background-running',
        tone: 'info',
        title: 'Background work running',
        detail: `${runningTasks} task${runningTasks === 1 ? '' : 's'} currently active.`,
        source: 'Tasks'
      })
    }

    return out.slice(0, 10)
  }, [activeChat.items, runningTasks, snapshot, status, tokenLimit, tokensUsed])
  useEffect(() => {
    setDismissedAttentionIds(new Set())
  }, [sessionId])
  useEffect(() => {
    setDismissedAttentionIds((previous) => {
      const liveIds = new Set(rawAttentionItems.map((item) => item.id))
      let changed = false
      const next = new Set<string>()
      for (const id of previous) {
        if (liveIds.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : previous
    })
  }, [rawAttentionItems])
  const attentionItems = useMemo(
    () => rawAttentionItems.filter((item) => !dismissedAttentionIds.has(item.id)),
    [dismissedAttentionIds, rawAttentionItems]
  )
  useEffect(() => {
    const { fresh, liveIds } = syncAttentionNotifications(attentionItems, notifiedAttentionIds.current)
    notifiedAttentionIds.current = liveIds
    if (fresh.length === 0) return

    const primary = fresh[0]
    const targetSessionId = sessionId
    const more = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''
    notifyWhenUnfocused(primary.title, `${primary.detail}${more}`, () => {
      window.focus()
      setDock('needs')
      if (targetSessionId && activeSessionIdRef.current !== targetSessionId) void onSelectSession(targetSessionId)
    })
  }, [attentionItems, onSelectSession, sessionId])
  const onDismissAttention = useCallback((id: string) => {
    setDismissedAttentionIds((previous) => {
      if (previous.has(id)) return previous
      const next = new Set(previous)
      next.add(id)
      return next
    })
  }, [])
  const attentionCount = attentionItems.length
  const verbose = settings?.verbosity === 'verbose'
  const sentPromptHistory = useMemo(() => promptHistory(activeChat.items), [activeChat.items])
  const currentPromptId = useMemo(() => {
    for (let i = activeChat.items.length - 1; i >= 0; i--) {
      if (activeChat.items[i].kind === 'user') return activeChat.items[i].id
    }
    return undefined
  }, [activeChat.items])

  const last = activeChat.items[activeChat.items.length - 1]
  const thinking =
    activeChat.running && (!last || last.kind === 'user' || (last.kind === 'tool' && last.status === 'done') || last.kind === 'error')

  // The orb shows voice state when active, otherwise borrows the turn's "thinking" state.
  const orbState: OrbState = voice.state !== 'idle' ? voice.state : activeChat.running ? 'thinking' : 'idle'
  const voiceOffline = voice.enabled && voice.sidecar != null && !voice.sidecar.ok

  // The basenji mascot mirrors the agent: idle when stopped, "working" while a tool runs, otherwise
  // "thinking". A just-finished turn earns a brief happy wag (see the effect below).
  const petState: PetState = petHappy
    ? 'happy'
    : !activeChat.running
      ? 'idle'
      : last && last.kind === 'tool' && last.status === 'running'
        ? 'working'
        : 'thinking'
  useEffect(() => {
    const was = prevRunning.current
    prevRunning.current = activeChat.running
    if (was && !activeChat.running && activeChat.items.length) {
      setPetHappy(true)
      const t = window.setTimeout(() => setPetHappy(false), 1800)
      return () => window.clearTimeout(t)
    }
  }, [activeChat.running, activeChat.items.length])

  return (
    <div ref={appRef} className={['app', sidebarCollapsed ? 'sidebar-collapsed' : '', dock ? 'dock-open' : ''].filter(Boolean).join(' ')}>
      {appView !== 'chat' ? (
        <LoopsRail
          project={loopProject}
          theme={settings?.theme ?? 'dark'}
          onSelect={setLoopProject}
          onOpenSettings={() => setShowSettings(true)}
          onToggleTheme={onToggleTheme}
          onCollapse={() => setSidebarCollapsed(true)}
          appView={appView}
          onChangeView={setAppView}
        />
      ) : (
        <Sidebar
          sessions={sessions}
          activeId={sessionId}
          hasWorkspace={Boolean(cwd)}
          theme={settings?.theme ?? 'dark'}
          onSelect={onSelectSession}
          onDelete={onDeleteSession}
          onNew={onNewSession}
          onOpenSettings={() => setShowSettings(true)}
          onToggleTheme={onToggleTheme}
          onCollapse={() => setSidebarCollapsed(true)}
          appView={appView}
          onChangeView={setAppView}
        />
      )}

      <div className="main">
        <TopBar
          cwd={cwd}
          models={models}
          model={activeConn?.model ?? ''}
          connections={settings?.connections ?? []}
          activeConnectionId={settings?.activeConnectionId ?? ''}
          status={status}
          collapsed={sidebarCollapsed}
          tokensUsed={tokensUsed}
          tokenLimit={tokenLimit}
          dock={dock}
          runningTasks={runningTasks}
          attentionCount={attentionCount}
          onToggleDock={toggleDock}
          onExpandSidebar={() => setSidebarCollapsed(false)}
          onPickDir={onPickDir}
          onChangeModel={onChangeModel}
          onChangeConnection={onChangeConnection}
        />

        {/* Chat subtree stays MOUNTED across a Loop toggle (display-hidden, not unmounted) so its reducer state survives. */}
        <div
          id="workspace-panel-chat"
          className="app-chat-region"
          role="tabpanel"
          aria-labelledby="workspace-tab-chat"
          style={appView === 'chat' ? undefined : { display: 'none' }}
        >
        <div className="chat-frame">
          <div className="chat" ref={scrollRef} onScroll={onChatScroll}>
            {(!sessionId || activeChat.items.length === 0) && <div className="welcome-bg" aria-hidden="true" />}
            <div className="chat-inner" ref={chatInnerRef}>
              {!sessionId && (
                <Welcome
                  onPickDir={onPickDir}
                  onOpenSettings={() => setShowSettings(true)}
                  onNewChat={onNewSession}
                  status={status}
                  model={activeConn?.model ?? ''}
                  cwd={cwd}
                />
              )}
              {sessionId && activeChat.items.length === 0 && <EmptyChat mode={mode} />}
              {groupChatItems(activeChat.items).map((seg) => {
                if (seg.type === 'group') {
                  const prevItem = seg.firstIdx > 0 ? activeChat.items[seg.firstIdx - 1] : undefined
                  const quiet = isQuietActivityGroup(seg.tools)
                  return (
                    <div key={seg.tools[0].id} className={`msg tool-row ${isAgentItem(prevItem) ? 'continuation' : ''} ${quiet ? 'quiet-row' : ''}`}>
                      <div className="avatar ghost" />
                      <ToolTurnGroup items={seg.tools} verbose={verbose} onDecide={onDecide} />
                    </div>
                  )
                }
                return (
                  <Item
                    key={seg.item.id}
                    item={seg.item}
                    continuation={isAgentItem(seg.item) && isAgentItem(activeChat.items[seg.idx - 1])}
                    currentPrompt={seg.item.kind === 'user' && seg.item.id === currentPromptId}
                    isLast={seg.idx === activeChat.items.length - 1}
                    verbose={verbose}
                    mode={mode}
                    onDecide={onDecide}
                    onEditUser={onEditUser}
                    onRetry={onRetry}
                    onUndo={onUndo}
                    onRewind={onRewindRequest}
                    onAct={onAct}
                  />
                )
              })}
              {thinking && <Thinking continuation={isAgentItem(last)} progress={activeChat.thinkingProgress} />}
            </div>
          </div>
          {awayFromBottom && sessionId && (
            <button className="chat-jump" type="button" onClick={scrollToLatest}>
              <Icon name="chevron-down" size={14} />
              {activeChat.running ? 'Follow activity' : 'Jump to latest'}
            </button>
          )}
        </div>

        {sessionId && (
          <TodoList
            todos={activeChat.todos ?? []}
            running={activeChat.running}
            activitySinceUpdate={todoActivitySinceUpdate}
          />
        )}

        <Composer
          input={input}
          setInput={setInput}
          images={images}
          setImages={setImages}
          running={activeChat.running}
          disabled={!sessionId}
          mode={mode}
          sessionId={sessionId}
          slashCommands={slashCommands}
          history={sentPromptHistory}
          queue={activeComposer.queue}
          editingQueueId={editingQueueId}
          petState={petState}
          mascotEnabled={settings?.mascotEnabled !== false}
          voice={
            voice.enabled
              ? {
                  orbState,
                  levelRef: voice.levelRef,
                  disabled: !sessionId || voiceOffline,
                  status: voiceOffline ? 'Voice sidecar offline' : undefined,
                  statusWarn: voiceOffline,
                  onPressStart: voice.startPTT,
                  onPressEnd: voice.stopPTT
                }
              : undefined
          }
          onChangeMode={onChangeMode}
          effort={chatEffort}
          onChangeEffort={onChangeEffort}
          onAddFiles={onAddFiles}
          onAddFolder={onPickDir}
          onSend={onSend}
          onSteer={onSteer}
          onStop={onStop}
          onEditQueue={onEditQueue}
          onRemoveQueue={onRemoveQueue}
          onPromoteQueue={onPromoteQueue}
        />
        </div>
        {appView === 'loop' && settings && (
          <LoopView settings={settings} workingCwd={loopCwd || cwd || ''} onWorkingCwdChange={onWorkingCwdChange} recentCwds={[...new Set(sessions.map((s) => s.cwd))]} project={loopProject} onProjectChange={setLoopProject} />
        )}
        {appView === 'hermes' && settings && (
          <HermesView settings={settings} workingCwd={loopCwd || cwd || ''} onWorkingCwdChange={onWorkingCwdChange} recentCwds={[...new Set(sessions.map((s) => s.cwd))]} project={loopProject} />
        )}
      </div>

      {dock && (
        <>
          <div
            className={`resizer-x ${dockW.dragging ? 'dragging' : ''}`}
            onPointerDown={dockW.onPointerDown}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
          />
          <RightDock
            tab={dock}
            onTab={setDock}
            onClose={() => setDock(null)}
            tasks={bgTasks}
            onStopTask={(id) => void window.api.bgtasks.stop(id)}
            sessionId={sessionId}
            planText={planText}
            snapshot={snapshot}
            onUndo={onUndo}
            onFixDiffSelection={onFixDiffSelection}
            previewTarget={previewTarget}
            attentionItems={attentionItems}
            onDismissAttention={onDismissAttention}
            width={dockW.size}
          />
        </>
      )}

      {showSettings && settings && (
        <SettingsModal settings={settings} onClose={() => setShowSettings(false)} onSave={onSaveSettings} />
      )}
      {rewindReq && (
        <RewindConfirm plan={rewindReq.plan} onCancel={() => setRewindReq(null)} onConfirm={onRewindConfirm} />
      )}
      {paletteOpen && <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />}
      <Toaster />
    </div>
  )
}

/** W5c: the rewind confirm — says exactly what will be removed and which files get restored. */
function RewindConfirm({ plan, onCancel, onConfirm }: { plan: RewindPlanSummary; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal rewind-modal" role="dialog" aria-modal="true" aria-label="Rewind conversation" onClick={(e) => e.stopPropagation()}>
        <h2>Rewind to this message?</h2>
        <p className="rewind-summary">
          This removes {plan.turns === 1 ? 'this turn' : `${plan.turns} turns`} from the conversation and puts the
          message back in the composer.
        </p>
        {plan.files.length > 0 && (
          <>
            <p className="rewind-summary">{plan.files.length === 1 ? '1 file' : `${plan.files.length} files`} will be restored:</p>
            <ul className="rewind-files">
              {plan.files.map((f) => (
                <li key={f.path}>
                  <code>{f.path}</code>
                  {f.action === 'delete' && <span className="rewind-del"> (created by a rewound turn — will be deleted)</span>}
                </li>
              ))}
            </ul>
          </>
        )}
        {plan.binarySkipped.length > 0 && (
          <p className="rewind-warn">
            Left untouched (binary, cannot be restored faithfully): {plan.binarySkipped.join(', ')}
          </p>
        )}
        <div className="rewind-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn danger" onClick={onConfirm}>
            Rewind
          </button>
        </div>
      </div>
    </div>
  )
}

const Item = memo(function Item({
  item,
  continuation,
  currentPrompt,
  isLast,
  verbose,
  mode,
  onDecide,
  onEditUser,
  onRetry,
  onUndo,
  onRewind,
  onAct
}: {
  item: UIItem
  continuation?: boolean
  currentPrompt?: boolean
  isLast?: boolean
  verbose?: boolean
  mode?: AgentMode
  onDecide: (callId: string, d: ApprovalDecision, note?: string) => void
  onEditUser: (text: string) => void
  onRetry: () => void
  onUndo: (turnId: string) => void
  onRewind?: (turnId: string) => void
  onAct?: () => void
}) {
  switch (item.kind) {
    case 'user':
      return (
        <div className={`msg user ${currentPrompt ? 'current-prompt' : ''}`}>
          <div className="msg-stack">
            <div className="msg-meta">
              <span className="msg-name">You</span>
            </div>
            {item.images && item.images.length > 0 && (
              <div className="msg-images">
                {item.images.map((src, i) => (
                  <img key={i} src={src} className="msg-image" alt="attachment" />
                ))}
              </div>
            )}
            {item.text.trim() && (
              <div className="bubble">
                <CollapsibleText maxHeight={currentPrompt ? 72 : 142} variant={currentPrompt ? 'prompt' : 'default'}>{item.text}</CollapsibleText>
                <button
                  className="edit-btn"
                  title="Edit & resend"
                  aria-label="Edit and resend"
                  onClick={() => onEditUser(item.text)}
                >
                  <Icon name="pencil" size={12} />
                </button>
                {item.turnId && onRewind && (
                  <button
                    className="edit-btn rewind-btn"
                    title="Rewind to here — remove this turn and everything after, restoring the files it changed"
                    aria-label="Rewind conversation to this message"
                    onClick={() => onRewind(item.turnId!)}
                  >
                    <Icon name="rotate-ccw" size={12} />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )
    case 'assistant':
      {
        const visibleText = visibleAssistantText(item.text)
        if (!visibleText && !item.streaming) return null
        const copyText = visibleText || item.text
        return (
        <div className={`msg assistant ${continuation ? 'continuation' : ''}`}>
          {continuation ? (
            <div className="avatar ghost" />
          ) : (
            <div className="avatar basenji">
              <img src={thinkingArt} className="avatar-img" alt="" draggable={false} />
            </div>
          )}
          <div className="msg-content">
            {!continuation && (
              <div className="msg-meta">
                <span className="msg-name">BasenjiCode</span>
              </div>
            )}
            {visibleText && <Markdown text={visibleText} />}
            {item.streaming && <span className="streaming-mark" aria-label="BasenjiCode is writing" />}
            {!item.streaming && visibleText.trim() && (
              <div className="msg-actions">
                <CopyButton text={copyText} />
                {mode === 'plan' && isLast && onAct && (
                  <button className="mini-btn act-btn" onClick={onAct} title="Switch to Accept-edits and carry out this plan">
                    <Icon name="zap" size={13} /> Act on this plan
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        )
      }
    case 'error':
      return (
        <div className="msg assistant">
          <div className="avatar err">!</div>
          <div className="msg-content">
            <div className="error-box">{item.text}</div>
            <div className="msg-actions">
              <button className="mini-btn" onClick={onRetry}>
                <Icon name="refresh" size={13} /> Retry
              </button>
            </div>
          </div>
        </div>
      )
    case 'notice':
      return (
        <div className="msg notice-row">
          <div className="notice-box">
            {item.text}
            {item.retryable !== false && (
              <>
                {' '}
                <button className="mini-btn" onClick={onRetry}>
                  <Icon name="refresh" size={13} /> Retry
                </button>
              </>
            )}
          </div>
        </div>
      )
    case 'undo':
      return (
        <div className="msg notice-row">
          {item.undone ? (
            <div className="undo-chip done">
              <Icon name="check" size={13} /> Reverted {item.count} file{item.count === 1 ? '' : 's'}
            </div>
          ) : (
            <button className="undo-chip mini-btn" onClick={() => onUndo(item.turnId)}>
              <Icon name="refresh" size={13} /> Undo {item.count} file change{item.count === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )
    case 'tool':
      return (
        <div className={`msg tool-row ${continuation ? 'continuation' : ''}`}>
          <div className="avatar ghost" />
          <ToolCallCard item={item} verbose={verbose} onDecide={onDecide} />
        </div>
      )
    default:
      return null
  }
})

function Thinking({
  continuation,
  progress
}: {
  continuation?: boolean
  progress?: { chars: number; seconds: number }
}) {
  return (
    <div className={`msg assistant ${continuation ? 'continuation' : ''}`}>
      {continuation ? (
        <div className="avatar ghost" />
      ) : (
        <div className="avatar basenji">
          <img src={thinkingArt} className="avatar-img" alt="" draggable={false} />
        </div>
      )}
      <div className="msg-content">
        {!continuation && (
          <div className="msg-meta">
            <span className={`msg-name ${progress ? '' : 'shimmer'}`}>BasenjiCode</span>
          </div>
        )}
        {progress ? (
          <span className="thinking-progress" role="status">
            Thinking… ~{Math.round(progress.chars / 4)} tokens · {progress.seconds} s
          </span>
        ) : (
          <span className="thinking-indicator">
            <img className="thinking-basenji" src={thinkingArt} alt="" draggable={false} />
            <span className="thinking-dots">
              <span />
              <span />
              <span />
            </span>
          </span>
        )}
      </div>
    </div>
  )
}

function Welcome({
  onPickDir,
  onOpenSettings,
  onNewChat,
  status,
  model,
  cwd
}: {
  onPickDir: () => void
  onOpenSettings: () => void
  onNewChat: () => void
  status: ConnectionStatus
  model: string
  cwd: string | null
}) {
  const backendReady = status === 'ok'
  const modelReady = Boolean(model)
  const workspaceReady = Boolean(cwd)
  const readyCount = [backendReady, modelReady, workspaceReady].filter(Boolean).length
  const nextStep = !backendReady ? 'backend' : !modelReady ? 'model' : !workspaceReady ? 'workspace' : 'ready'
  const cta =
    nextStep === 'backend'
      ? { label: 'Open connection settings', icon: 'settings' as const, run: onOpenSettings }
      : nextStep === 'model'
        ? { label: 'Choose a model', icon: 'cpu' as const, run: onOpenSettings }
        : nextStep === 'workspace'
          ? { label: 'Choose working folder', icon: 'folder' as const, run: onPickDir }
          : { label: 'Start a new chat', icon: 'plus' as const, run: onNewChat }
  return (
    <div className="welcome">
      <div className="welcome-shell">
        <div className="welcome-mark">
          <BrandMark size={56} />
        </div>
        <h1>BasenjiCode</h1>
        <p>Local coding workbench for planning, editing, reviewing, and previewing changes.</p>

        <div className="welcome-signal" aria-hidden="true">
          <svg viewBox="0 0 520 170" role="presentation">
            <defs>
              <linearGradient id="welcomeRoute" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity="0.12" />
                <stop offset="48%" stopColor="currentColor" stopOpacity="0.86" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0.18" />
              </linearGradient>
            </defs>
            <path className="welcome-signal-grid" d="M42 35H478M42 86H478M42 137H478M104 20v132M210 20v132M316 20v132M422 20v132" />
            <path className="welcome-signal-glow" d="M56 118C112 59 162 121 224 83s92-79 158-38 72 47 96 16" />
            <path className="welcome-signal-route" d="M56 118C112 59 162 121 224 83s92-79 158-38 72 47 96 16" />
            <circle className={`welcome-signal-node ${backendReady ? 'done' : ''}`} cx="118" cy="83" r="12" />
            <circle className={`welcome-signal-node ${modelReady ? 'done' : ''}`} cx="260" cy="74" r="15" />
            <circle className={`welcome-signal-node ${workspaceReady ? 'done' : ''}`} cx="403" cy="61" r="12" />
            <path className="welcome-signal-check" d="m364 112 21 22 47-56" />
          </svg>
          <span className="welcome-signal-count">{readyCount}/3</span>
        </div>

        <div className="welcome-status-grid" aria-label="Startup readiness">
          <div className={`welcome-status-card ${backendReady ? 'ready' : 'wait'} ${nextStep === 'backend' ? 'current' : ''}`}>
            <Icon name="cpu" size={15} />
            <span>Backend</span>
            <b>{backendReady ? 'Connected' : status === 'checking' ? 'Checking' : status === 'no-model' ? 'Needs model' : 'Needs attention'}</b>
          </div>
          <div className={`welcome-status-card ${modelReady ? 'ready' : 'wait'} ${nextStep === 'model' ? 'current' : ''}`}>
            <Icon name="terminal" size={15} />
            <span>Model</span>
            <b>{modelReady ? model : 'Select model'}</b>
          </div>
          <div className={`welcome-status-card ${workspaceReady ? 'ready' : 'wait'} ${nextStep === 'workspace' ? 'current' : ''}`}>
            <Icon name="folder" size={15} />
            <span>Workspace</span>
            <b>{workspaceReady && cwd ? basename(cwd) : 'Choose folder'}</b>
          </div>
        </div>
        <button className="btn primary welcome-cta" onClick={cta.run}>
          <Icon name={cta.icon} size={14} />
          {cta.label}
        </button>
      </div>
    </div>
  )
}

function EmptyChat({ mode }: { mode: AgentMode }) {
  return (
    <div className="empty-chat">
      <div className="welcome-mark small">
        <BrandMark size={40} />
      </div>
      <div className="empty-orbit" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <p>{mode === 'plan' ? 'Plan mode is on - ask for a plan.' : 'What would you like to work on?'}</p>
    </div>
  )
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function shortLine(text: string, max = 110): string {
  const line = text
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean)
  if (!line) return 'No details available.'
  return line.length > max ? `${line.slice(0, max - 1)}...` : line
}

function toolSubject(item: ToolItem): string {
  if (item.preview?.kind === 'command' && item.preview.text) return shortLine(item.preview.text, 132)
  if (item.preview?.path) return shortLine(item.preview.path, 132)
  return item.name
}

function meaningfulActionsSinceTodoUpdate(items: UIItem[]): number {
  let lastTodoIndex = -1
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind === 'tool' && it.name === 'todo_write') lastTodoIndex = i
  }
  if (lastTodoIndex === -1) return 0
  let count = 0
  for (const it of items.slice(lastTodoIndex + 1)) {
    if (
      it.kind === 'tool' &&
      it.status === 'done' &&
      it.ok !== false &&
      shouldCountForTodoFreshness(it.name)
    ) {
      count++
    }
  }
  return count
}

function shouldCountForTodoFreshness(toolName: string): boolean {
  if (toolName === 'todo_write') return false
  if (toolName.startsWith('preview_')) return false
  return ![
    'read_file',
    'grep',
    'glob',
    'list_dir',
    'web_fetch',
    'web_search',
    'list_background',
    'read_background'
  ].includes(toolName)
}
