export type AppView = 'chat' | 'loop' | 'hermes'

const VIEWS: AppView[] = ['chat', 'loop', 'hermes']

export function AppViewTabs({ view, onChange }: { view: AppView; onChange: (view: AppView) => void }) {
  return (
    <div
      className="sidebar-view-toggle"
      role="tablist"
      aria-label="Workspace view"
      onKeyDown={(event) => {
        const current = VIEWS.indexOf(view)
        let next = current
        if (event.key === 'ArrowRight') next = (current + 1) % VIEWS.length
        else if (event.key === 'ArrowLeft') next = (current - 1 + VIEWS.length) % VIEWS.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = VIEWS.length - 1
        else return
        event.preventDefault()
        onChange(VIEWS[next])
        requestAnimationFrame(() => document.getElementById(`workspace-tab-${VIEWS[next]}`)?.focus())
      }}
    >
      <button
        id="workspace-tab-chat"
        role="tab"
        aria-selected={view === 'chat'}
        aria-controls="workspace-panel-chat"
        tabIndex={view === 'chat' ? 0 : -1}
        className={`view-tab ${view === 'chat' ? 'active' : ''}`}
        onClick={() => onChange('chat')}
      >
        Chat
      </button>
      <button
        id="workspace-tab-loop"
        role="tab"
        aria-selected={view === 'loop'}
        aria-controls="workspace-panel-loop"
        tabIndex={view === 'loop' ? 0 : -1}
        className={`view-tab ${view === 'loop' ? 'active' : ''}`}
        title="Mission Control: watch autonomous runs drain tickets and background work"
        onClick={() => onChange('loop')}
      >
        Mission
      </button>
      <button
        id="workspace-tab-hermes"
        role="tab"
        aria-selected={view === 'hermes'}
        aria-controls="workspace-panel-hermes"
        tabIndex={view === 'hermes' ? 0 : -1}
        className={`view-tab ${view === 'hermes' ? 'active' : ''}`}
        title="Plan a goal into smaller work"
        onClick={() => onChange('hermes')}
      >
        Planner
      </button>
    </div>
  )
}
