import { useEffect, useMemo, useState } from 'react'
import type { Theme } from '../../shared/domain-types'
import type { BoardCounts, RaidFolderInfo } from '../../shared/ipc-types'
import { Icon } from './Icon'
import { BrandMark } from './BrandMark'
import { AppViewTabs, type AppView } from './AppViewTabs'

/** Loop-mode sidebar: lists LOOPS (board projects), not chat sessions. Swapped in for <Sidebar> when the
 *  Chat/Loop toggle is on Loop, so clicking a row actually drives the board + detail panes. */
export function LoopsRail(props: {
  project: string
  theme: Theme
  onSelect: (project: string) => void
  onOpenSettings: () => void
  onToggleTheme: () => void
  onCollapse: () => void
  appView: AppView
  onChangeView: (view: AppView) => void
}) {
  const [projects, setProjects] = useState<string[]>([])
  const [counts, setCounts] = useState<Record<string, BoardCounts>>({})
  const [ticketIndex, setTicketIndex] = useState<Record<string, string>>({})
  const [folders, setFolders] = useState<Record<string, RaidFolderInfo>>({}) // raid → {cwd, group} for repo grouping
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const searchKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

  // Load the project list + per-project counts; refresh on any board change.
  useEffect(() => {
    let live = true
    const load = async (): Promise<void> => {
      try {
        const names = await window.api.loopBoard.projects()
        // Keep the active loop visible even before it has any tickets.
        const activeKey = searchKey(props.project)
        const all = props.project && !names.some((p) => searchKey(p) === activeKey) ? [props.project, ...names] : names
        if (!live) return
        setProjects(all)
        const boards = await Promise.all(all.map(async (p) => [p, await window.api.loopBoard.list(p)] as const))
        if (live) {
          setCounts(Object.fromEntries(boards.map(([p, b]) => [p, b.counts])))
          setTicketIndex(Object.fromEntries(boards.map(([p, b]) => [p, b.tickets.map((t) => `#${t.id} ${t.title}`).join(' ')])))
        }
        try {
          const fmap = await window.api.loopBoard.folders(all)
          if (live) setFolders(fmap)
        } catch {
          /* folder resolution is best-effort — the rail still works ungrouped */
        }
      } catch {
        // Board down — keep at least the active loop selectable.
        if (live && props.project) setProjects((cur) => (cur.length ? cur : [props.project]))
      }
    }
    void load()
    const off = window.api.loopBoard.onChange(() => void load())
    return () => {
      live = false
      off()
    }
  }, [props.project])

  function openNewLoop(): void {
    setName('')
    setCreating(true)
  }
  function matchingProject(raw: string): string | undefined {
    const k = searchKey(raw)
    if (!k) return undefined
    return projects.find((p) => searchKey(p) === k)
  }
  function submitNewLoop(): void {
    const n = name.trim()
    if (!n) return
    const existing = matchingProject(n)
    setCreating(false)
    setName('')
    props.onSelect(existing ?? n)
  }

  // Codex-style grouping: raids are grouped by the real project folder (repo) they operate in — many raids can share
  // one repo, and they nest under that folder's header. Within a group, live runs float to the top (pulsing dot).
  const basename = (p: string): string => {
    const parts = (p || '').split(/[\\/]+/).filter(Boolean)
    return parts[parts.length - 1] ?? ''
  }
  const projectMatches = (p: string, q: string): boolean => {
    const needle = searchKey(q)
    if (!needle) return true
    const folder = folders[p]?.cwd ?? ''
    const hay = `${searchKey(p)} ${searchKey(folder)} ${searchKey(basename(folder))} ${searchKey(ticketIndex[p] ?? '')}`
    return needle.split(/\s+/).every((part) => hay.includes(part))
  }
  const groups = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const p of projects) {
      const f = folders[p]?.group ?? ''
      const arr = m.get(f)
      if (arr) arr.push(p)
      else m.set(f, [p])
    }
    const groupActive = (ps: string[]): boolean => ps.some((p) => (counts[p]?.in_progress ?? 0) > 0)
    return [...m.entries()]
      .map(([folder, ps]) => ({
        folder,
        projects: ps
          .slice()
          .sort((x, y) => ((counts[y]?.in_progress ?? 0) > 0 ? 1 : 0) - ((counts[x]?.in_progress ?? 0) > 0 ? 1 : 0) || x.localeCompare(y))
      }))
      .sort((a, b) => {
        const aa = groupActive(a.projects) ? 0 : 1
        const bb = groupActive(b.projects) ? 0 : 1
        if (aa !== bb) return aa - bb
        return basename(a.folder).toLowerCase().localeCompare(basename(b.folder).toLowerCase())
      })
  }, [projects, folders, counts])
  const visibleGroups = useMemo(() => {
    const q = query.trim()
    if (!q) return groups
    return groups
      .map((g) => ({ ...g, projects: g.projects.filter((p) => projectMatches(p, q)) }))
      .filter((g) => g.projects.length > 0)
  }, [groups, query, folders, ticketIndex])
  const visibleProjects = visibleGroups.flatMap((g) => g.projects)

  // Point a raid at its real project repo — many raids can then group under one folder. Persisted in settings.raidFolders.
  async function assignFolder(project: string): Promise<void> {
    const dir = await window.api.dialog.pickDirectory()
    if (!dir) return
    const s = await window.api.settings.get()
    const next = { ...(s.raidFolders ?? {}), [project]: dir }
    await window.api.settings.set({ raidFolders: next })
    try {
      const fmap = await window.api.loopBoard.folders(projects.length ? projects : [project])
      setFolders(fmap)
    } catch {
      /* ignore — the next board change refreshes folders anyway */
    }
  }

  const renderRow = (p: string) => {
    const c = counts[p]
    const isActive = searchKey(p) === searchKey(props.project)
    const working = !!c && c.in_progress > 0
    return (
      <div className="loop-row-wrap" key={p}>
        <button
          className={`loop-row ${isActive ? 'active' : ''}`}
          onClick={() => props.onSelect(p)}
          aria-current={isActive ? 'true' : undefined}
        >
          <span className={`loop-dot ${working ? 'working' : ''}`} aria-hidden="true" />
          <span className="loop-name">{p}</span>
          {c && (
            <span className="loop-counts">
              {c.review > 0 && <span className="loop-review">{c.review}</span>}
              {c.ready}/{c.total}
            </span>
          )}
        </button>
        <button
          className="loop-assign"
          title={folders[p]?.cwd ? `Folder: ${folders[p].cwd}\nClick to change` : "Set this run's project folder"}
          aria-label={`Set ${p}'s project folder`}
          onClick={() => void assignFolder(p)}
        >
          <Icon name="folder" size={12} />
        </button>
      </div>
    )
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

      <button className="new-chat" onClick={openNewLoop}>
        <Icon name="plus" size={15} /> New mission
      </button>

      <div className="sidebar-search mission-search">
        <Icon name="search" size={14} className="search-icon" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            const first = visibleProjects[0]
            if (first) {
              props.onSelect(first)
              setQuery('')
            } else if (query.trim()) {
              setName(query.trim())
              setCreating(true)
            }
          }}
          placeholder="Find mission or cards..."
          spellCheck={false}
        />
        {query && (
          <button className="mission-search-clear" onClick={() => setQuery('')} aria-label="Clear mission search">
            <Icon name="x" size={12} />
          </button>
        )}
      </div>

      <div className="loops-list">
        {projects.length === 0 && <div className="loops-empty">No runs yet.</div>}
        {projects.length > 0 && visibleGroups.length === 0 && (
          <div className="loops-empty">
            No missions match "{query.trim()}". Press Enter to create it.
          </div>
        )}
        {visibleGroups.map((g) => (
          <div className="loop-folder-group" key={g.folder || '∅'}>
            <div className="loop-folder-head" title={g.folder || 'No folder set — assign one with the folder button'}>
              <Icon name="folder" size={12} />
              <span className="loop-folder-name">{basename(g.folder) || 'Unsorted'}</span>
              <span className="loop-section-count">{g.projects.length}</span>
            </div>
            {g.projects.map(renderRow)}
          </div>
        ))}
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

      {creating && (
        <div className="modal-backdrop" onMouseDown={() => setCreating(false)}>
          <div
            className="loop-new-modal"
            role="dialog"
            aria-modal="true"
            aria-label="New mission"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="loop-new-title">New mission</div>
            <input
              className="loop-new-input"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitNewLoop()
                else if (e.key === 'Escape') setCreating(false)
              }}
              placeholder="run project name..."
              spellCheck={false}
            />
            {!!name.trim() && matchingProject(name.trim()) && (
              <div className="loop-new-hint">Opens the existing "{matchingProject(name.trim())}" mission.</div>
            )}
            <div className="loop-new-actions">
              <button className="btn" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={!name.trim()} onClick={submitNewLoop}>
                {name.trim() && matchingProject(name.trim()) ? 'Open' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
