import type { ChatMessage } from '../shared/domain-types'
import type { FileEdit } from './store/snapshots'

/**
 * W5c conversation rewind — the pure planner.
 *
 * Rewinding to an earlier user turn means two things: truncate the transcript to just before that turn's
 * user message, and put the workspace files back the way they were before that turn ran. The per-turn undo
 * snapshots (%APPDATA%/nordcode/snapshots/<sessionId>/<turnId>.json — [{path, before}]) hold the "before"
 * content per edited file per turn; for a file touched by several rewound turns the OLDEST before wins,
 * because that is the content from just before the first rewound turn touched it.
 *
 * The snapshot pipeline is utf8-string-typed, so a binary file's "before" is mojibake — those restores are
 * refused (fail closed, reported in the plan) rather than silently corrupting the file.
 */

export interface RewindRestore {
  path: string
  /** Content to write back; null = the turn CREATED the file, so rewinding deletes it. */
  content: string | null
}

export interface RewindPlan {
  /** Transcript prefix to keep — everything before the target turn's user message. */
  keepCount: number
  /** The rewound user text (display form), handed back to the composer as "let me re-ask that". */
  composerText: string
  /** Turn ids being rewound, oldest first — their snapshots merge into `restores` and are consumed on success. */
  turnIds: string[]
  restores: RewindRestore[]
  /** Files whose snapshot content looks non-utf8 — refused, listed so the confirm dialog can say so. */
  binarySkipped: string[]
}

/** A snapshot "before" that came through the utf8-typed pipeline from a binary file carries NULs or
 *  replacement chars — restoring it would write mojibake over the real bytes. Refuse those. */
export function looksBinary(content: string): boolean {
  return content.includes('\u0000') || content.includes('\uFFFD')
}

/**
 * Plan a rewind to the turn started by `targetTurnId`. Returns null when the target isn't a stamped
 * turn-start user message (pre-rewind sessions have no turnId stamps). `loadSnap` is injected so the
 * planner stays headless-testable (production passes the snapshot store's loader).
 */
export function planRewind(
  messages: ChatMessage[],
  targetTurnId: string,
  loadSnap: (turnId: string) => FileEdit[] | null
): RewindPlan | null {
  const start = messages.findIndex((m) => m.role === 'user' && m.turnId === targetTurnId)
  if (start === -1) return null
  const target = messages[start]

  // Every stamped turn from the target onward gets rewound (later turns depend on the earlier ones).
  const turnIds = messages
    .slice(start)
    .filter((m) => m.role === 'user' && m.turnId)
    .map((m) => m.turnId as string)

  // Oldest turn first: the first snapshot seen for a path is the content from before the earliest rewound
  // turn touched it — exactly the state the rewind should restore.
  const restores = new Map<string, string | null>()
  const binarySkipped: string[] = []
  for (const turnId of turnIds) {
    for (const edit of loadSnap(turnId) ?? []) {
      if (restores.has(edit.path) || binarySkipped.includes(edit.path)) continue
      if (edit.before !== null && looksBinary(edit.before)) binarySkipped.push(edit.path)
      else restores.set(edit.path, edit.before)
    }
  }

  return {
    keepCount: start,
    composerText: target.displayContent ?? target.content ?? '',
    turnIds,
    restores: [...restores.entries()].map(([path, content]) => ({ path, content })),
    binarySkipped
  }
}
