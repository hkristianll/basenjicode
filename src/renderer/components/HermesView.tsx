import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { TicketDetail } from './TicketDetail'
import { Markdown } from './Markdown'
import { Icon } from './Icon'
import { useLoopBoard } from '../hooks/useLoopBoard'
import { useResizable } from '../hooks/useResizable'
import type { Settings } from '../../shared/domain-types'
import type { BoardTicketRow, HermesUiState, LoopEvent, LoopRunState, LoopStatus } from '../../shared/ipc-types'

type BrookeMsg = { role: 'you' | 'brooke' | 'tool'; text: string }
const DEPTS = ['architecture', 'implementation', 'design', 'testing', 'review', 'docs'] as const
const FEED_CAP = 500 // ring-buffer cap on the activity feed so an overnight run doesn't grow it unbounded (O3)

// Mission Control — the glass-box for Hermes: give a big goal, watch it decompose into a dependency graph,
// drain, and replan to done, intervening live. Reuses the same board data + loop event stream as the Raid view.

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The team a ticket belongs to, parsed from its body banner ("**Department: …**") — drives the node badge. */
function departmentOf(t: BoardTicketRow): string | null {
  const m = /\*\*Department:\s*([a-zA-Z]+)/.exec(t.body ?? '')
  return m ? m[1].toLowerCase() : null
}

/** Column header for a department bucket. 'other' is the catch-all for tickets that carry no team
 *  banner yet (e.g. added manually, or before Hermes has decomposed the goal) — "OTHER" reads like
 *  an error state, so show "Unassigned" instead. */
function deptLabel(dept: string): string {
  return dept === 'other' ? 'Unassigned' : dept
}

/** A node's CSS status class — done/cancelled muted, in_progress live, review amber, blocked dim, ready accent. */
function nodeClass(t: BoardTicketRow): string {
  if (t.status === 'in_progress') return 'live'
  if (t.status === 'done') return 'done'
  if (t.status === 'cancelled') return 'cancelled'
  if (t.status === 'review') return 'review'
  if (t.blocked) return 'blocked'
  return 'ready'
}

