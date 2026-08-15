import type { ToolItem, UIItem } from './store'
import { isHiddenAssistantNoise } from './chatText'

export type ChatSegment =
  | { type: 'item'; item: UIItem; idx: number }
  | { type: 'group'; tools: ToolItem[]; firstIdx: number }

/** Assistant text and tool calls are the agent's own output — grouped under one avatar/name. */
export function isAgentItem(item?: UIItem): boolean {
  return !!item && (item.kind === 'assistant' || item.kind === 'tool')
}

const BRIDGE_TEXT_MAX = 240
const BRIDGE_VERBS =
  '(check|inspect|read|look|open|run|rerun|test|verify|build|search|grep|list|scan|load|evaluate|screenshot|refresh|reload|probe|compare|trace|fix|patch|edit|update|force)'

/** Low-information narration that only announces the next tool burst. Hide it when a tool follows. */
function isOperationalBridge(item?: UIItem): boolean {
  if (!item || item.kind !== 'assistant' || item.streaming) return false
  const text = item.text.replace(/\s+/g, ' ').trim()
  if (!text || text.length > BRIDGE_TEXT_MAX || isHiddenAssistantNoise(text)) return false
  if (/```|<tool_call|<function=/.test(text)) return false
  return (
    new RegExp(`\\b(let me|i(?:'ll| will| am going to)|i'm going to|next[, ]+i|now[, ]+i|i need to)\\b.{0,140}\\b${BRIDGE_VERBS}\\b`, 'i').test(text) ||
    new RegExp(`^(now\\s+)?${BRIDGE_VERBS}(ing)?\\b`, 'i').test(text)
  )
}

function nextVisibleIsTool(items: UIItem[], start: number): boolean {
  let index = start
  while (index < items.length) {
    const item = items[index]
    if (item.kind === 'assistant' && (isHiddenAssistantNoise(item.text) || isOperationalBridge(item))) {
      index++
      continue
    }
    return item.kind === 'tool'
  }
  return false
}

/**
 * Collapse each chronological run of tool calls into an activity block.
 *
 * Keeping real prose in place matters: assistant prose can appear between tool batches, and moving
 * later calls into an earlier group makes the visible transcript tell a different story than the
 * agent did. Noise-only leaked text tool-call fragments are skipped so they do not split activity
 * into several identical "1 step" rows.
 */
export function groupChatItems(items: UIItem[]): ChatSegment[] {
  const segments: ChatSegment[] = []
  let index = 0

  while (index < items.length) {
    const item = items[index]
    if (item.kind === 'assistant' && isHiddenAssistantNoise(item.text)) {
      index++
      continue
    }
    if (isOperationalBridge(item) && nextVisibleIsTool(items, index + 1)) {
      index++
      continue
    }
    if (item.kind !== 'tool') {
      segments.push({ type: 'item', item, idx: index })
      index++
      continue
    }

    const firstIdx = index
    const tools: ToolItem[] = []
    while (index < items.length) {
      const next = items[index]
      if (next.kind === 'tool') {
        tools.push(next as ToolItem)
        index++
        continue
      }
      if (next.kind === 'assistant' && isHiddenAssistantNoise(next.text)) {
        index++
        continue
      }
      if (isOperationalBridge(next) && nextVisibleIsTool(items, index + 1)) {
        index++
        continue
      }
      break
    }
    segments.push({ type: 'group', tools, firstIdx })
  }

  return segments
}
