import type { AllowList, ChatMessage } from '../shared/domain-types'
import type { AgentEvent } from '../shared/ipc-types'
import { loadSession, saveTranscript } from './store/sessions'

const SAVE_DELAY_MS = 500

export interface LiveTranscriptSource {
  getHistory(): ChatMessage[]
  getAllowList(): AllowList
  getTokenScale(): number
}

/** Inner-turn checkpoints that mean the live transcript has gained a complete, persistable unit. The
 *  run-level turn-done event remains a checkpoint as a final trailing save. */
type TranscriptCheckpointEvent = Extract<
  AgentEvent,
  { type: 'assistant-message-done' | 'tool-result' | 'turn-done' }
>

export function isTranscriptCheckpointEvent(event: AgentEvent): event is TranscriptCheckpointEvent {
  return event.type === 'assistant-message-done' || event.type === 'tool-result' || event.type === 'turn-done'
}

/** Trailing per-session transcript persistence. Rewind generations prevent an older completed turn from
 *  restoring pre-rewind history when its timer eventually fires. */
export function createTurnTranscriptSaver(
  getLiveSession: (sessionId: string) => LiveTranscriptSource | undefined,
  delayMs = SAVE_DELAY_MS
): {
  turnDone: (sessionId: string) => void
  historyRewound: (sessionId: string) => void
  cancel: (sessionId: string) => void
} {
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  const rewindGeneration = new Map<string, number>()

  const cancel = (sessionId: string): void => {
    const timer = pending.get(sessionId)
    if (timer) clearTimeout(timer)
    pending.delete(sessionId)
  }

  const turnDone = (sessionId: string): void => {
    cancel(sessionId)
    const generation = rewindGeneration.get(sessionId) ?? 0
    const timer = setTimeout(() => {
      pending.delete(sessionId)
      if ((rewindGeneration.get(sessionId) ?? 0) !== generation) return
      const live = getLiveSession(sessionId)
      const persisted = loadSession(sessionId)
      if (!live || !persisted) return
      saveTranscript(sessionId, {
        cwd: persisted.cwd,
        mode: persisted.mode,
        messages: live.getHistory(),
        title: persisted.title,
        allowList: live.getAllowList(),
        tokenScale: live.getTokenScale()
      })
    }, delayMs)
    timer.unref()
    pending.set(sessionId, timer)
  }

  const historyRewound = (sessionId: string): void => {
    rewindGeneration.set(sessionId, (rewindGeneration.get(sessionId) ?? 0) + 1)
    cancel(sessionId)
  }

  return { turnDone, historyRewound, cancel }
}
