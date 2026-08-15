import { useState, useEffect } from 'react'
import type { TodoItem } from '../../shared/domain-types'
import { Icon } from './Icon'

const HIDE_DELAY_MS = 3500

/** The agent's working checklist (todo_write), pinned above the composer while non-empty. */
export function TodoList({
  todos,
  running = false,
  activitySinceUpdate = 0
}: {
  todos: TodoItem[]
  running?: boolean
  activitySinceUpdate?: number
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [hidden, setHidden] = useState(false)

  const done = todos.filter((t) => t.status === 'completed').length
  const active = todos.find((t) => t.status === 'in_progress')
  const allDone = todos.length > 0 && done === todos.length
  const stale = running && !allDone && activitySinceUpdate > 0

  useEffect(() => {
    if (allDone) {
      const t = setTimeout(() => setHidden(true), HIDE_DELAY_MS)
      return () => clearTimeout(t)
    }
    setHidden(false)
  }, [allDone])

  if (!todos.length || hidden) return null

  return (
    <div className="todo-wrap">
      <div className={`todo-card ${allDone ? 'all-done' : ''} ${stale ? 'stale' : ''}`}>
        <button
          className="todo-head"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          title={collapsed ? 'Show tasks' : 'Hide tasks'}
        >
          <Icon name="clipboard-check" size={14} />
          <span className="todo-title">Tasks</span>
          <span className="todo-progress">
            {done}/{todos.length}
          </span>
          {stale && (
            <span className="todo-sync" title="The agent has made changes since it last refreshed this task list.">
              Needs refresh: {activitySinceUpdate} change{activitySinceUpdate === 1 ? '' : 's'}
            </span>
          )}
          {collapsed && active && <span className="todo-current">{active.content}</span>}
          <span className="todo-spacer" />
          <Icon name={collapsed ? 'chevron-down' : 'chevron-up'} size={14} />
        </button>
        {!collapsed && (
          <ul className="todo-items">
            {todos.map((t, i) => (
              <li key={i} className={`todo-item ${t.status}`}>
                <span className="todo-mark" aria-hidden="true">
                  {t.status === 'completed' && <Icon name="check" size={12} />}
                </span>
                <span className="todo-text">{t.content}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
