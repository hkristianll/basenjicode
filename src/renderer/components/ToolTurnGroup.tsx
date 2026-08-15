import { useState } from 'react'
import { ToolCallCard } from './ToolCallCard'
import { Icon } from './Icon'
import { shortArg, verbOf } from '../toolVerb'
import type { ToolItem } from '../store'
import type { ApprovalDecision } from '../../shared/ipc-types'

const MAX_DOTS = 5
const QUIET_PREVIEW_TOOLS = new Set([
  'preview_open',
  'preview_console',
  'preview_eval',
  'preview_snapshot',
  'preview_reload',
  'preview_screenshot'
])

const PREVIEW_LABEL: Record<string, string> = {
  preview_open: 'Preview open',
  preview_console: 'Console check',
  preview_eval: 'DOM check',
  preview_snapshot: 'Snapshot',
  preview_reload: 'Preview reload',
  preview_screenshot: 'Screenshot'
}

const QUIET_DONE_TOOLS = new Set([
  ...QUIET_PREVIEW_TOOLS,
  'read_file',
  'grep',
  'glob',
  'list_dir',
  'list_background',
  'read_background',
  'web_fetch',
  'web_search',
  'todo_write'
])

function groupSummary(items: ToolItem[]): string {
  const counts = new Map<string, number>()
  for (const it of items) {
    const v = verbOf(it.name)
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([v, n]) => (n > 1 ? `${v} x${n}` : v))
    .join(' / ')
}

function groupStatus(items: ToolItem[]): 'awaiting' | 'running' | 'active' | 'done' {
  if (items.some((it) => it.status === 'awaiting')) return 'awaiting'
  if (items.some((it) => it.status === 'running')) return 'running'
  if (items.some((it) => it.status === 'streaming' || it.status === 'proposed')) return 'active'
  return 'done'
}

export function isQuietActivityGroup(items: ToolItem[]): boolean {
  const status = groupStatus(items)
  return status === 'done' && items.length > 0 && items.every((it) => it.ok !== false && QUIET_DONE_TOOLS.has(it.name))
}

function isQuietPreviewGroup(items: ToolItem[]): boolean {
  return items.length > 0 && items.every((it) => QUIET_PREVIEW_TOOLS.has(it.name))
}

