import { useEffect, useRef, useState } from 'react'
import { LoopBoard } from './LoopBoard'
import { TicketDetail } from './TicketDetail'
import { LoopChat } from './LoopChat'
import { useLoopBoard } from '../hooks/useLoopBoard'
import { useResizable } from '../hooks/useResizable'
import { verbOf, argTarget, shortArg } from '../toolVerb'
import type { Settings } from '../../shared/domain-types'
import type { LoopConfig, LoopEvent, LoopRunState, LoopStatus } from '../../shared/ipc-types'

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
function fmtK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return String(Math.round(n))
}
function pctOf(used: number, max: number): number {
  if (!max || max <= 0) return 0
  return Math.min(1, used / max)
}
/** Which cap is closest to tripping, as a human "left" string — turns invisible tripwires into a warning. */
function projectedStop(a: {
  tokensUsed: number
  maxTokens: number
  elapsedSec: number
  maxWallclockSec: number
  done: number
  maxTickets: number
}): string | null {
  const items = [
    { k: 'token', r: pctOf(a.tokensUsed, a.maxTokens), left: `~${fmtK(Math.max(0, a.maxTokens - a.tokensUsed))} tokens left` },
    { k: 'time', r: pctOf(a.elapsedSec, a.maxWallclockSec), left: `~${Math.max(0, Math.round((a.maxWallclockSec - a.elapsedSec) / 60))} min left` },
    { k: 'ticket', r: pctOf(a.done, a.maxTickets), left: `${Math.max(0, a.maxTickets - a.done)} tickets left` }
  ]
  items.sort((x, y) => y.r - x.r)
  const top = items[0]
  if (top.r < 0.5) return null
  const verb = top.r >= 0.95 ? 'stopping soon' : top.r >= 0.8 ? `nearing ${top.k} budget` : `${top.k} budget`
  return `${verb} — ${top.left}`
}

/** Desktop notification — only when the window is NOT focused (nobody watching an overnight drain wants
 *  a ping while they're staring at it). Best-effort: silently no-ops if notifications are unavailable. */
function notify(title: string, body: string): void {
  try {
    if (typeof document !== 'undefined' && document.hasFocus()) return
    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'granted') {
      new Notification(title, { body })
    } else if (Notification.permission !== 'denied') {
      void Notification.requestPermission().then((p) => {
        if (p === 'granted') new Notification(title, { body })
      })
    }
  } catch {
    /* notifications unavailable */
  }
}

