/**
 * Tiny dependency-free toast store. A module-level pub/sub so any module can
 * raise a toast (`toast.success('Saved')`) without prop-drilling a context.
 * `<Toaster/>` subscribes and renders the stack.
 */
export type ToastKind = 'success' | 'error' | 'info'

export interface ToastItem {
  id: string
  kind: ToastKind
  text: string
}

type Listener = (toasts: ToastItem[]) => void

let toasts: ToastItem[] = []
const listeners = new Set<Listener>()

function emit(): void {
  for (const l of listeners) l(toasts)
}

export function subscribeToasts(l: Listener): () => void {
  listeners.add(l)
  l(toasts)
  return () => {
    listeners.delete(l)
  }
}

export function dismissToast(id: string): void {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

function push(kind: ToastKind, text: string, ttl = 3200): string {
  const id = crypto.randomUUID()
  toasts = [...toasts, { id, kind, text }]
  emit()
  if (ttl > 0) setTimeout(() => dismissToast(id), ttl)
  return id
}

export const toast = {
  success: (text: string): string => push('success', text),
  error: (text: string): string => push('error', text, 5000),
  info: (text: string): string => push('info', text)
}
