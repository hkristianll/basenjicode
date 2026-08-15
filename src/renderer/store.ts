import type { AgentEvent, ToolPreview, ToolRisk } from '../shared/ipc-types'
import type { ChatMessage, TodoItem } from '../shared/domain-types'
import { isToolError } from '../shared/toolStatus'

export type ToolStatus = 'streaming' | 'proposed' | 'awaiting' | 'running' | 'done'

export interface UserItem {
  kind: 'user'
  id: string
  text: string
  images?: string[]
  /** The turn this message started — present on turn-start messages, enables "rewind to here" (W5c). */
  turnId?: string
}
export interface AssistantItem {
  kind: 'assistant'
  id: string
  text: string
  streaming: boolean
}
export interface ErrorItem {
  kind: 'error'
  id: string
  text: string
}
export interface NoticeItem {
  kind: 'notice'
  id: string
  text: string
  retryable?: boolean
}
export interface UndoItem {
  kind: 'undo'
  id: string
  turnId: string
  count: number
  undone: boolean
}
export interface ToolItem {
  kind: 'tool'
  id: string
  callId: string
  name: string
  risk: ToolRisk
  argsText: string
  preview?: ToolPreview
  status: ToolStatus
  ok?: boolean
  result?: string
  /** Generated image data URLs (generate_image), shown inline in the card. */
  images?: string[]
}
export type UIItem = UserItem | AssistantItem | ToolItem | ErrorItem | NoticeItem | UndoItem

export interface ChatState {
  items: UIItem[]
  running: boolean
  /** Ephemeral progress for the active turn. It never enters `items`, so session persistence cannot retain it. */
  thinkingProgress?: { turnId: string; chars: number; seconds: number }
  /** Real context usage from the last completion (LM Studio usage), when available. */
  tokens?: { used: number; limit: number }
  /** The agent's current task checklist (todo_write), shown in the UI. */
  todos?: TodoItem[]
}

export const initialChatState: ChatState = { items: [], running: false }

/** Chat state keyed by sessionId, so a running session can't bleed into the one you're viewing. */
export type SessionChats = Record<string, ChatState>
export const initialSessionChats: SessionChats = {}

function newId(): string {
  return crypto.randomUUID()
}

export type ChatAction =
  | { type: 'reset'; sessionId: string; items: UIItem[] }
  | { type: 'addUser'; sessionId: string; text: string; images?: string[] }
  | { type: 'event'; sessionId: string; event: AgentEvent }
  | { type: 'markUndone'; sessionId: string; turnId: string }
  // The turn id only exists once startTurn resolves, AFTER addUser dispatched — stamp it onto the newest
  // unstamped user item so "rewind to here" works on live messages too (reloaded ones carry it already).
  | { type: 'stampUserTurn'; sessionId: string; turnId: string }

export function chatReducer(state: SessionChats, action: ChatAction): SessionChats {
  const cur = state[action.sessionId] ?? initialChatState
  let next: ChatState
  switch (action.type) {
    case 'reset':
      // Never wipe a session that has a live turn (e.g. when you switch back to it).
      if (cur.running) return state
      next = { items: action.items, running: false }
      break
    case 'addUser':
      next = {
        ...cur,
        items: [...cur.items, { kind: 'user', id: newId(), text: action.text, images: action.images }]
      }
      break
    case 'event':
      next = applyEvent(cur, action.event)
      break
    case 'markUndone':
      next = {
        ...cur,
        items: cur.items.map((it) => (it.kind === 'undo' && it.turnId === action.turnId ? { ...it, undone: true } : it))
      }
      break
    case 'stampUserTurn': {
      let stamped = false
      const items = [...cur.items]
      for (let i = items.length - 1; i >= 0 && !stamped; i--) {
        const it = items[i]
        if (it.kind === 'user' && !it.turnId) {
          items[i] = { ...it, turnId: action.turnId }
          stamped = true
        }
      }
      if (!stamped) return state
      next = { ...cur, items }
      break
    }
    default:
      return state
  }
  return { ...state, [action.sessionId]: next }
}