/** NordCode's "Loop" tab: configure + drive an autonomous board-draining run, watch it live. */
export function LoopView({
  settings,
  workingCwd,
  onWorkingCwdChange,
  recentCwds,
  project,
  onProjectChange
}: {
  settings: Settings
  workingCwd: string
  onWorkingCwdChange: (cwd: string) => void
  recentCwds: string[]
  project: string
  onProjectChange?: (project: string) => void
}) {
  const [cwd, setCwd] = useState(workingCwd || recentCwds[0] || settings.lastCwd || '')
  const [terminal, setTerminal] = useState<'auto' | 'review'>('auto')
  const [maxTickets, setMaxTickets] = useState(20)
  const [maxTokens, setMaxTokens] = useState(200000)
  const [maxWallclockSec, setMaxWallclockSec] = useState(3600)
  const [maxFails, setMaxFails] = useState(3)
  const [reviewPlans, setReviewPlans] = useState(false)
  // Hermes: a big goal the orchestrator decomposes → drains → replans, instead of draining a pre-built board.
  const [goal, setGoal] = useState('')
  const [runState, setRunState] = useState<LoopRunState>('idle')
  const [stats, setStats] = useState<LoopStatus | null>(null)
  const [feed, setFeed] = useState<LoopEvent[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [selected, setSelected] = useState<{ id: number; title: string } | null>(null)
  const [summaries, setSummaries] = useState<Record<number, string>>({})
  const [detailMode, setDetailMode] = useState<'activity' | 'chat'>('activity')
  const [mobilePane, setMobilePane] = useState<'board' | 'activity' | 'chat'>('board')
  const [now, setNow] = useState(() => Date.now())

  // Resizable: the activity/chat detail panel width is user-draggable + persisted.
  const bodyRef = useRef<HTMLDivElement>(null)
  const detail = useResizable({ axis: 'x', initial: 460, min: 300, reserve: 420, invert: true, storageKey: 'nc.raid.detailW', containerRef: bodyRef })

  useEffect(() => {
    if (workingCwd) setCwd(workingCwd)
  }, [workingCwd])

  const feedRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  // Live board rows — used to resolve the selected ticket's current status for the detail pane's controls.
  const { tickets: boardTickets } = useLoopBoard(project)
  const selectedStatus = selected ? boardTickets.find((t) => t.id === selected.id)?.status : undefined

  // Seed from the live runner state (so reopening mid-run shows it), then stream events.
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
      if (e.kind === 'ticket-summary') {
        setSummaries((s) => ({ ...s, [e.id]: e.text }))
        return
      }
      if (e.kind === 'stopped') {
        setRunState('stopped')
        notify('Run finished', `Run stopped - ${e.reason}`)
      }
      if (e.kind === 'paused') setRunState('paused')
      if (e.kind === 'ticket-failed') notify(`Ticket #${e.id} failed`, e.error)
      if (e.kind === 'ticket-done' && e.terminal === 'park') notify(`Ticket #${e.id} parked`, 'Needs your attention.')
      setFeed((f) => [...f, e])
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    if (!stick.current) return
    const raf = requestAnimationFrame(() => {
      feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight })
    })
    return () => cancelAnimationFrame(raf)
  }, [feed])

  // Tick once a second while a run is live so the time burn-down + elapsed clock stay current.
  useEffect(() => {
    if (runState !== 'running') return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [runState])

  // Worker + reviewer (connection + model) live in Settings → Loop drain, so they're persistent + discoverable.
  const workerConnId = settings.loopWorkerConnectionId || settings.activeConnectionId
  const reviewerConn = settings.connections.find((c) => c.id === settings.loopReviewerConnectionId)
  const workerConn = settings.connections.find((c) => c.id === workerConnId)
  const workerLabel = settings.loopWorkerModel || workerConn?.model || workerConn?.label || '—'
  const reviewerLabel = settings.loopReviewerConnectionId ? settings.loopReviewerModel || reviewerConn?.model || reviewerConn?.label || '—' : 'none'

  function config(): LoopConfig {
    return {
      cwd,
      connectionId: workerConnId,
      project,
      mode: 'auto',
      caps: { maxTickets, maxTokens, maxWallclockSec, maxConsecutiveFailures: maxFails },
      terminal,
      reviewerConnectionId: settings.loopReviewerConnectionId || undefined,
      workerModel: settings.loopWorkerModel || undefined,
      reviewerModel: settings.loopReviewerModel || undefined,
      swapModels: settings.loopSwapModels ?? true,
      reviewPlans
    }
  }

  const running = runState === 'running'
  const paused = runState === 'paused'
  const canStart = !!cwd && !!workerConnId
  const elapsedMs = stats?.startedAt ? now - stats.startedAt : 0
  const projStop =
    stats && (running || paused)
      ? projectedStop({
          tokensUsed: stats.tokensUsed ?? 0,
          maxTokens,
          elapsedSec: Math.floor(elapsedMs / 1000),
          maxWallclockSec,
          done: stats.done,
          maxTickets
        })
      : null
  const currentTicket = stats?.currentTicket ? boardTickets.find((t) => t.id === stats.currentTicket) : undefined
  const queueTotal =
    boardTickets.length ||
    (stats ? Math.max(1, stats.done + stats.review + stats.parked + stats.failed + (stats.currentTicket ? 1 : 0)) : 0)
  const currentLabel = currentTicket
    ? `#${currentTicket.id} ${currentTicket.title}`
    : running
      ? 'Selecting next ticket'
      : 'No active ticket'
  const hasGoal = Boolean(goal.trim())
  const readyCount = boardTickets.filter((ticket) => ticket.ready).length
  const canLaunch = canStart && (hasGoal || readyCount > 0)

  const launchReadyOrGoal = (): void => {
    if (!canLaunch) return
    setFeed([])
    if (hasGoal) void window.api.loop.orchestrate({ goal: goal.trim(), config: config() })
    else void window.api.loop.start(config())
    setMobilePane('activity')
  }

  return (
    <div id="workspace-panel-loop" className="loop-view-full" role="tabpanel" aria-labelledby="workspace-tab-loop">
      <div className="mission-command">
        <div className="mission-map-panel" aria-hidden="true">
          <MissionRouteGraphic stats={stats} runState={runState} total={queueTotal} />
        </div>
        <div className="mission-command-main">
          <div className="mission-kicker">Mission Control</div>
          <div className="mission-title-row">
            <div className="mission-title-block">
              <h2 title={project}>{project}</h2>
              <span className="mission-current" title={currentLabel}>{currentLabel}</span>
            </div>
            <span className={`loop-state loop-state-${runState}`}>{runState}</span>
          </div>
          <div className="mission-route-line" title="Worker + reviewer models - set in Settings -> Runs">
            <span>worker</span>
            <b>{workerLabel}</b>
            <span className="mission-route-arrow">{'->'}</span>
            <span>review</span>
            <b>{reviewerLabel === 'none' ? 'human / checks' : reviewerLabel}</b>
          </div>
        </div>
        <div className="mission-command-side">
          <MissionTile label="Elapsed" value={stats?.startedAt ? fmtElapsed(elapsedMs) : '0:00'} />
          <MissionTile label="Queue" value={queueTotal ? `${stats?.done ?? 0}/${queueTotal}` : 'empty'} />
          <MissionTile label="Context" value={stats ? `${fmtK(stats.tokensUsed ?? 0)} / ${fmtK(maxTokens)}` : `0 / ${fmtK(maxTokens)}`} />
        </div>
      </div>
      <div className="loop-header">
        <div className="loop-header-left">
          <span className="loop-project" title="active run">
            {project}
          </span>
          {running ? (
            <>
              <button className="btn" onClick={() => void window.api.loop.pause()}>
                Pause
              </button>
              <button className="btn reject" onClick={() => void window.api.loop.stop()}>
                Stop
              </button>
            </>
          ) : paused ? (
            <>
              <button className="btn primary" onClick={() => void window.api.loop.start(config())}>
                Resume
              </button>
              <button className="btn reject" onClick={() => void window.api.loop.stop()}>
                Stop
              </button>
            </>
          ) : (
            <>
              <input
                className="loop-goal-input"
                placeholder="Describe a new goal, or run the ready tasks"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') launchReadyOrGoal()
                }}
              />
              <button
                className="btn primary loop-launch"
                disabled={!canLaunch}
                title={hasGoal ? 'Plan this goal into tasks, then run it' : readyCount > 0 ? `Run ${readyCount} ready task${readyCount === 1 ? '' : 's'}` : 'Add a goal or create a ready task first'}
                onClick={launchReadyOrGoal}
              >
                {hasGoal ? 'Plan mission & run' : 'Run ready tasks'}
              </button>
            </>
          )}
        </div>

        <div className="loop-header-right">
          {stats?.startedAt && <span className="loop-elapsed">{fmtElapsed(elapsedMs)}</span>}
          <button className={`btn ghost ${showSettings ? 'active' : ''}`} onClick={() => setShowSettings((s) => !s)}>
            Run settings
          </button>
        </div>

        {showSettings && (
          <div className="loop-settings-popover">
            <label className="loop-field">
              Folder
              <select value={cwd} onChange={(e) => { setCwd(e.target.value); onWorkingCwdChange(e.target.value) }}>
                {cwd && !recentCwds.includes(cwd) && <option value={cwd}>{basename(cwd)}</option>}
                {recentCwds.map((c) => (
                  <option key={c} value={c}>
                    {basename(c)}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn" onClick={() => void window.api.dialog.pickDirectory().then((d) => { if (d) { setCwd(d); onWorkingCwdChange(d) } })}>
              Choose…
            </button>
            <div className="loop-field loop-models-note">
              Worker {workerLabel} · Reviewer {reviewerLabel}
              <span className="loop-models-link">change models &amp; swap in Settings -&gt; Runs</span>
            </div>
            <label className="loop-field">
              Terminal
              <select value={terminal} onChange={(e) => setTerminal(e.target.value as 'auto' | 'review')}>
                <option value="auto">Check → done, else review</option>
                <option value="review">Always review</option>
              </select>
            </label>
            <label className="loop-field">
              Max tickets
              <input type="number" value={maxTickets} onChange={(e) => setMaxTickets(+e.target.value)} />
            </label>
            <label className="loop-field">
              Token budget
              <input type="number" value={maxTokens} onChange={(e) => setMaxTokens(+e.target.value)} />
            </label>
            <label className="loop-field">
              Max minutes
              <input type="number" value={Math.round(maxWallclockSec / 60)} onChange={(e) => setMaxWallclockSec(+e.target.value * 60)} />
            </label>
            <label className="loop-field">
              Max fails
              <input type="number" value={maxFails} onChange={(e) => setMaxFails(+e.target.value)} />
            </label>
            <label className="loop-field loop-field-check" title="Pause each ticket at a read-only plan and require approval before it edits the worktree">
              <input type="checkbox" checked={reviewPlans} onChange={(e) => setReviewPlans(e.target.checked)} />
              Review plans before editing
            </label>
          </div>
        )}
      </div>

      {stats && (running || paused || !!stats.startedAt) && (
        <div className="loop-hud">
          <RunScope stats={stats} runState={runState} />
          <div className="loop-hud-counts">
            <span className="loop-count-chip">
              done <b>{stats.done}</b>
            </span>
            <span className="loop-count-chip">
              review <b>{stats.review}</b>
            </span>
            {stats.parked > 0 && (
              <span className="loop-count-chip warn">
                parked <b>{stats.parked}</b>
              </span>
            )}
            {stats.failed > 0 && (
              <span className="loop-count-chip err">
                failed <b>{stats.failed}</b>
              </span>
            )}
          </div>
          <div className="loop-hud-bars">
            <CapBar label="tokens" used={stats.tokensUsed ?? 0} max={maxTokens} fmt={fmtK} />
            <CapBar label="time" used={Math.floor(elapsedMs / 1000)} max={maxWallclockSec} fmt={(s) => fmtElapsed(s * 1000)} />
            <CapBar label="tickets" used={stats.done} max={maxTickets} fmt={(n) => String(n)} />
          </div>
          {projStop && <span className="loop-hud-stop">{projStop}</span>}
        </div>
      )}

      <div className="loop-mobile-nav" role="group" aria-label="Mission workspace panel">
        <button
          type="button"
          aria-pressed={mobilePane === 'board'}
          className={mobilePane === 'board' ? 'active' : ''}
          onClick={() => setMobilePane('board')}
        >
          Board
        </button>
        <button
          type="button"
          aria-pressed={mobilePane === 'activity'}
          className={mobilePane === 'activity' ? 'active' : ''}
          onClick={() => {
            setDetailMode('activity')
            setMobilePane('activity')
          }}
        >
          Activity
        </button>
        <button
          type="button"
          aria-pressed={mobilePane === 'chat'}
          className={mobilePane === 'chat' ? 'active' : ''}
          onClick={() => {
            setDetailMode('chat')
            setMobilePane('chat')
          }}
        >
          Chat
        </button>
      </div>

      <div className={`loop-body mobile-pane-${mobilePane}`} ref={bodyRef}>
        <div className="loop-board">
          <div className="loop-board-head">
            <span>Board · {project}</span>
          </div>
          <LoopBoard
            project={project}
            activeId={stats?.currentTicket}
            selectedId={selected?.id}
            summaries={summaries}
            onOpenProject={onProjectChange}
            onSelect={(t) => {
              setSelected({ id: t.id, title: t.title })
              setDetailMode('activity')
              setMobilePane('activity')
            }}
          />
        </div>
        <div
          className={`resizer-x ${detail.dragging ? 'dragging' : ''}`}
          onPointerDown={detail.onPointerDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize activity panel"
        />
        <div className="loop-detail" style={{ width: detail.size }}>
          <div className="loop-detail-head">
            <button className={`loop-detail-tab ${detailMode === 'activity' ? 'active' : ''}`} onClick={() => setDetailMode('activity')}>
              Activity
            </button>
            <button className={`loop-detail-tab ${detailMode === 'chat' ? 'active' : ''}`} onClick={() => setDetailMode('chat')}>
              Chat
            </button>
          </div>
          {detailMode === 'chat' ? (
            <LoopChat cwd={cwd} project={project} />
          ) : selected ? (
            <TicketDetail
              ticket={selected}
              events={feed}
              isActive={selected.id === stats?.currentTicket}
              status={selectedStatus}
              onClose={() => setSelected(null)}
            />
          ) : (
            <div
              className="loop-feed"
              ref={feedRef}
              onScroll={() => {
                const el = feedRef.current
                if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
              }}
            >
              {feed.length === 0 && <RunEmptyState />}
              {feed.map((e, i) => (
                <FeedRow key={i} e={e} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function MissionTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="mission-tile">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  )
}

function MissionRouteGraphic({ stats, runState, total }: { stats: LoopStatus | null; runState: LoopRunState; total: number }) {
  const done = stats?.done ?? 0
  const review = stats?.review ?? 0
  const problem = (stats?.parked ?? 0) + (stats?.failed ?? 0)
  const active = stats?.currentTicket != null
  const safeTotal = Math.max(1, total || done + review + problem + (active ? 1 : 0))
  const donePct = Math.min(100, Math.round((done / safeTotal) * 100))
  const reviewPct = Math.min(100, Math.round(((done + review) / safeTotal) * 100))
  const problemPct = Math.min(100, Math.round((problem / safeTotal) * 100))
  return (
    <svg className={`mission-map mission-map-${runState}`} viewBox="0 0 260 148" focusable="false">
      <path className="mission-map-grid" d="M22 28H236M22 74H236M22 120H236M54 18V130M106 18V130M158 18V130M210 18V130" />
      <path className="mission-map-rail shadow" d="M30 116C58 58 91 50 121 78S184 118 230 32" pathLength={100} />
      <path className="mission-map-rail" d="M30 116C58 58 91 50 121 78S184 118 230 32" pathLength={100} />
      <path className="mission-map-done" d="M30 116C58 58 91 50 121 78S184 118 230 32" pathLength={100} style={{ strokeDasharray: `${donePct} 100` }} />
      <path
        className="mission-map-review"
        d="M30 116C58 58 91 50 121 78S184 118 230 32"
        pathLength={100}
        style={{ strokeDasharray: `${Math.max(0, reviewPct - donePct)} 100`, strokeDashoffset: -donePct }}
      />
      {problem > 0 && (
        <path
          className="mission-map-problem"
          d="M30 116C58 58 91 50 121 78S184 118 230 32"
          pathLength={100}
          style={{ strokeDasharray: `${Math.max(7, problemPct)} 100`, strokeDashoffset: -Math.max(0, 96 - problemPct) }}
        />
      )}
      <g className="mission-map-nodes">
        <rect className="mission-map-card done" x="31" y="96" width="44" height="24" rx="5" />
        <rect className={`mission-map-card ${active ? 'active' : ''}`} x="101" y="63" width="50" height="30" rx="6" />
        <rect className="mission-map-card review" x="196" y="23" width="40" height="22" rx="5" />
      </g>
      {active && <circle className="mission-map-pulse" cx="126" cy="78" r="11" />}
    </svg>
  )
}

function RunEmptyState() {
  return (
    <div className="loop-feed-empty loop-feed-empty-rich">
      <div className="run-empty-shell">
        <svg className="run-empty-svg" viewBox="0 0 220 132" aria-hidden="true" focusable="false">
          <path className="run-empty-grid" d="M18 24H202M18 66H202M18 108H202M44 16V116M92 16V116M140 16V116M188 16V116" />
          <path className="run-empty-route shadow" d="M28 104C52 58 80 48 104 72S156 104 194 34" pathLength={100} />
          <path className="run-empty-route" d="M28 104C52 58 80 48 104 72S156 104 194 34" pathLength={100} />
          <g className="run-empty-cards">
            <rect x="34" y="88" width="36" height="19" rx="4" />
            <rect x="86" y="58" width="44" height="25" rx="5" />
            <rect x="150" y="28" width="36" height="19" rx="4" />
          </g>
          <path className="run-empty-tick" d="M98 70l7 7 16-17" />
        </svg>
        <div className="run-empty-title">Ready for the first ticket.</div>
        <div className="run-empty-sub">Start a run and this pane becomes the live event trace.</div>
      </div>
    </div>
  )
}

/** A thin token/time/ticket burn-down bar that turns amber near its cap and red at the edge. */
function CapBar({ label, used, max, fmt }: { label: string; used: number; max: number; fmt: (n: number) => string }) {
  const pct = pctOf(used, max)
  const level = pct >= 0.95 ? 'crit' : pct >= 0.8 ? 'warn' : 'ok'
  return (
    <div className="cap-bar" title={`${label}: ${fmt(used)} / ${fmt(max)}`}>
      <div className="cap-bar-label">
        <span>{label}</span>
        <span className="cap-bar-val">
          {fmt(used)} / {fmt(max)}
        </span>
      </div>
      <div className="cap-bar-track">
        <div className={`cap-bar-fill cap-${level}`} style={{ width: `${Math.round(pct * 100)}%` }} />
      </div>
    </div>
  )
}

function RunScope({ stats, runState }: { stats: LoopStatus; runState: LoopRunState }) {
  const active = stats.currentTicket != null
  const total = Math.max(1, stats.done + stats.review + stats.parked + stats.failed + (active ? 1 : 0))
  const donePct = Math.round((stats.done / total) * 100)
  const reviewPct = Math.round(((stats.done + stats.review) / total) * 100)
  const problemCount = stats.parked + stats.failed
  const problemPct = Math.round((problemCount / total) * 100)

  return (
    <div className={`run-scope run-scope-${runState}`} title={`Run scope: ${stats.done} done, ${stats.review} review`}>
      <svg className="run-scope-svg" viewBox="0 0 214 74" aria-hidden="true">
        <defs>
          <linearGradient id="run-scope-line" x1="22" y1="36" x2="192" y2="36" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="var(--green)" />
            <stop offset="0.5" stopColor="var(--accent)" />
            <stop offset="1" stopColor="var(--amber)" />
          </linearGradient>
        </defs>
        <path className="run-scope-grid" d="M18 18H196M18 37H196M18 56H196M42 10V64M88 10V64M134 10V64M180 10V64" />
        <path className="run-scope-rail" d="M24 54C55 18 84 18 108 37S160 58 190 19" pathLength={100} />
        <path
          className="run-scope-done"
          d="M24 54C55 18 84 18 108 37S160 58 190 19"
          pathLength={100}
          style={{ strokeDasharray: `${donePct} 100` }}
        />
        <path
          className="run-scope-review"
          d="M24 54C55 18 84 18 108 37S160 58 190 19"
          pathLength={100}
          style={{ strokeDasharray: `${Math.max(0, reviewPct - donePct)} 100`, strokeDashoffset: -donePct }}
        />
        {problemCount > 0 && (
          <path
            className="run-scope-problem"
            d="M24 54C55 18 84 18 108 37S160 58 190 19"
            pathLength={100}
            style={{ strokeDasharray: `${Math.max(7, problemPct)} 100`, strokeDashoffset: -Math.max(0, 96 - problemPct) }}
          />
        )}
        <circle className="run-scope-node done" cx="24" cy="54" r="4" />
        <circle className={`run-scope-node ${active ? 'active' : ''}`} cx="108" cy="37" r="5" />
        <circle className="run-scope-node review" cx="190" cy="19" r="4" />
        {active && <circle className="run-scope-pulse" cx="108" cy="37" r="9" />}
      </svg>
      <div className="run-scope-readout">
        <span>{active ? 'current' : 'scope'}</span>
        <b>{active ? `#${stats.currentTicket}` : `${stats.done}/${total}`}</b>
      </div>
    </div>
  )
}

function FeedRow({ e }: { e: LoopEvent }) {
  switch (e.kind) {
    case 'ticket-started':
      return (
        <div className="feed-row">
          <span className="feed-id">#{e.id}</span> ▶ {e.title}
        </div>
      )
    case 'check-result':
      return (
        <div className="feed-row">
          <span className={`tool-chip ${e.passed ? 'ok' : 'err'}`}>{e.passed ? 'check passed' : 'check failed'}</span>
          {e.output && <span className="feed-dim"> {e.output.slice(0, 200)}</span>}
        </div>
      )
    case 'plan-ready':
      return (
        <div className="feed-row">
          <span className="feed-id">#{e.id}</span> <span className="tool-chip awaiting">plan ready — awaiting approval</span>
        </div>
      )
    case 'review-result':
      return (
        <div className="feed-row">
          <span className="feed-id">#{e.id}</span>{' '}
          <span className={`tool-chip ${e.approved ? 'ok' : 'awaiting'}`}>
            review {e.round}: {e.approved ? 'approved' : 'changes'}
          </span>
          {!e.approved && e.feedback && <span className="feed-dim"> {e.feedback.split('\n')[0].slice(0, 140)}</span>}
        </div>
      )
    case 'ticket-done':
      return (
        <div className="feed-row">
          <span className="feed-id">#{e.id}</span>{' '}
          <span className={`tool-chip ${e.terminal === 'done' ? 'ok' : e.terminal === 'review' ? 'awaiting' : 'err'}`}>{e.terminal}</span>
        </div>
      )
    case 'ticket-failed':
      return (
        <div className="feed-row feed-err">
          <span className="feed-id">#{e.id}</span> failed: {e.error}
        </div>
      )
    case 'stopped':
      return <div className="feed-row feed-strong">■ stopped — {e.reason}</div>
    case 'paused':
      return <div className="feed-row">⏸ paused</div>
    case 'notice':
      return <div className="feed-row feed-dim">{e.text}</div>
    case 'error':
      return <div className="feed-row feed-err">⚠ {e.message}</div>
    case 'log':
      return <div className="feed-row feed-dim">{e.text}</div>
    case 'agent-event': {
      const ev = e.event
      if (ev.type === 'tool-call-proposed')
        return (
          <div className="feed-row feed-agent">
            <span className="feed-id">#{e.id}</span> ▸ {verbOf(ev.name)} <span className="feed-dim">{shortArg(argTarget(ev.args))}</span>
          </div>
        )
      if (ev.type === 'tool-result')
        return (
          <div className="feed-row feed-agent">
            <span className="feed-id">#{e.id}</span> <span className={`tool-chip ${ev.ok ? 'ok' : 'err'}`}>{ev.ok ? 'ok' : 'failed'}</span>
          </div>
        )
      if (ev.type === 'notice')
        return (
          <div className="feed-row feed-dim">
            <span className="feed-id">#{e.id}</span> {ev.text}
          </div>
        )
      return null
    }
    default:
      return null
  }
}
