import type { AttentionItem } from './components/NeedsMePanel'

export interface AttentionNotificationSync {
  fresh: AttentionItem[]
  liveIds: Set<string>
}

/**
 * Return only newly-visible blockers, while replacing the caller's live-id set.
 * Dropping resolved ids matters: a backend that recovers and later goes offline
 * again should produce a new notification.
 */
export function syncAttentionNotifications(
  items: AttentionItem[],
  previouslyLiveIds: ReadonlySet<string>
): AttentionNotificationSync {
  const notifiable = items.filter((item) => item.notify)
  return {
    fresh: notifiable.filter((item) => !previouslyLiveIds.has(item.id)),
    liveIds: new Set(notifiable.map((item) => item.id))
  }
}

/** Best-effort native desktop notification for events that happen while BasenjiCode is unfocused. */
export function notifyWhenUnfocused(title: string, body: string, onClick?: () => void): void {
  const show = (): void => {
    // Permission prompts can resolve after the user has returned to the app.
    if (typeof document !== 'undefined' && document.hasFocus()) return
    const notification = new Notification(title, { body })
    if (onClick) {
      notification.onclick = () => {
        onClick()
        notification.close()
      }
    }
  }

  try {
    if (typeof document !== 'undefined' && document.hasFocus()) return
    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'granted') show()
    else if (Notification.permission !== 'denied') {
      void Notification.requestPermission().then((permission) => {
        if (permission === 'granted') show()
      }).catch(() => undefined)
    }
  } catch {
    // Some Linux notification daemons do not expose the API. Notifications are advisory.
  }
}
