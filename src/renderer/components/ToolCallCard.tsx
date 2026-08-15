import { useEffect, useRef, useState } from 'react'
import { CopyButton } from './CopyButton'
import { Icon, type IconName } from './Icon'
import { Lightbox } from './Lightbox'
import { verbOf } from '../toolVerb'
import { parseDiffRows, pairWordDiffs } from '../diffWords'
import type { ToolItem } from '../store'
import type { ApprovalDecision, ToolPreview } from '../../shared/ipc-types'

interface ChipInfo {
  label: string
  cls: string
}
function statusChip(item: ToolItem): ChipInfo {
  if (item.ok === false) return { label: 'failed', cls: 'err' }
  switch (item.status) {
    case 'streaming':
      return { label: 'preparing', cls: 'muted' }
    case 'proposed':
      return { label: 'proposed', cls: 'muted' }
    case 'awaiting':
      return { label: 'needs approval', cls: 'awaiting' }
    case 'running':
      return { label: 'running', cls: 'running' }
    case 'done':
      return { label: 'done', cls: 'ok' }
  }
}

function toolIcon(name: string): IconName {
  if (name.includes('image') || name.includes('video')) return 'sparkle'
  if (name.includes('shell') || name.includes('background')) return 'terminal'
  if (name.includes('write') || name.includes('edit')) return 'pencil'
  if (name.includes('list')) return 'folder'
  return 'search'
}

/** Turn a raw failure dump into a one-line human cause (+ optional hint), so a red card reads as
 *  "Timed out" rather than a wall of stderr. */
function classifyFailure(text: string): { cause: string; hint?: string } {
  const t = text.toLowerCase()
  if (/timed out|timeout|etimedout/.test(t))
    return { cause: 'Timed out', hint: 'The tool took too long — try again or check the service is responding.' }
  if (/econnrefused|connection refused|fetch failed|enotfound|socket hang up|econnreset|network error/.test(t))
    return { cause: 'Connection failed', hint: 'The service may be offline — check it’s running.' }
  if (/context|token limit|maximum context|context length|too many tokens|exceeds/.test(t))
    return { cause: 'Context too large', hint: 'Reduce the input or start a fresh chat.' }
  if (/rate.?limit|429|too many requests/.test(t)) return { cause: 'Rate limited', hint: 'Wait a moment, then retry.' }
  if (/permission|eacces|access is denied|not permitted/.test(t)) return { cause: 'Permission denied' }
  if (/enoent|no such file|cannot find|not found/.test(t)) return { cause: 'Not found', hint: 'The path or resource doesn’t exist.' }
  const first = text.split('\n').map((s) => s.trim()).find(Boolean) ?? 'Tool failed'
  return { cause: first.length > 90 ? `${first.slice(0, 90)}…` : first }
}

/** One-line result preview shown under a collapsed tool card (Claude Code's ⎿ summary line). */
function resultPeek(item: ToolItem): { text: string; err: boolean } | null {
  if (item.result === undefined) return null
  if (item.ok === false) return { text: classifyFailure(item.result).cause, err: true }
  const lines = item.result.split('\n')
  const first = (lines.find((l) => l.trim()) ?? '').trim()
  if (!first) return null
  const head = first.length > 140 ? `${first.slice(0, 140)}…` : first
  const extra = lines.length - 1
  const text = extra > 0 ? `${head}  +${extra} line${extra === 1 ? '' : 's'}` : head
  return { text, err: false }
}

/** A short, human summary shown inline in the header — the file path or the command. */
function summarize(item: ToolItem): { text: string; cmd: boolean } | null {
  if (item.preview?.kind === 'command' && item.preview.text) return { text: item.preview.text, cmd: true }
  if (item.preview?.path) return { text: item.preview.path, cmd: false }
  try {
    const a = JSON.parse(item.argsText) as Record<string, unknown>
    const cmd = a.command ?? a.cmd
    if (typeof cmd === 'string') return { text: cmd, cmd: true }
    const path = a.path ?? a.file ?? a.filename ?? a.pattern ?? a.query
    if (typeof path === 'string') return { text: path, cmd: false }
  } catch {
    /* args still streaming / not JSON */
  }
  return null
}

