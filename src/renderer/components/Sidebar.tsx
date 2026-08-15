import { useEffect, useMemo, useState } from 'react'
import type { SessionMeta, Theme } from '../../shared/domain-types'
import { Icon } from './Icon'
import { BrandMark } from './BrandMark'
import { AppViewTabs, type AppView } from './AppViewTabs'

interface Group {
  key: string
  name: string
  items: SessionMeta[]
  recent: number
}

// Codex-style: show ~6 sessions per project, then a "Show more" reveals the rest of that project.
const GROUP_CAP = 6

export function Sidebar(props: {
  sessions: SessionMeta[]
  activeId: string | null
  hasWorkspace: boolean
  theme: Theme
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onNew: () => void
  onOpenSettings: () => void
  onToggleTheme: () => void
  onCollapse: () => void
  appView: AppView
  onChangeView: (view: AppView) => void
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [bodyHits, setBodyHits] = useState<Map<string, string>>(new Map())

  const q = query.trim().toLowerCase()
  const groups = useMemo<Group[]>(() => {
    // Group by PROJECT (cwd) — Codex-style — so cross-project history reads as project workspaces, each a
    // collapsible group with its sessions nested + sorted by recency; projects themselves sort by latest activity.
    // (A single-folder user just gets one group; a multi-project user gets a real per-project breakdown.)
    const byProject = new Map<string, SessionMeta[]>()
    for (const s of props.sessions) {
      const titleMatch = !q || `${s.title} ${basename(s.cwd)}`.toLowerCase().includes(q)
      if (q && !titleMatch && !bodyHits.has(s.id)) continue
      const key = s.cwd || '(no folder)'
      const arr = byProject.get(key)
      if (arr) arr.push(s)
      else byProject.set(key, [s])
    }
    const out: Group[] = []
    for (const [key, items] of byProject) {
      items.sort((a, b) => b.updatedAt - a.updatedAt)
      out.push({ key, name: key === '(no folder)' ? 'No folder' : basename(key), items, recent: items[0]?.updatedAt ?? 0 })
    }
    out.sort((a, b) => b.recent - a.recent)
    return out
  }, [props.sessions, q, bodyHits])

  // Body search: when the query is set, also surface chats whose message content matches (debounced),
  // so a chat is findable by what it discussed — not just its title.
  useEffect(() => {
    if (q.length < 2) {
      setBodyHits(new Map())
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      window.api.sessions
        .search(q)
        .then((hits) => {
          if (!cancelled) setBodyHits(new Map(hits.map((h) => [h.id, h.snippet])))
        })
        .catch(() => {
          if (!cancelled) setBodyHits(new Map())
        })
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [q])

  function toggleGroup(key: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleExpand(key: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <BrandMark size={25} className="brand-mark" />
          <span className="brand-name">BasenjiCode</span>
        </div>
        <button className="icon-btn" onClick={props.onCollapse} title="Collapse sidebar (Ctrl+B)" aria-label="Collapse sidebar">
          <Icon name="chevrons-left" size={16} />
        </button>
      </div>

      <AppViewTabs view={props.appView} onChange={props.onChangeView} />

      <button className="new-chat" onClick={props.onNew}>
        <Icon name={props.hasWorkspace ? 'plus' : 'folder'} size={15} /> {props.hasWorkspace ? 'New chat' : 'Choose folder'}
      </button>

      <div className="sidebar-search">
        <Icon name="search" size={14} className="search-icon" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats"
          aria-label="Search chats"
        />
        <span className="kbd">Ctrl K</span>
      </div>

      <div className="session-list">
        {props.sessions.length === 0 && <div className="session-empty">No chats yet</div>}
        {props.sessions.length > 0 && groups.length === 0 && <div className="session-empty">No matches</div>}
        {groups.length > 0 && <div className="session-section-title">{q ? 'Matching projects' : 'Projects'}</div>}
        {groups.map((g) => {
          const isCollapsed = !q && collapsed.has(g.key)
          const showAll = !!q || expanded.has(g.key)
          const visible = showAll ? g.items : g.items.slice(0, GROUP_CAP)
          const hidden = g.items.length - visible.length
          return (
            <div key={g.key} className={`session-group ${isCollapsed ? 'collapsed' : ''}`}>
              <button className="group-head" onClick={() => toggleGroup(g.key)} title={g.key}>
                <Icon name="chevron-down" size={12} className="group-caret" />
                <span className="group-name">{g.name}</span>
                <span className="group-count">{g.items.length}</span>
              </button>
              <div className="group-items">
                {visible.map((s) => (
                  <div
                    key={s.id}
                    className={`session-item ${s.id === props.activeId ? 'active' : ''}`}
                    onClick={() => props.onSelect(s.id)}
                    role="button"
                    tabIndex={0}
                    aria-current={s.id === props.activeId}
                    onKeyDown={(e) => {
                      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault()
                        props.onSelect(s.id)
                      }
                    }}
                    title={s.title || 'Untitled'}
                  >
                    <div className="session-text">
                      <div className="session-title">{s.title || 'Untitled'}</div>
                      {q && bodyHits.get(s.id) && <div className="session-sub">{bodyHits.get(s.id)}</div>}
                    </div>
                    {confirmId === s.id ? (
                      <span className="session-confirm" onClick={(e) => e.stopPropagation()}>
                        <button
                          className="session-del danger"
                          title="Confirm delete"
                          aria-label="Confirm delete"
                          onClick={(e) => {
                            e.stopPropagation()
                            setConfirmId(null)
                            props.onDelete(s.id)
                          }}
                        >
                          <Icon name="check" size={14} />
                        </button>
                        <button
                          className="session-del"
                          title="Cancel"
                          aria-label="Cancel delete"
                          onClick={(e) => {
                            e.stopPropagation()
                            setConfirmId(null)
                          }}
                        >
                          <Icon name="x" size={14} />
                        </button>
                      </span>
                    ) : (
                      <>
                        <span className="session-time">{timeAgo(s.updatedAt)}</span>
                        <button
                          className="session-del"
                          title="Delete chat"
                          aria-label="Delete chat"
                          onClick={(e) => {
                            e.stopPropagation()
                            setConfirmId(s.id)
                          }}
                        >
                          <Icon name="x" size={14} />
                        </button>
                      </>
                    )}
                  </div>
                ))}
                {hidden > 0 && (
                  <button className="group-more" onClick={() => toggleExpand(g.key)}>
                    Show {hidden} more
                  </button>
                )}
                {hidden === 0 && expanded.has(g.key) && g.items.length > GROUP_CAP && (
                  <button className="group-more" onClick={() => toggleExpand(g.key)}>
                    Show less
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="sidebar-foot">
        <button
          className="foot-btn"
          onClick={props.onToggleTheme}
          aria-label={props.theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
        >
          <Icon name={props.theme === 'light' ? 'moon' : 'sun'} size={15} />
          {props.theme === 'light' ? 'Dark mode' : 'Light mode'}
        </button>
        <button className="foot-btn" onClick={props.onOpenSettings}>
          <Icon name="settings" size={15} /> Settings
        </button>
      </div>
    </div>
  )
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
