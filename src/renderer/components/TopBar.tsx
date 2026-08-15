import { useEffect, useRef, useState } from 'react'
import type { ConnectionStatus } from '../../shared/ipc-types'
import type { Connection } from '../../shared/domain-types'
import type { DockTab } from './RightDock'
import { Icon, type IconName } from './Icon'

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  ok: 'connected',
  'no-model': 'no model',
  unreachable: 'offline',
  auth: 'check key',
  checking: 'checking...'
}

const TOGGLES: { tab: DockTab; label: string; icon: IconName }[] = [
  { tab: 'needs', label: 'Needs Me', icon: 'shield' },
  { tab: 'git', label: 'Review', icon: 'clipboard-check' },
  { tab: 'preview', label: 'Preview', icon: 'eye' },
  { tab: 'tasks', label: 'Tasks', icon: 'terminal' }
]

export function TopBar(props: {
  cwd: string | null
  models: string[]
  model: string
  connections: Connection[]
  activeConnectionId: string
  status: ConnectionStatus
  collapsed: boolean
  tokensUsed: number
  tokenLimit: number
  dock: DockTab | null
  runningTasks: number
  attentionCount: number
  onToggleDock: (t: DockTab) => void
  onExpandSidebar: () => void
  onPickDir: () => void
  onChangeModel: (m: string) => void
  onChangeConnection: (id: string) => void
}) {
  const activeConnection = props.connections.find((c) => c.id === props.activeConnectionId)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!moreOpen) return
    const close = (event: MouseEvent): void => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [moreOpen])

  const openDock = (tab: DockTab): void => {
    props.onToggleDock(tab)
    setMoreOpen(false)
  }

  return (
    <div className="topbar">
      <div className="topbar-inner">
      {props.collapsed && (
        <button className="icon-btn" onClick={props.onExpandSidebar} title="Open sidebar (Ctrl+B)" aria-label="Open sidebar">
          <Icon name="menu" size={16} />
        </button>
      )}

      <button
        className="tb-folder"
        type="button"
        onClick={props.onPickDir}
        title={props.cwd ?? 'Choose a working folder'}
        aria-label={props.cwd ? `Working folder: ${basename(props.cwd)}` : 'Choose working folder'}
      >
        <Icon name="folder" size={14} className="folder-icon" />
        <span className="folder-text">{props.cwd ? basename(props.cwd) : 'Choose folder'}</span>
        <Icon name="chevron-down" size={12} className="folder-caret" />
      </button>

      <div
        className={`runtime-cluster status-${props.status}`}
        title={`Runtime: ${activeConnection?.label ?? 'Backend'} / ${props.model || 'No model selected'} (${STATUS_TEXT[props.status]})`}
      >
        <span className="runtime-mark" aria-hidden="true">
          <Icon name="cpu" size={14} />
        </span>
        <label className="runtime-field runtime-conn">
          <span className="runtime-label">Backend</span>
          {props.connections.length > 1 ? (
            <select
              className="runtime-select"
              value={props.activeConnectionId}
              onChange={(e) => props.onChangeConnection(e.target.value)}
              aria-label="Active backend connection"
            >
              {props.connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : (
            <span className="runtime-value">{activeConnection?.label ?? 'Backend'}</span>
          )}
        </label>
        <span className="runtime-split" aria-hidden="true" />
        <label className="runtime-field runtime-model">
          <span className="runtime-label">Model</span>
          <select className="runtime-select" value={props.model} onChange={(e) => props.onChangeModel(e.target.value)} aria-label="Active model">
            {props.model === '' && <option value="">Select model...</option>}
            {props.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            {props.model !== '' && !props.models.includes(props.model) && (
              <option value={props.model}>{props.model} (not loaded)</option>
            )}
          </select>
        </label>
        <span className="runtime-health" role="status" aria-live="polite" aria-label={`Connection status: ${STATUS_TEXT[props.status]}`}>
          <span className="status-dot" aria-hidden="true" />
          <span className="runtime-health-text">{STATUS_TEXT[props.status]}</span>
        </span>
      </div>

      <span className="tb-spacer" />

      {props.tokensUsed > 0 && <TokenMeter used={props.tokensUsed} limit={props.tokenLimit} />}

      <div className="panel-toggles">
        {TOGGLES.map(({ tab, label, icon }) => (
          <button
            key={tab}
            type="button"
            className={`panel-toggle ${props.dock === tab ? 'active' : ''}`}
            onClick={() => props.onToggleDock(tab)}
            title={label}
            aria-pressed={props.dock === tab}
            aria-label={toggleLabel(label, tab, props.attentionCount, props.runningTasks)}
          >
            <Icon name={icon} size={13} />
            {label}
            {tab === 'needs' && props.attentionCount > 0 && <span className="toggle-badge" aria-hidden="true">{props.attentionCount}</span>}
            {tab === 'tasks' && props.runningTasks > 0 && <span className="toggle-badge" aria-hidden="true">{props.runningTasks}</span>}
          </button>
        ))}
      </div>

      <div className="panel-overflow" ref={moreRef}>
        <button
          className={`icon-btn panel-overflow-trigger ${moreOpen ? 'active' : ''}`}
          type="button"
          onClick={() => setMoreOpen((open) => !open)}
          aria-expanded={moreOpen}
          aria-haspopup="menu"
          aria-label="Open workspace panels"
          title="Workspace panels"
        >
          <Icon name="more-horizontal" size={16} />
          {(props.attentionCount > 0 || props.runningTasks > 0) && <span className="panel-overflow-dot" aria-hidden="true" />}
        </button>
        {moreOpen && (
          <div className="panel-overflow-menu" role="menu" aria-label="Workspace panels">
            {TOGGLES.map(({ tab, label, icon }) => (
              <button
                key={tab}
                type="button"
                role="menuitem"
                className={`panel-overflow-item ${props.dock === tab ? 'active' : ''}`}
                onClick={() => openDock(tab)}
              >
                <Icon name={icon} size={14} />
                <span>{label}</span>
                {tab === 'needs' && props.attentionCount > 0 && <b>{props.attentionCount}</b>}
                {tab === 'tasks' && props.runningTasks > 0 && <b>{props.runningTasks}</b>}
              </button>
            ))}
          </div>
        )}
      </div>
      </div>
    </div>
  )
}

function TokenMeter({ used, limit }: { used: number; limit: number }) {
  const pct = Math.min(100, Math.round((used / Math.max(1, limit)) * 100))
  const tone = pct >= 88 ? 'danger' : pct >= 72 ? 'warn' : pct >= 42 ? 'active' : 'cool'
  return (
    <span
      className={`token-meter token-${tone}`}
      title={`~${used.toLocaleString()} of ${limit.toLocaleString()} context tokens`}
    >
      <span className="token-readout">
        <span className="token-label">Context</span>
        <span className="token-text">
          {fmtK(used)} / {fmtK(limit)}
        </span>
      </span>
      <span className="token-bar" aria-hidden="true">
        <span className="token-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="token-percent">{pct}%</span>
    </span>
  )
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k` : String(n)
}

function toggleLabel(label: string, tab: DockTab, attentionCount: number, runningTasks: number): string {
  if (tab === 'needs' && attentionCount > 0) return `${label}, ${attentionCount} item${attentionCount === 1 ? '' : 's'} need attention`
  if (tab === 'tasks' && runningTasks > 0) return `${label}, ${runningTasks} running task${runningTasks === 1 ? '' : 's'}`
  return label
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}
