import { useEffect, useState } from 'react'
import { useLoopBoard } from '../hooks/useLoopBoard'
import type { BoardCounts, BoardTicketRow } from '../../shared/ipc-types'
import { cardState, type BoardLane } from '../loopBoard'

type Summaries = Record<number, string>
type MissionSuggestion = { project: string; counts: BoardCounts }

function missionKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ') || 'project'
}

function suggestionLabel(c: BoardCounts): string {
  const active = c.ready + c.in_progress + c.review + c.blocked
  if (active > 0) return `${active} active / ${c.total} total`
  return `${c.total} archived`
}

/** Native, themed replacement for the embedded board webview. State-grouped lanes are the run list;
 *  styled entirely with design tokens so it follows light/dark mode (the iframe never could). */
export function LoopBoard({
  project,
  activeId,
  selectedId,
  summaries,
  onOpenProject,
  onSelect
}: {
  project: string
  activeId?: number
  selectedId?: number
  summaries?: Summaries
  onOpenProject?: (project: string) => void
  onSelect?: (t: BoardTicketRow) => void
}) {
  const { lanes, error, loading } = useLoopBoard(project)
  const empty = lanes.every((l) => l.tickets.length === 0)
  const [suggestions, setSuggestions] = useState<MissionSuggestion[]>([])

  useEffect(() => {
    let live = true
    const load = async (): Promise<void> => {
      if (!empty || loading || error) {
        setSuggestions([])
        return
      }
      try {
        const activeKey = missionKey(project)
        const names = (await window.api.loopBoard.projects()).filter((p) => missionKey(p) !== activeKey)
        const rows = await Promise.all(
          names.map(async (p) => {
            const board = await window.api.loopBoard.list(p)
            return { project: p, counts: board.counts }
          })
        )
        if (!live) return
        setSuggestions(
          rows
            .filter((r) => r.counts.total > 0)
            .sort((a, b) => {
              const activeA = a.counts.ready + a.counts.in_progress + a.counts.review + a.counts.blocked
              const activeB = b.counts.ready + b.counts.in_progress + b.counts.review + b.counts.blocked
              return activeB - activeA || b.counts.total - a.counts.total || a.project.localeCompare(b.project)
            })
            .slice(0, 4)
        )
      } catch {
        if (live) setSuggestions([])
      }
    }
    void load()
    const off = window.api.loopBoard.onChange(() => void load())
    return () => {
      live = false
      off()
    }
  }, [project, empty, loading, error])

  return (
    <div className="board">
      {error && <div className="board-error">board unreachable — {error}</div>}
      {loading && empty && !error && <div className="board-empty">loading...</div>}
      {!loading && empty && !error && (
        <div className="board-empty board-empty-run">
          <span className="board-empty-graphic" aria-hidden="true">
            <svg className="board-empty-svg" viewBox="0 0 210 112" focusable="false">
              <path className="board-empty-grid" d="M20 22H190M20 56H190M20 90H190M48 14V98M105 14V98M162 14V98" />
              <path className="board-empty-route" d="M24 86C54 44 82 42 104 58S152 88 184 28" pathLength={100} />
              <rect className="board-empty-node muted" x="34" y="72" width="34" height="18" rx="4" />
              <rect className="board-empty-node" x="86" y="48" width="38" height="22" rx="5" />
              <rect className="board-empty-node muted" x="142" y="24" width="34" height="18" rx="4" />
              <circle className="board-empty-pulse" cx="105" cy="59" r="4" />
            </svg>
          </span>
          <span className="board-empty-title">No tickets in "{project}".</span>
          {suggestions.length > 0 ? (
            <>
              <span className="board-empty-sub">Cards already exist in these missions.</span>
              <div className="board-empty-matches">
                {suggestions.map((s) => (
                  <button key={s.project} className="board-empty-match" onClick={() => onOpenProject?.(s.project)}>
                    <span>{s.project}</span>
                    <b>{suggestionLabel(s.counts)}</b>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <span className="board-empty-sub">Start a run to populate the board lanes.</span>
          )}
        </div>
      )}
      {!empty && (
        <div className="board-lanes">
          {lanes.map((lane) => (
            <Lane
              key={lane.key}
              lane={lane}
              total={lanes.reduce((sum, l) => sum + l.tickets.length, 0)}
              activeId={activeId}
              selectedId={selectedId}
              summaries={summaries}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const DONE_COLLAPSE = 5

function Lane({
  lane,
  total,
  activeId,
  selectedId,
  summaries,
  onSelect
}: {
  lane: BoardLane
  total: number
  activeId?: number
  selectedId?: number
  summaries?: Summaries
  onSelect?: (t: BoardTicketRow) => void
}) {
  const [expanded, setExpanded] = useState(false)
  if (lane.tickets.length === 0) return null // hide empty lanes so the board stays tight
  // Old done collapses to "…N more" so the spine isn't dominated by finished work.
  const collapsed = lane.key === 'done' && lane.tickets.length > DONE_COLLAPSE && !expanded
  const shown = collapsed ? lane.tickets.slice(0, DONE_COLLAPSE) : lane.tickets
  const hidden = lane.tickets.length - shown.length
  const pct = total > 0 ? Math.max(6, Math.round((lane.tickets.length / total) * 100)) : 0
  return (
    <div className={`board-lane lane-${lane.key}`}>
      <div className="board-lane-head">
        <span className="board-lane-mark" aria-hidden="true">
          <span className="board-lane-dot" />
        </span>
        <span className="board-lane-copy">
          <span className="board-lane-name">{lane.label}</span>
          <span className="board-lane-sub">{laneDescription(lane.key)}</span>
        </span>
        <span className="board-lane-n">{lane.tickets.length}</span>
      </div>
      <div className="board-lane-meter" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="board-lane-cards">
        {shown.map((t) => (
          <Card key={t.id} t={t} activeId={activeId} selectedId={selectedId} summary={summaries?.[t.id]} onSelect={onSelect} />
        ))}
        {hidden > 0 && (
          <button className="board-more" onClick={() => setExpanded(true)}>
            …{hidden} more
          </button>
        )}
      </div>
    </div>
  )
}

function Card({
  t,
  activeId,
  selectedId,
  summary,
  onSelect
}: {
  t: BoardTicketRow
  activeId?: number
  selectedId?: number
  summary?: string
  onSelect?: (t: BoardTicketRow) => void
}) {
  const st = cardState(t, activeId)
  const deps = t.deps?.length ?? 0
  const blockedBy = t.blocked_by?.length ?? 0
  const cls = `board-card state-card-${st.kind} ${st.kind === 'working' ? 'active' : ''} ${t.id === selectedId ? 'selected' : ''}`
  return (
    <div
      className={cls}
      role="button"
      tabIndex={0}
      aria-pressed={t.id === selectedId}
      onClick={() => onSelect?.(t)}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault()
          onSelect?.(t)
        }
      }}
    >
      <div className="board-card-top">
        <span className="board-card-id">#{t.id}</span>
        <span className={`board-card-state state-${st.kind}`}>{st.label}</span>
        {st.kind === 'working' && (
          <button
            className="board-card-stop"
            title="Stop this ticket"
            aria-label={`Stop ticket #${t.id}`}
            onClick={(ev) => {
              ev.stopPropagation()
              void window.api.loop.ticketAction({ id: t.id, action: 'stop' })
            }}
          >
            ■
          </button>
        )}
      </div>
      <span className="board-card-title">{t.title}</span>
      <div className="board-card-meta">
        {typeof t.priority === 'number' && <span>p{t.priority}</span>}
        {deps > 0 && <span>{deps} dep{deps === 1 ? '' : 's'}</span>}
        {blockedBy > 0 && <span className="warn">{blockedBy} blocked</span>}
        {t.check && <span>check</span>}
      </div>
      {summary && <span className="board-card-summary">{summary}</span>}
    </div>
  )
}

function laneDescription(key: BoardLane['key']): string {
  switch (key) {
    case 'review':
      return 'Needs judgement'
    case 'in_progress':
      return 'Live worker lane'
    case 'ready':
      return 'Runnable next'
    case 'blocked':
      return 'Waiting on deps'
    case 'done':
      return 'Archived wins'
  }
}
