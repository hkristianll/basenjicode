import type { BgTask } from '../../shared/ipc-types'
import { Icon, type IconName } from './Icon'
import { PreviewPanel, type PreviewTarget } from './PreviewPanel'
import { TasksPanel } from './TasksPanel'
import { PlanPanel } from './PlanPanel'
import { GitPanel, type SnapshotInfo } from './GitPanel'
import { NeedsMePanel, type AttentionItem } from './NeedsMePanel'

export type DockTab = 'preview' | 'tasks' | 'plan' | 'git' | 'needs'

const PANEL_LABEL: Record<DockTab, string> = {
  needs: 'Needs Me',
  preview: 'Preview',
  tasks: 'Tasks',
  plan: 'Response',
  git: 'Review'
}

const DOCK_NAV: { tab: DockTab; label: string; icon: IconName }[] = [
  { tab: 'needs', label: 'Needs Me', icon: 'shield' },
  { tab: 'git', label: 'Review', icon: 'clipboard-check' },
  { tab: 'preview', label: 'Preview', icon: 'eye' },
  { tab: 'tasks', label: 'Tasks', icon: 'terminal' },
  { tab: 'plan', label: 'Response', icon: 'file-text' }
]

export function RightDock(props: {
  tab: DockTab
  onTab: (t: DockTab) => void
  onClose: () => void
  tasks: BgTask[]
  onStopTask: (id: string) => void
  sessionId: string | null
  planText: string
  snapshot?: SnapshotInfo
  onUndo?: (turnId: string) => void
  onFixDiffSelection?: (path: string, selection: string) => void
  previewTarget?: PreviewTarget
  attentionItems: AttentionItem[]
  onDismissAttention?: (id: string) => void
  width?: number
}) {
  const running = props.tasks.filter((t) => t.status === 'running').length
  const attentionCount = props.attentionItems.length
  const activeTabId = `dock-tab-${props.tab}`
  const activePanelId = `dock-panel-${props.tab}`
  return (
    <aside
      className="right-dock"
      role="complementary"
      aria-labelledby="dock-current-title"
      style={props.width ? { flex: `0 0 ${props.width}px`, width: props.width } : undefined}
    >
      <div className="dock-tabs">
        <span className="dock-title" id="dock-current-title">{PANEL_LABEL[props.tab]}</span>
        {props.tab === 'tasks' && running > 0 && <span className="dock-badge" aria-hidden="true">{running}</span>}
        {props.tab === 'needs' && attentionCount > 0 && <span className="dock-badge" aria-hidden="true">{attentionCount}</span>}
        <span className="dock-spacer" />
        <div className="dock-switcher" role="tablist" aria-label="Dock panels">
          {DOCK_NAV.map(({ tab, label, icon }) => (
            <button
              key={tab}
              id={`dock-tab-${tab}`}
              className={`dock-switch ${props.tab === tab ? 'active' : ''}`}
              type="button"
              onClick={() => props.onTab(tab)}
              title={label}
              aria-label={label}
              aria-selected={props.tab === tab}
              aria-controls={props.tab === tab ? activePanelId : undefined}
              role="tab"
            >
              <Icon name={icon} size={13} />
              {tab === 'needs' && attentionCount > 0 && <span className="dock-switch-dot" aria-hidden="true">{attentionCount}</span>}
              {tab === 'tasks' && running > 0 && <span className="dock-switch-dot" aria-hidden="true">{running}</span>}
            </button>
          ))}
        </div>
        <button className="icon-btn" onClick={props.onClose} title="Close panel" aria-label="Close panel">
          <Icon name="x" size={15} />
        </button>
      </div>
      <div className="dock-panel-body" id={activePanelId} role="tabpanel" aria-labelledby={activeTabId}>
        {props.tab === 'preview' && <PreviewPanel target={props.previewTarget} />}
        {props.tab === 'tasks' && <TasksPanel tasks={props.tasks} onStop={props.onStopTask} />}
        {props.tab === 'plan' && <PlanPanel sessionId={props.sessionId} planText={props.planText} />}
        {props.tab === 'git' && (
          <GitPanel
            sessionId={props.sessionId}
            snapshot={props.snapshot}
            onUndo={props.onUndo}
            onFixSelection={props.onFixDiffSelection}
          />
        )}
        {props.tab === 'needs' && <NeedsMePanel items={props.attentionItems} onDismiss={props.onDismissAttention} />}
      </div>
    </aside>
  )
}
