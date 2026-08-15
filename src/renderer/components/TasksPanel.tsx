import { useState } from 'react'
import type { BgTask } from '../../shared/ipc-types'

export function TasksPanel({ tasks, onStop }: { tasks: BgTask[]; onStop: (id: string) => void }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const running = tasks.filter((t) => t.status === 'running').length
  const latest = tasks.find((t) => t.status === 'running') ?? tasks[0]

  return (
    <div className="panel tasks-panel">
      <div className={`task-scope ${running > 0 ? 'running' : tasks.length > 0 ? 'idle' : 'empty'}`}>
        <svg className="task-scope-art" viewBox="0 0 190 74" aria-hidden="true" focusable="false">
          <path className="task-scope-grid" d="M18 18H172M18 37H172M18 56H172M45 10V64M95 10V64M145 10V64" />
          <path className="task-scope-line" d="M22 53C48 18 74 20 96 38S142 61 168 18" />
          <circle className="task-scope-node start" cx="22" cy="53" r="4" />
          <circle className="task-scope-node mid" cx="96" cy="38" r="5" />
          <circle className="task-scope-node end" cx="168" cy="18" r="4" />
          {running > 0 && <circle className="task-scope-pulse" cx="96" cy="38" r="10" />}
        </svg>
        <div className="task-scope-copy">
          <span>{running > 0 ? 'Running' : tasks.length > 0 ? 'Idle' : 'Standby'}</span>
          <b>{running} active / {tasks.length} total</b>
          <small>{latest?.command ?? 'No background process'}</small>
        </div>
      </div>
      {tasks.length === 0 && (
        <div className="panel-empty">
          No background tasks.
          <br />
          Ask the agent to start a dev server or watcher.
        </div>
      )}
      {tasks.map((t) => (
        <div key={t.id} className={`bgtask ${t.status}`}>
          <div className="bgtask-head" onClick={() => setOpenId(openId === t.id ? null : t.id)}>
            <span className={`bgtask-dot ${t.status}`} />
            <span className="bgtask-cmd">{t.command}</span>
            <span className="bgtask-status">
              {t.status === 'running' ? 'running' : t.status === 'killed' ? 'stopped' : `exit ${t.code}`}
            </span>
            {t.status === 'running' && (
              <button
                className="bgtask-stop"
                onClick={(e) => {
                  e.stopPropagation()
                  onStop(t.id)
                }}
              >
                Stop
              </button>
            )}
          </div>
          {openId === t.id && <pre className="bgtask-output">{t.outputTail || '(no output yet)'}</pre>}
        </div>
      ))}
    </div>
  )
}