export function ToolCallCard({
  item,
  verbose,
  onDecide
}: {
  item: ToolItem
  verbose?: boolean
  onDecide: (callId: string, d: ApprovalDecision, note?: string) => void
}) {
  // null = follow the global verbosity; true/false = this card was expanded/collapsed by the user.
  const [override, setOverride] = useState<boolean | null>(null)
  // Which generated image (if any) is open in the full-size lightbox.
  const [zoom, setZoom] = useState<string | null>(null)
  const open = item.status === 'awaiting' || (override !== null ? override : !!verbose)
  const chip = statusChip(item)
  const summary = summarize(item)
  const peek = resultPeek(item)
  const hasBody = Boolean(item.argsText || item.preview || item.result !== undefined || item.status === 'awaiting')

  return (
    <div className={`tool-card ${item.risk} status-${item.status}`}>
      <div
        className="tool-head"
        onClick={() => setOverride(!open)}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOverride(!open)
          }
        }}
      >
        <span className="tool-icon">
          <Icon name={toolIcon(item.name)} size={14} />
        </span>
        <span className="tool-name" title={item.name}>
          {verbOf(item.name)}
        </span>
        {summary && <span className={summary.cmd ? 'tool-cmd' : 'tool-path'}>{summary.text}</span>}
        {!summary && <span className="tool-path" />}
        <span className={`tool-chip ${chip.cls}`}>
          {chip.cls === 'ok' && <Icon name="check" size={11} />}
          {chip.label}
        </span>
        {hasBody && <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} className="tool-caret" />}
      </div>

      {/* Generated images/video are the result itself — always show them, even when the card is collapsed. */}
      {item.images && item.images.length > 0 && (
        <div className="tool-images">
          {item.images.map((src, i) =>
            src.startsWith('data:video') ? (
              <video key={i} className="tool-video" src={src} controls loop muted playsInline />
            ) : (
              <button
                key={i}
                type="button"
                className="tool-image-link"
                onClick={() => setZoom(src)}
                title="Click to enlarge"
                aria-label={`Open generated image ${i + 1}`}
              >
                <img src={src} alt={`generated ${i + 1}`} className="tool-image" />
              </button>
            )
          )}
        </div>
      )}

      {/* Collapsed (compact): a one-line result preview, à la Claude Code's ⎿ summary. */}
      {!open && peek && (
        <div
          className={`tool-peek ${peek.err ? 'err' : ''}`}
          onClick={() => setOverride(true)}
          role="button"
          tabIndex={0}
          aria-label="Expand tool details"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setOverride(true)
            }
          }}
        >
          <span className="tool-peek-mark" aria-hidden="true">⎿</span>
          <span className="tool-peek-text">{peek.text}</span>
        </div>
      )}

      {open && hasBody && (
        <div className="tool-body">
          {item.preview ? <Preview preview={item.preview} /> : item.argsText && <pre className="tool-args">{item.argsText}</pre>}
          {item.status === 'awaiting' && <ApprovalBar item={item} onDecide={onDecide} />}
          {item.result !== undefined &&
            (item.ok === false ? (
              <ToolError text={item.result} />
            ) : (
              <ToolResultBlock text={item.result} />
            ))}
        </div>
      )}
      {zoom && <Lightbox src={zoom} onClose={() => setZoom(null)} />}
    </div>
  )
}

/** Failed-tool result: a human cause + hint up front, raw output tucked behind a Details disclosure. */
function ToolError({ text }: { text: string }) {
  const { cause, hint } = classifyFailure(text)
  return (
    <div className="tool-error">
      <div className="tool-error-head">{cause}</div>
      {hint && <div className="tool-error-hint">{hint}</div>}
      <details className="tool-error-details">
        <summary>Details</summary>
        <ToolResultBlock text={text} tone="err" label="error output" />
      </details>
    </div>
  )
}