function quietLabel(items: ToolItem[]): string {
  if (items.length === 1) return verbOf(items[0].name)
  const counts = new Map<string, number>()
  for (const it of items) {
    const label = verbOf(it.name)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const parts = Array.from(counts.entries()).map(([label, n]) => (n > 1 ? `${label} x${n}` : label))
  return parts.length > 2 ? `${items.length} quiet steps` : parts.join(' / ')
}

function quietSummary(items: ToolItem[]): string {
  const counts = new Map<string, number>()
  for (const it of items) {
    const label = PREVIEW_LABEL[it.name] ?? verbOf(it.name)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([label, n]) => (n > 1 ? `${label} x${n}` : label))
    .join(' / ')
}

function quietDetail(label: string, summary: string, count: number, previewQuiet: boolean): string {
  if (previewQuiet && count > 1) return summary === label ? '' : summary
  if (summary !== label) return summary
  if (count > 2) return `${count} quiet steps`
  return ''
}

type QuietRun = {
  key: string
  label: string
  items: ToolItem[]
}

function quietRunLabel(item: ToolItem): string {
  return PREVIEW_LABEL[item.name] ?? verbOf(item.name)
}

function quietTarget(item: ToolItem): string {
  try {
    const args = JSON.parse(item.argsText) as Record<string, unknown>
    const target = args.path ?? args.file ?? args.filename ?? args.pattern ?? args.query ?? args.url ?? args.command ?? args.cmd
    return typeof target === 'string' ? shortArg(target, 38) : ''
  } catch {
    return ''
  }
}

function compactQuietRuns(items: ToolItem[]): QuietRun[] {
  const runs: QuietRun[] = []
  for (const item of items) {
    const label = quietRunLabel(item)
    const last = runs[runs.length - 1]
    if (last?.label === label) {
      last.items.push(item)
    } else {
      runs.push({ key: item.id, label, items: [item] })
    }
  }
  return runs
}

function quietRunDetail(run: QuietRun): string {
  const label = run.label.toLowerCase()
  const targets = Array.from(new Set(run.items.map(quietTarget).filter((t) => t && t.toLowerCase() !== label)))
  if (targets.length > 0) {
    const shown = targets.slice(0, 2).join(', ')
    const extra = targets.length - 2
    return extra > 0 ? `${shown} +${extra}` : shown
  }
  return run.items.length > 1 ? `${run.items.length} steps` : ''
}

function QuietRunList({ items }: { items: ToolItem[] }) {
  return (
    <div className="tool-quiet-runs">
      {compactQuietRuns(items).map((run) => {
        const count = run.items.length
        const detail = quietRunDetail(run)
        return (
          <div key={run.key} className="tool-quiet-run">
            <span className="tool-quiet-dot" aria-hidden="true" />
            <span className="tool-quiet-label">
              {run.label}{count > 1 ? ` x${count}` : ''}
            </span>
            {detail && <span className="tool-quiet-detail">{detail}</span>}
          </div>
        )
      })}
    </div>
  )
}

export function ToolTurnGroup({
  items,
  verbose,
  onDecide,
}: {
  items: ToolItem[]
  verbose?: boolean
  onDecide: (callId: string, d: ApprovalDecision, note?: string) => void
}) {
  // null follows activity status: live work stays visible, completed work folds away. A manual
  // choice wins after that, so users can keep a result open or hide a noisy running batch.
  const [openOverride, setOpenOverride] = useState<boolean | null>(null)
  const status = groupStatus(items)
  const quiet = isQuietActivityGroup(items)
  const previewQuiet = quiet && isQuietPreviewGroup(items)
  const open = openOverride ?? status !== 'done'
  const summary = groupSummary(items)
  const quietText = quietSummary(items)
  const label = previewQuiet ? (items.length === 1 ? quietText : `${items.length} preview checks`) : quietLabel(items)
  const doneOk = status === 'done' && items.every((it) => it.ok !== false)
  const compactDone = doneOk && !open
  const visibleDots = items.slice(0, MAX_DOTS)
  const extraDots = items.length - MAX_DOTS
  const statusLabel =
    status === 'awaiting'
      ? 'Needs approval'
      : status === 'running'
        ? 'Running'
        : status === 'active'
          ? 'Preparing'
          : 'Complete'
  const toggleOpen = (): void => setOpenOverride(!open)
  const heading = quiet ? label : compactDone ? summary : 'Activity'
  const detail = quiet
    ? quietDetail(label, quietText, items.length, previewQuiet)
    : compactDone
      ? `${items.length} ${items.length === 1 ? 'step' : 'steps'}`
      : summary

  return (
    <div className={`tool-group status-${status} ${quiet ? 'quiet' : ''} ${compactDone ? 'compact-done' : ''} ${open ? 'open' : ''}`}>
      <div
        className="tg-header"
        onClick={toggleOpen}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggleOpen()
          }
        }}
      >
        <div className="tg-dots" aria-hidden="true">
          {visibleDots.map((it) => (
            <div
              key={it.id}
              className={`tg-dot ${it.status === 'done' && it.ok !== false ? 'done' : ''}`}
            />
          ))}
          {extraDots > 0 && <span className="tg-dot-extra">+{extraDots}</span>}
        </div>
        <span className="tg-label">{heading}</span>
        {!quiet && !compactDone && <span className={`tg-state ${status}`} aria-live="polite">{statusLabel}</span>}
        {!quiet && !compactDone && (
          <span className="tg-count">
            {items.length} {items.length === 1 ? 'step' : 'steps'}
          </span>
        )}
        {detail && <span className="tg-tag">{detail}</span>}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} className="tg-caret" />
      </div>

      {open && (
        <div className="tg-body">
          {quiet && status === 'done' ? (
            <QuietRunList items={items} />
          ) : (
            items.map((it) => (
              <ToolCallCard key={it.id} item={it} verbose={verbose} onDecide={onDecide} />
            ))
          )}
        </div>
      )}
    </div>
  )
}