export function HermesView({ settings, workingCwd, onWorkingCwdChange, recentCwds, project }: { settings: Settings; workingCwd: string; onWorkingCwdChange: (cwd: string) => void; recentCwds: string[]; project: string }) {
  // Brooke — the group-manager chat (replaces the goal composer). You give goals and ask for status here.
  const [chatOpen, setChatOpen] = useState(true)
  const [brookeMsgs, setBrookeMsgs] = useState<BrookeMsg[]>([])
  const [brookeInput, setBrookeInput] = useState('')
  const [brookeBusy, setBrookeBusy] = useState(false)
  const brookeBodyRef = useRef<HTMLDivElement>(null)
  // The worktab selection is authoritative; recents are only a fallback before a folder is chosen.
  const cwd = workingCwd || settings.lastCwd || recentCwds[0] || ''
  // UNIFIED folder model: the single working folder (the top-bar picker, persisted as lastCwd) IS the projects root —
  // each project works in its OWN <workingFolder>/<project> subfolder. One control, so the work folder can never drift
  // from what's shown (no separate "Hermes projects root" to go stale, the bug that sent a new project into an old
  // project's folder). Picking here sets the SAME working folder as the top bar.
  const projectsRoot = cwd
  const folderName = project.replace(/[<>:"/\\|?*]+/g, '').replace(/\s+/g, ' ').trim() || 'project'
  const workFolder = projectsRoot ? projectsRoot.replace(/[\\/]+$/, '') + (projectsRoot.includes('\\') ? '\\' : '/') + folderName : ''
  const pickRoot = (): void => {
    void window.api.dialog.pickDirectory().then((d) => {
      if (!d) return
      onWorkingCwdChange(d) // sets the ONE working folder (lastCwd) — also the projects root
    })
  }
  const [runState, setRunState] = useState<LoopRunState>('idle')
  const [hermesState, setHermesState] = useState<HermesUiState | null>(null) // orchestrator phase (O2)
  const [planningStep, setPlanningStep] = useState('') // live decompose progress, shown while the board is still empty
  const [stats, setStats] = useState<LoopStatus | null>(null)
  const [feed, setFeed] = useState<LoopEvent[]>([])
  const [selected, setSelected] = useState<{ id: number; title: string } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [hideDone, setHideDone] = useState(true) // de-bloat: collapse completed tickets by default (toggle in header)
  const [memoryDept, setMemoryDept] = useState<string | null>(null) // open team's memory viewer (Phase 4)
  const [memoryText, setMemoryText] = useState('')

  const { tickets, counts, error: boardError } = useLoopBoard(project)
  const visibleTickets = useMemo(() => (hideDone ? tickets.filter((t) => t.status !== 'done' && t.status !== 'cancelled') : tickets), [tickets, hideDone])
  const doneCount = useMemo(() => tickets.filter((t) => t.status === 'done' || t.status === 'cancelled').length, [tickets])
  // Group the graph BY TEAM (department), not by dep-depth — that matches how the work is actually organized
  // (testing and implementation no longer share a column). Within a team: active first, then todo/review/blocked.
  const deptColumns = useMemo(() => {
    const groups = new Map<string, BoardTicketRow[]>()
    for (const t of visibleTickets) {
      const d = departmentOf(t) ?? 'other'
      const arr = groups.get(d)
      if (arr) arr.push(t)
      else groups.set(d, [t])
    }
    const rank = (s: string): number => (s === 'in_progress' ? 0 : s === 'todo' ? 1 : s === 'review' ? 2 : 3)
    const order = (d: string): number => {
      const i = (DEPTS as readonly string[]).indexOf(d)
      return i === -1 ? DEPTS.length : i
    }
    return [...groups.entries()]
      .sort((a, b) => order(a[0]) - order(b[0]))
      .map(([dept, ts]) => ({ dept, tickets: ts.sort((x, y) => rank(x.status) - rank(y.status) || x.id - y.id) }))
  }, [visibleTickets])

  // Resizable panels: the side (timeline/detail) width and the chat height are user-draggable + persisted.
  const viewRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const side = useResizable({ axis: 'x', initial: 360, min: 240, reserve: 340, invert: true, storageKey: 'nc.hermes.sideW', containerRef: bodyRef })
  const chat = useResizable({ axis: 'y', initial: 360, min: 180, reserve: 240, invert: true, storageKey: 'nc.hermes.chatH', containerRef: viewRef })

  // SVG dependency edges (U6): measure node centers in the graph's content space and draw a connector curve
  // from each dependency's right edge to its dependent's left edge. Re-measures on data/layout/size changes.
  const graphRef = useRef<HTMLDivElement>(null)
  const nodeRefs = useRef(new Map<number, HTMLButtonElement>())
  const [edges, setEdges] = useState<{ key: string; d: string }[]>([])
  const [svgSize, setSvgSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const edgesSigRef = useRef('')
  // STABLE primitive signature of the graph (ids+deps+status). Used as the layout-effect dep so it re-runs only
  // on real graph changes — `tickets`/`columns` are fresh array refs every render when the board is empty
  // (`data?.tickets ?? []`), which loops setEdges→render→setEdges (React #185). Primitives compare by value.
  const graphSig = useMemo(() => (hideDone ? 'H|' : 'S|') + tickets.map((t) => `${t.id}:${(t.deps ?? []).join(',')}:${t.status}`).join('|'), [tickets, hideDone])
  useLayoutEffect(() => {
    const container = graphRef.current
    if (!container || tickets.length === 0) {
      edgesSigRef.current = ''
      setEdges((prev) => (prev.length ? [] : prev)) // keep the same ref when already empty → no extra render
      return
    }
    const measure = (): void => {
      const cRect = container.getBoundingClientRect()
      const centerOf = (el: HTMLElement): { left: number; right: number; cy: number } => {
        const r = el.getBoundingClientRect()
        return { left: r.left - cRect.left + container.scrollLeft, right: r.right - cRect.left + container.scrollLeft, cy: r.top - cRect.top + container.scrollTop + r.height / 2 }
      }
      const pos = new Map<number, { left: number; right: number; cy: number }>()
      nodeRefs.current.forEach((el, id) => {
        if (el.isConnected) pos.set(id, centerOf(el))
      })
      const next: { key: string; d: string }[] = []
      for (const t of tickets) {
        const to = pos.get(t.id)
        if (!to) continue
        for (const dep of t.deps ?? []) {
          const from = pos.get(dep)
          if (!from) continue
          const dx = Math.max(18, (to.left - from.right) / 2)
          next.push({ key: `${dep}-${t.id}`, d: `M ${from.right} ${from.cy} C ${from.right + dx} ${from.cy}, ${to.left - dx} ${to.cy}, ${to.left} ${to.cy}` })
        }
      }
      const w = container.scrollWidth
      const h = container.scrollHeight
      setSvgSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
      const sig = next.map((e) => e.key + e.d).join(';')
      if (sig !== edgesSigRef.current) {
        edgesSigRef.current = sig
        setEdges(next)
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(container)
    return () => ro.disconnect()
  }, [graphSig]) // eslint-disable-line react-hooks/exhaustive-deps -- graphSig is the stable proxy for tickets

  // The replan timeline (O3): typed decompose/replan/improve round events — structured, not a regex over notices.
  const timeline = useMemo(
    () =>
      feed
        .filter((e): e is Extract<LoopEvent, { kind: 'hermes-round' }> => e.kind === 'hermes-round')
        .map((e) => {
          if (e.phase === 'decompose') return `Decomposed into ${e.tickets ?? 0} ticket(s)`
          if (e.phase === 'split') return `Split round ${e.round}: +${e.added ?? 0} slice(s)${e.note ? ` — ${e.note}` : ''}`
          const verb = e.phase === 'improve' ? 'Improve' : 'Replan'
          return `${verb} round ${e.round}: +${e.added ?? 0} added, ${e.reopened ?? 0} reopened${e.note ? ` — ${e.note}` : ''}`
        }),
    [feed]
  )

  const elapsedMs = stats?.startedAt ? now - stats.startedAt : 0
  // Orchestrator phase (O2) takes precedence over the drain's runState, so the header reads "replanning" while a
  // model call runs between drains instead of the drain's stale "stopped" (and the controls stay visible).
  const paused = hermesState === 'paused' || runState === 'paused'
  const hermesActive = hermesState != null && hermesState !== 'done'
  const running = hermesActive ? !paused : runState === 'running'
  const showControls = hermesActive || runState === 'running' || runState === 'paused'
  const displayState: string = hermesState ?? runState
  const stateClass = paused ? 'paused' : hermesActive ? 'running' : runState

  useEffect(() => {
    window.api.loop
      .status()
      .then((s) => {
        setRunState(s.state)
        setStats(s)
      })
      .catch(() => undefined)
    const unsub = window.api.loop.onEvent((e) => {
      if (e.kind === 'status' || e.kind === 'run-stats') {
        setStats(e.status)
        setRunState(e.status.state)
        return
      }
      if (e.kind === 'hermes-state') {
        setHermesState(e.state) // drives the header run-state (O2); not added to the activity feed
        if (e.state !== 'planning') setPlanningStep('') // planning finished — clear the progress line
        return
      }
      // Live decompose progress (notices prefixed "Planning:") drives the empty-board indicator so a slow staged
      // decompose reads as "working", not stalled.
      if (e.kind === 'notice' && e.text.startsWith('Planning:')) setPlanningStep(e.text.slice('Planning:'.length).trim())
      if (e.kind === 'stopped') setRunState('stopped')
      if (e.kind === 'paused') setRunState('paused')
      setFeed((f) => (f.length >= FEED_CAP ? [...f.slice(f.length - FEED_CAP + 1), e] : [...f, e])) // ring-buffer (O3)
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])

  // Load Brooke's history for this project + stream her replies into the chat.
  useEffect(() => {
    setBrookeMsgs([])
    void window.api.hermes.history(project).then((h) => setBrookeMsgs(h.map((m) => ({ role: m.role === 'user' ? 'you' : 'brooke', text: m.content }))))
    const off = window.api.hermes.onEvent((e) => {
      if (e.type === 'assistant-delta') {
        setBrookeMsgs((ms) => {
          const last = ms[ms.length - 1]
          if (last && last.role === 'brooke') return [...ms.slice(0, -1), { role: 'brooke', text: last.text + e.text }]
          return [...ms, { role: 'brooke', text: e.text }]
        })
      } else if (e.type === 'assistant-message-done' && e.finalText) {
        setBrookeMsgs((ms) => {
          const last = ms[ms.length - 1]
          if (last && last.role === 'brooke') return [...ms.slice(0, -1), { role: 'brooke', text: e.finalText! }]
          return [...ms, { role: 'brooke', text: e.finalText! }]
        })
      } else if (e.type === 'tool-result') {
        // Brooke's control tools return a human-readable status line — surface it as an activity message.
        if (e.result?.trim()) setBrookeMsgs((ms) => [...ms, { role: 'tool', text: e.result.split('\n')[0] }])
      } else if (e.type === 'turn-done') {
        if (e.error) setBrookeMsgs((ms) => [...ms, { role: 'tool', text: `⚠ ${e.error}` }]) // surface a failed turn (U4)
        setBrookeBusy(false)
      }
    })
    return () => off()
  }, [project])

  useEffect(() => {
    brookeBodyRef.current?.scrollTo({ top: brookeBodyRef.current.scrollHeight })
  }, [brookeMsgs, chatOpen])

  const sendBrooke = (): void => {
    const text = brookeInput.trim()
    if (!text || brookeBusy) return
    setBrookeMsgs((ms) => [...ms, { role: 'you', text }])
    setBrookeInput('')
    setBrookeBusy(true)
    setChatOpen(true)
    // Clear the busy state + surface the error if the IPC itself rejects (no turn-done would fire) — otherwise
    // the composer stays disabled forever (U4).
    void window.api.hermes.message({ project, text }).catch((err: unknown) => {
      setBrookeBusy(false)
      setBrookeMsgs((ms) => [...ms, { role: 'tool', text: `⚠ couldn't reach Planner: ${err instanceof Error ? err.message : String(err)}` }])
    })
  }

  // Team memory viewer (Phase 4): open/save a department's lead memory.
  const openMemory = (dept: string): void => {
    setMemoryDept(dept)
    setMemoryText('')
    void window.api.hermes.teamMemory({ project, dept }).then(setMemoryText).catch(() => setMemoryText(''))
  }
  const saveMemory = (): void => {
    if (!memoryDept) return
    void window.api.hermes.setTeamMemory({ project, dept: memoryDept, content: memoryText })
    setMemoryDept(null)
  }

  const selectedStatus = selected ? tickets.find((t) => t.id === selected.id)?.status : undefined
  const replanRounds = useMemo(() => feed.filter((e) => e.kind === 'hermes-round' && e.phase === 'replan').length, [feed])
  // The ONE ticket the (sequential) drain is executing right now — distinct from board-status in_progress, so
  // the live one is unmistakable even when several nodes sit in in_progress/review.
  const currentWork = stats?.currentTicket ? tickets.find((t) => t.id === stats.currentTicket) : undefined
  const emptyPlanner = tickets.length === 0 && !boardError && hermesState !== 'planning' && !planningStep
  const deptCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const t of tickets) {
      const d = departmentOf(t)
      if (d) c[d] = (c[d] ?? 0) + 1
    }
    return c
  }, [tickets])

  return (
    <div id="workspace-panel-hermes" className="hermes-view" ref={viewRef} role="tabpanel" aria-labelledby="workspace-tab-hermes">
      <div className="hermes-header">
        <div className="hermes-compose">
          <span className="hermes-title">Planner · {project}</span>
          {!emptyPlanner && (
            <button
              className="btn"
              disabled={running}
              onClick={pickRoot}
              title={projectsRoot ? `Working folder: ${projectsRoot}\nThis project → ${workFolder}\nThe same folder as the top bar; each project gets its own subfolder here.` : 'Pick your working folder; each project gets its own subfolder under it.'}
            >
              {projectsRoot ? 'Working folder…' : 'Set working folder…'}
            </button>
          )}
          {showControls && (
            <>
              {paused ? (
                <button className="btn" onClick={() => void window.api.loop.resume()}>
                  Resume
                </button>
              ) : (
                <button className="btn" onClick={() => void window.api.loop.pause()}>
                  Pause
                </button>
              )}
              <button className="btn reject" onClick={() => void window.api.loop.stop()}>
                Stop
              </button>
            </>
          )}
        </div>
        <div className="hermes-runinfo">
          <span className={`loop-state loop-state-${stateClass}`}>{displayState}</span>
          {currentWork && (
            <span className="hermes-working-now" title={`Working on #${currentWork.id}: ${currentWork.title}`}>
              ▶ #{currentWork.id} {currentWork.title}
            </span>
          )}
          {replanRounds > 0 && <span className="hermes-chip">replan ×{replanRounds}</span>}
          {counts && (
            <span className="hermes-chip">
              {counts.done}/{counts.total} done
            </span>
          )}
          {doneCount > 0 && (
            <button className="hermes-chip hermes-toggle" onClick={() => setHideDone((h) => !h)} title={hideDone ? 'Show completed tickets in the graph' : 'Hide completed tickets to de-clutter the board'}>
              {hideDone ? `show ${doneCount} done` : 'hide done'}
            </button>
          )}
          {stats?.startedAt && <span className="hermes-chip">{fmtElapsed(elapsedMs)}</span>}
          {workFolder ? (
            <span className="hermes-chip" title={workFolder}>
              folder: {workFolder.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}
            </span>
          ) : (
            <span className="hermes-warn">set a working folder</span>
          )}
        </div>
      </div>

      <div className={`hermes-body ${emptyPlanner ? 'is-empty' : ''}`} ref={bodyRef}>
        <div className="hermes-graph" ref={graphRef}>
          {tickets.length === 0 ? (
            boardError ? (
              <div className="hermes-empty hermes-warn">Can&rsquo;t reach the ticket board — {boardError}. Is the board service running?</div>
            ) : hermesState === 'planning' || planningStep ? (
              <div className="hermes-planning">
                <div className="hermes-planning-spinner" aria-hidden="true" />
                <div className="hermes-planning-title">Decomposing the goal…</div>
                <div className="hermes-planning-step">{planningStep || 'Outlining the board…'}</div>
                <div className="hermes-planning-hint">The plan is built in pieces — tickets appear once decomposition finishes (a few minutes on a local model).</div>
              </div>
            ) : (
              <div className="hermes-onboarding">
                <span className="hermes-onboarding-mark" aria-hidden="true">
                  <Icon name="sparkle" size={20} />
                </span>
                <h2>What should Planner organize?</h2>
                <p>Start with an outcome. Planner will break it into tasks, route the work, and report progress here.</p>
                {!projectsRoot ? (
                  <button className="btn primary" type="button" onClick={pickRoot}>
                    <Icon name="folder" size={14} /> Choose working folder
                  </button>
                ) : (
                  <div className="hermes-starters">
                    {[
                      ['Plan a feature', 'Help me plan a new feature. Ask what outcome I want before creating tasks.'],
                      ['Break down a bug', 'Help me investigate and break down a bug into verifiable tasks.'],
                      ['Audit this project', 'Audit this project and propose a prioritized, verifiable improvement plan.']
                    ].map(([label, prompt]) => (
                      <button
                        key={label}
                        type="button"
                        onClick={() => {
                          setBrookeInput(prompt)
                          setChatOpen(true)
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          ) : visibleTickets.length === 0 ? (
            <div className="hermes-empty">All {doneCount} ticket(s) done — toggle &ldquo;show done&rdquo; in the header to see them.</div>
          ) : (
            <>
              <svg className="hermes-edges" width={svgSize.w} height={svgSize.h} aria-hidden="true">
                {edges.map((e) => (
                  <path key={e.key} className="hermes-edge" d={e.d} />
                ))}
              </svg>
              {deptColumns.map(({ dept, tickets: ts }) => (
              <div className="hermes-col" key={dept}>
                <div className="hermes-col-label">
                  <span>
                    {deptLabel(dept)} · {ts.length}
                  </span>
                  {dept !== 'other' && (
                    <button className="hermes-mem-btn" title={`View the ${dept} team's memory`} onClick={() => openMemory(dept)}>
                      🧠
                    </button>
                  )}
                </div>
                {ts.map((t) => {
                  const dept = departmentOf(t)
                  const isWorking = stats?.currentTicket === t.id
                  return (
                    <button
                      key={t.id}
                      ref={(el) => {
                        if (el) nodeRefs.current.set(t.id, el)
                        else nodeRefs.current.delete(t.id)
                      }}
                      className={`hermes-node ${nodeClass(t)} ${isWorking ? 'working' : ''} ${selected?.id === t.id ? 'selected' : ''}`}
                      onClick={() => setSelected({ id: t.id, title: t.title })}
                      title={t.check ? `check: ${t.check}` : 'no check'}
                    >
                      <div className="hermes-node-top">
                        <span className="hermes-node-id">#{t.id}</span>
                        {dept && <span className={`hermes-dept dept-${dept}`}>{dept}</span>}
                      </div>
                      <span className="hermes-node-title">{t.title}</span>
                      <span className={`hermes-node-status ${isWorking ? 'working' : ''}`}>{isWorking ? '● working…' : t.status}</span>
                      {t.blocked_by && t.blocked_by.length > 0 && (
                        <span className="hermes-node-blocked">⟂ {t.blocked_by.map((d) => `#${d}`).join(' ')}</span>
                      )}
                    </button>
                  )
                })}
              </div>
              ))}
            </>
          )}
        </div>

        <div
          className={`resizer-x ${side.dragging ? 'dragging' : ''}`}
          onPointerDown={side.onPointerDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize timeline panel"
        />
        <div className="hermes-side" style={{ width: side.size }}>
          {selected ? (
            <TicketDetail
              ticket={selected}
              events={feed}
              isActive={stats?.currentTicket === selected.id}
              status={selectedStatus}
              onClose={() => setSelected(null)}
            />
          ) : (
            <div className="hermes-timeline">
              <div className="hermes-timeline-title">Replan timeline</div>
              {timeline.length === 0 ? (
                <div className="hermes-empty">Decompose + replan rounds will be logged here.</div>
              ) : (
                timeline.map((line, i) => (
                  <div className="hermes-timeline-row" key={i}>
                    <span className="hermes-timeline-dot" />
                    {line}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* Brooke — the group-manager chat, docked along the bottom (Teams-style). Give goals + ask for status. */}
      {chatOpen && (
        <div
          className={`resizer-y ${chat.dragging ? 'dragging' : ''}`}
          onPointerDown={chat.onPointerDown}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize chat panel"
        />
      )}
      <div className={`hermes-chat ${chatOpen ? 'open' : 'collapsed'}`} style={chatOpen ? { height: chat.size } : undefined}>
        <div className="hermes-chat-head" onClick={() => setChatOpen((o) => !o)}>
          <div className="hermes-av brooke sm" aria-hidden="true">P</div>
          <span className="hermes-chat-name">
            Planner
            <span className="hermes-chat-sub">
              <span className="hermes-chat-dot" /> Coordinator
            </span>
          </span>
          <div className="hermes-chat-depts">
            {DEPTS.map((d) => (
              <span key={d} className={`hermes-dept dept-${d}`} style={{ opacity: (deptCounts[d] ?? 0) > 0 ? 1 : 0.4 }}>
                {d} {deptCounts[d] ?? 0}
              </span>
            ))}
          </div>
          <span className="hermes-chat-toggle">{chatOpen ? '▾' : '▸'}</span>
        </div>
        {chatOpen && (
          <>
            <div className="hermes-chat-body" ref={brookeBodyRef}>
              {brookeMsgs.length === 0 ? (
                <div className="hermes-chat-empty">
                  <div className="hermes-av brooke lg" aria-hidden="true">P</div>
                  <div className="hermes-chat-empty-title">Planner · Coordinator</div>
                  <div className="hermes-chat-empty-sub">
                    Give the planner a goal (&ldquo;build a 3d printer slicer&rdquo;) or ask for status — it plans the work, hands it to the teams, and reports back.
                  </div>
                </div>
              ) : (
                brookeMsgs.map((m, i) => {
                  const prev = brookeMsgs[i - 1]
                  const cont = !!prev && prev.role === m.role && m.role !== 'tool'
                  if (m.role === 'tool') {
                    return (
                      <div key={i} className="hermes-sys">
                        <span className="hermes-sys-text">{m.text}</span>
                      </div>
                    )
                  }
                  if (m.role === 'you') {
                    return (
                      <div key={i} className={`hermes-row you ${cont ? 'cont' : ''}`}>
                        <div className="hermes-bubble">{m.text}</div>
                      </div>
                    )
                  }
                  return (
                    <div key={i} className={`hermes-row brooke ${cont ? 'cont' : ''}`}>
                      {cont ? <div className="hermes-av-spacer" aria-hidden="true" /> : <div className="hermes-av brooke" aria-hidden="true">P</div>}
                      <div className="hermes-msg-content">
                        {!cont && (
                          <div className="hermes-msg-meta">
                            <span className="hermes-msg-name">Planner</span>
                            <span className="hermes-msg-role">Coordinator</span>
                          </div>
                        )}
                        <Markdown text={m.text} />
                      </div>
                    </div>
                  )
                })
              )}
              {brookeBusy && (
                <div className="hermes-row brooke">
                  <div className="hermes-av brooke" aria-hidden="true">P</div>
                  <div className="hermes-msg-content">
                    <div className="hermes-typing" aria-label="Planner is typing">
                      <span /><span /><span />
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="hermes-chat-composer">
              <input
                className="hermes-chat-input"
                placeholder="Message Planner..."
                value={brookeInput}
                onChange={(e) => setBrookeInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendBrooke()}
              />
              <button className="hermes-send" disabled={!brookeInput.trim() || brookeBusy} onClick={sendBrooke} aria-label="Send to Planner">
                <Icon name="send" size={16} />
              </button>
            </div>
          </>
        )}
      </div>

      {memoryDept && (
        <div className="hermes-mem-overlay" onClick={() => setMemoryDept(null)}>
          <div className="hermes-mem-panel" onClick={(e) => e.stopPropagation()}>
            <div className="hermes-mem-head">
              <span className={`hermes-dept dept-${memoryDept}`}>{memoryDept}</span>
              <span className="hermes-mem-title">team memory</span>
              <button className="hermes-mem-close" title="Close" onClick={() => setMemoryDept(null)}>
                ×
              </button>
            </div>
            <textarea
              className="hermes-mem-text"
              value={memoryText}
              onChange={(e) => setMemoryText(e.target.value)}
              placeholder="(empty — the team lead fills this in as the team works; you can seed or prune it here)"
              spellCheck={false}
            />
            <div className="hermes-mem-actions">
              <span className="hermes-mem-hint">The lead reads this into every brief and rewrites it after each review.</span>
              <button className="btn" onClick={() => setMemoryDept(null)}>
                Cancel
              </button>
              <button className="btn primary" onClick={saveMemory}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
