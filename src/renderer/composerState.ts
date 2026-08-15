import type { ComposerSessionState, QueuedPrompt } from '../shared/domain-types'

export const EMPTY_COMPOSER_STATE: ComposerSessionState = { draft: '', images: [], queue: [] }

export function normalizeComposerState(value?: ComposerSessionState): ComposerSessionState {
  if (!value) return { ...EMPTY_COMPOSER_STATE }
  return {
    draft: value.draft ?? '',
    images: [...(value.images ?? [])],
    queue: (value.queue ?? []).map((entry) => ({ ...entry, images: entry.images ? [...entry.images] : undefined })),
    ...(value.editingQueueId && value.queue?.some((entry) => entry.id === value.editingQueueId)
      ? { editingQueueId: value.editingQueueId }
      : {})
  }
}

export function enqueuePrompt(
  state: ComposerSessionState,
  text: string,
  images: string[] = [],
  id: string = crypto.randomUUID(),
  createdAt: number = Date.now()
): ComposerSessionState {
  const entry: QueuedPrompt = {
    id,
    text: text.trim(),
    ...(images.length ? { images: [...images] } : {}),
    createdAt
  }
  return { ...state, draft: '', images: [], queue: [...state.queue, entry] }
}

export function updateQueuedPrompt(
  state: ComposerSessionState,
  id: string,
  text: string,
  images: string[] = []
): ComposerSessionState {
  return {
    draft: '',
    images: [],
    queue: state.queue.map((entry) =>
      entry.id === id
        ? { ...entry, text: text.trim(), ...(images.length ? { images: [...images] } : { images: undefined }) }
        : entry
    ),
    editingQueueId: undefined
  }
}

export function removeQueuedPrompt(state: ComposerSessionState, id: string): ComposerSessionState {
  return {
    ...state,
    queue: state.queue.filter((entry) => entry.id !== id),
    ...(state.editingQueueId === id ? { editingQueueId: undefined } : {})
  }
}

export function takeNextPrompt(
  state: ComposerSessionState
): { prompt: QueuedPrompt | null; state: ComposerSessionState } {
  const [prompt, ...queue] = state.queue
  if (prompt && prompt.id === state.editingQueueId) return { prompt: null, state }
  return { prompt: prompt ?? null, state: { ...state, queue } }
}

export function promptHistory(items: readonly { kind: string; text?: string }[]): string[] {
  const out: string[] = []
  for (const item of items) {
    if (item.kind !== 'user' || !item.text?.trim()) continue
    const text = item.text.trim()
    if (out[out.length - 1] !== text) out.push(text)
  }
  return out
}