function applyEvent(state: ChatState, e: AgentEvent): ChatState {
  const items = state.items.slice()
  const findTool = (callId: string): number =>
    items.findIndex((it) => it.kind === 'tool' && it.callId === callId)

  switch (e.type) {
    case 'turn-started':
      return { ...state, running: true, thinkingProgress: undefined }

    case 'thinking-progress':
      return { ...state, thinkingProgress: { turnId: e.turnId, chars: e.chars, seconds: e.seconds } }

    case 'assistant-delta': {
      const last = items[items.length - 1]
      if (last && last.kind === 'assistant' && last.streaming) {
        items[items.length - 1] = { ...last, text: last.text + e.text }
      } else {
        items.push({ kind: 'assistant', id: newId(), text: e.text, streaming: true })
      }
      return {
        ...state,
        items,
        thinkingProgress: state.thinkingProgress?.turnId === e.turnId ? undefined : state.thinkingProgress
      }
    }

    case 'assistant-message-done': {
      let found = false
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]
        if (it.kind === 'assistant' && it.streaming) {
          items[i] = { ...it, streaming: false, ...(e.finalText !== undefined ? { text: e.finalText } : {}) }
          found = true
          break
        }
      }
      // Reasoning-only turn: no content was streamed (no streaming bubble exists), but the loop sent a
      // finalText (the reasoning fallback). Push it so the turn isn't an empty/blank assistant row.
      if (!found && e.finalText && e.finalText.trim()) {
        items.push({ kind: 'assistant', id: newId(), text: e.finalText, streaming: false })
      }
      return {
        ...state,
        items,
        thinkingProgress: state.thinkingProgress?.turnId === e.turnId ? undefined : state.thinkingProgress
      }
    }

    case 'tool-call-delta': {
      const idx = findTool(e.callId)
      if (idx === -1) {
        items.push({
          kind: 'tool',
          id: newId(),
          callId: e.callId,
          name: e.name ?? '…',
          risk: 'safe',
          argsText: e.argsDelta,
          status: 'streaming'
        })
      } else {
        const it = items[idx] as ToolItem
        items[idx] = { ...it, name: e.name ?? it.name, argsText: it.argsText + e.argsDelta }
      }
      return {
        ...state,
        items,
        thinkingProgress: state.thinkingProgress?.turnId === e.turnId ? undefined : state.thinkingProgress
      }
    }

    case 'tool-call-proposed': {
      const idx = findTool(e.callId)
      const argsText = typeof e.args === 'string' ? e.args : JSON.stringify(e.args, null, 2)
      if (idx === -1) {
        items.push({
          kind: 'tool',
          id: newId(),
          callId: e.callId,
          name: e.name,
          risk: e.risk,
          argsText,
          preview: e.preview,
          status: 'proposed'
        })
      } else {
        const it = items[idx] as ToolItem
        items[idx] = {
          ...it,
          name: e.name,
          risk: e.risk,
          argsText,
          preview: e.preview,
          status: it.status === 'awaiting' ? 'awaiting' : 'proposed'
        }
      }
      return {
        ...state,
        items,
        thinkingProgress: state.thinkingProgress?.turnId === e.turnId ? undefined : state.thinkingProgress
      }
    }

    case 'awaiting-approval': {
      const idx = findTool(e.callId)
      if (idx !== -1) items[idx] = { ...(items[idx] as ToolItem), status: 'awaiting' }
      return { ...state, items }
    }

    case 'tool-call-running': {
      const idx = findTool(e.callId)
      if (idx !== -1) items[idx] = { ...(items[idx] as ToolItem), status: 'running' }
      return { ...state, items }
    }

    case 'tool-result': {
      const idx = findTool(e.callId)
      if (idx !== -1)
        items[idx] = {
          ...(items[idx] as ToolItem),
          status: 'done',
          ok: e.ok,
          result: e.result,
          ...(e.images && e.images.length ? { images: e.images } : {})
        }
      return { ...state, items }
    }

    case 'usage':
      return { ...state, tokens: { used: e.promptTokens, limit: e.contextLimit } }

    case 'todos':
      return { ...state, todos: e.todos }

    case 'notice':
      return { ...state, items: [...items, { kind: 'notice', id: newId(), text: e.text, retryable: false }] }

    case 'turn-done': {
      if (e.error) items.push({ kind: 'error', id: newId(), text: e.error })
      if (e.notice) items.push({ kind: 'notice', id: newId(), text: e.notice, retryable: true })
      if (e.editedFiles && e.editedFiles > 0) {
        items.push({ kind: 'undo', id: newId(), turnId: e.turnId, count: e.editedFiles, undone: false })
      }
      return { ...state, items, running: false, thinkingProgress: undefined }
    }

    default:
      return state
  }
}

/** Rebuild the display list from a persisted transcript when a session is loaded. */
export function deriveItems(messages: ChatMessage[]): UIItem[] {
  const items: UIItem[] = []
  const toolIndexByCallId = new Map<string, number>()

  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'user') {
      items.push({ kind: 'user', id: newId(), text: m.displayContent ?? m.content ?? '', images: m.images, turnId: m.turnId })
    } else if (m.role === 'assistant') {
      if (m.content && m.content.trim()) {
        items.push({ kind: 'assistant', id: newId(), text: m.content, streaming: false })
      }
      for (const tc of m.toolCalls ?? []) {
        items.push({
          kind: 'tool',
          id: newId(),
          callId: tc.id,
          name: tc.name,
          risk: 'safe',
          argsText: prettyArgs(tc.arguments),
          status: 'done'
        })
        toolIndexByCallId.set(tc.id, items.length - 1)
      }
    } else if (m.role === 'tool') {
      const idx = m.toolCallId ? toolIndexByCallId.get(m.toolCallId) : undefined
      if (idx !== undefined) {
        const it = items[idx] as ToolItem
        const content = m.content ?? ''
        // W5b reload fidelity: the tool message carries the live card's preview (diff/command) and its
        // images — rehydrate them so a reloaded session renders the same cards. Absent on old sessions.
        items[idx] = { ...it, result: content, ok: !isToolError(content), preview: m.preview, images: m.images }
      }
    }
  }
  return items
}

function prettyArgs(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}
