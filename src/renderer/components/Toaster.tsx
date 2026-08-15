import { useEffect, useState } from 'react'
import { subscribeToasts, dismissToast, type ToastItem } from '../toast'
import { Icon, type IconName } from './Icon'

const ICON: Record<ToastItem['kind'], IconName> = {
  success: 'check',
  error: 'x',
  info: 'sparkle'
}

export function Toaster() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  useEffect(() => subscribeToasts(setToasts), [])

  if (toasts.length === 0) return null
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role="status">
          <span className="toast-icon">
            <Icon name={ICON[t.kind]} size={13} />
          </span>
          <span className="toast-text">{t.text}</span>
          <button className="toast-close" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