function ToolResultBlock({ text, tone, label = 'result' }: { text: string; tone?: 'err'; label?: string }) {
  const [expanded, setExpanded] = useState(false)
  const lineCount = text ? text.split(/\r\n|\r|\n/).length : 0
  const shouldCollapse = lineCount > 8 || text.length > 1200
  const collapsed = shouldCollapse && !expanded
  return (
    <div className={`tool-result-wrap ${tone ?? ''} ${shouldCollapse ? 'is-long' : ''}`}>
      <div className="tool-result-head">
        <span className="tool-result-meta">
          <span className="tool-result-label">{label}</span>
          {lineCount > 0 && <span className="tool-result-lines">{lineCount} line{lineCount === 1 ? '' : 's'}</span>}
        </span>
        <span className="tool-result-actions">
          {shouldCollapse && (
            <button
              type="button"
              className="tool-result-toggle"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}, ${lineCount} line${lineCount === 1 ? '' : 's'}`}
              title={expanded ? 'Collapse output' : 'Expand output'}
            >
              <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={13} />
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          )}
          <CopyButton text={text} />
        </span>
      </div>
      <pre className={`tool-result ${tone ?? ''} ${collapsed ? 'is-collapsed' : ''} ${shouldCollapse && expanded ? 'is-expanded' : ''}`}>{text}</pre>
    </div>
  )
}

function Preview({ preview }: { preview: ToolPreview }) {
  if (preview.kind === 'command') {
    return <pre className="preview command">&gt; {preview.text}</pre>
  }
  if (preview.kind === 'new-file') {
    return (
      <div className="preview new-file">
        <div className="preview-label">new file: {preview.path}</div>
        <pre>{preview.text}</pre>
      </div>
    )
  }
  if (preview.kind === 'diff' && preview.unified) {
    return <DiffView unified={preview.unified} />
  }
  if (preview.kind === 'text' && preview.text) {
    return <pre className="preview">{preview.text}</pre>
  }
  return null
}

/** Unified-diff renderer with a line-number gutter (old numbers for deletions, new for additions) and
 *  word-level intraline highlighting: on a modified line, only the span that changed is emphasised. */
export function DiffView({ unified, onFixSelection }: { unified: string; onFixSelection?: (selection: string) => void }) {
  const rows = parseDiffRows(unified)
  const words = pairWordDiffs(rows)
  const rootRef = useRef<HTMLPreElement>(null)
  const [contextAction, setContextAction] = useState<{ x: number; y: number; selection: string } | null>(null)

  function openContextAction(event: React.MouseEvent<HTMLPreElement>): void {
    if (!onFixSelection) return
    const selection = window.getSelection()
    const root = rootRef.current
    if (!selection || selection.isCollapsed || !root) return
    if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return
    const text = selection.toString().trim()
    if (!text) return
    event.preventDefault()
    setContextAction({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 170)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 48)),
      selection: text
    })
  }

  return (
    <pre
      ref={rootRef}
      className="diff"
      onContextMenu={openContextAction}
      title={onFixSelection ? 'Select diff lines and right-click to ask the agent to fix only that selection.' : undefined}
    >
      {rows.map((r, i) => {
        const segs = words.get(i)
        return (
          <div key={i} className={`dl ${r.cls}`}>
            <span className="dlg">{r.gutter}</span>
            <span className="dlc">
              {r.sign && (
                <span className="dl-sign" aria-hidden="true">
                  {r.sign}
                </span>
              )}
              {segs
                ? segs.map((s, k) =>
                    s.changed ? (
                      <span key={k} className="dw">
                        {s.text}
                      </span>
                    ) : (
                      <span key={k}>{s.text}</span>
                    )
                  )
                : r.content || (r.sign ? '' : ' ')}
            </span>
          </div>
        )
      })}
      {contextAction && (
        <button
          className="diff-context-action"
          type="button"
          style={{ left: contextAction.x, top: contextAction.y }}
          autoFocus
          onBlur={() => setContextAction(null)}
          onMouseDown={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setContextAction(null)
          }}
          onClick={() => {
            onFixSelection?.(contextAction.selection)
            setContextAction(null)
          }}
        >
          <Icon name="pencil" size={13} /> Fix only this
        </button>
      )}
    </pre>
  )
}

function ApprovalBar({
  item,
  onDecide
}: {
  item: ToolItem
  onDecide: (callId: string, d: ApprovalDecision, note?: string) => void
}) {
  const isShell = item.name === 'run_shell' || item.name === 'run_background'
  const [note, setNote] = useState('')
  const approveRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    approveRef.current?.focus()
  }, [])
  return (
    <div className="approval">
      <input
        className="approval-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note to the agent (used if you Reject)…"
      />
      <div className="approval-bar">
        <button ref={approveRef} className="btn approve" onClick={() => onDecide(item.callId, 'approve')}>
          <Icon name="check" size={14} /> Approve
        </button>
        <button className="btn reject" onClick={() => onDecide(item.callId, 'reject', note.trim() || undefined)}>
          Reject
        </button>
        {isShell && (
          <button className="btn always" onClick={() => onDecide(item.callId, 'always_exact')}>
            Always this exact command
          </button>
        )}
        <button className="btn always" onClick={() => onDecide(item.callId, 'always_tool')}>
          Always {item.name}
        </button>
      </div>
    </div>
  )
}
