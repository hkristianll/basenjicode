// Long-run reset for the persistent group-manager (Brooke) session. loop.ts compaction bounds her history, but the
// generic conversation summary is lossy for a MANAGER — her durable state is the BOARD + team memory, not chat. So
// past a threshold we rebuild her on a compact re-seed (the goal + "check the board"), shedding chatter while keeping
// the substance she can re-derive. These are the PURE pieces (estimate + seed); ipc.ts owns the AgentSession rebuild.
import type { ChatMessage } from '../../shared/domain-types'

/** Rough token estimate (chars/4) of a chat history — used ONLY as a threshold to decide a reset, not for budgeting. */
export function estimateHistoryTokens(history: ChatMessage[]): number {
  return Math.ceil(history.reduce((n, m) => n + (m.content?.length ?? 0), 0) / 4)
}

/**
 * The compact re-seed for a long-run manager reset: a framing note + the goal + an instruction to re-ground from the
 * board via team_status, then a short tail of recent exchanges for immediate continuity. The board + team memory are
 * the durable state, so this loses no substance. Pure → unit-tested.
 */
export function managerResetSeed(goal: string, tail: ChatMessage[]): ChatMessage[] {
  const g = goal.trim()
  return [
    {
      role: 'user',
      content:
        '[Long-run session reset to keep you sharp — earlier chat was trimmed. Your durable state is the BOARD and ' +
        `team memory, not this chat.]${g ? `\n\n# Goal\n${g}` : ''}\n\nCall team_status to see the current board, then continue managing toward the goal.`
    },
    { role: 'assistant', content: 'Understood — I will check team_status and continue from the current board state.' },
    ...tail
  ]
}
