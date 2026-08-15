import { useEffect, useState } from 'react'
import type { GitFile, GitStatus } from '../../shared/ipc-types'
import { Icon } from './Icon'
import { DiffView } from './ToolCallCard'
import { toast } from '../toast'

export interface SnapshotInfo {
  turnId: string
  count: number
  undone: boolean
}

export function GitPanel({
  sessionId,
  snapshot,
  onUndo,
  onFixSelection
}: {
  sessionId: string | null
  snapshot?: SnapshotInfo
  onUndo?: (turnId: string) => void
  onFixSelection?: (path: string, selection: string) => void
}) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  async function refresh(): Promise<void> {
    if (!sessionId) {
      setStatus(null)
      return
    }
    setStatus(await window.api.git.status(sessionId))
  }
  useEffect(() => {
    setSel(null)
    void refresh()
  }, [sessionId])

  async function openDiff(path: string): Promise<void> {
    if (!sessionId) return
    setSel(path)
    setDiff(await window.api.git.diff({ sessionId, path }))
  }

  async function commit(): Promise<void> {
    if (!sessionId) return
    setBusy(true)
    const r = await window.api.git.commit({ sessionId, message })
    setBusy(false)
    if (r.ok) {
      setMessage('')
      toast.success('Changes committed')
      await refresh()
    } else {
      toast.error(r.error || 'Commit failed')
    }
  }

  if (!sessionId) {
    return (
      <div className="panel">
        <div className="panel-empty">No chat selected.</div>
      </div>
    )
  }
  if (!status) {
    return (
      <div className="panel">
        <div className="panel-empty">Loading...</div>
      </div>
    )
  }
  if (!status.isRepo) {
    return (
      <div className="panel">
        <div className="panel-empty">
          Not a git repository.
          <br />
          Run <code>git init</code> in the working folder to enable this panel.
        </div>
      </div>
    )
  }

  if (sel) {
    return (
      <div className="panel git-panel">
        <div className="plan-bar">
          <button className="icon-btn" onClick={() => setSel(null)} aria-label="Back">
            <Icon name="chevron-right" size={15} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <span className="plan-name">{sel}</span>
        </div>
        <div className="plan-content">
          <DiffView unified={diff} onFixSelection={onFixSelection ? (selection) => onFixSelection(sel, selection) : undefined} />
        </div>
      </div>
    )
  }

  return (
    <div className="panel git-panel">
      <ReviewMap files={status.files} branch={status.branch} />

      <div className="review-section">
        <div className="section-head">
          <span className="section-title">Changed files</span>
          <span className="section-badge">{status.files.length}</span>
          <button className="icon-btn section-action" onClick={() => void refresh()} title="Refresh" aria-label="Refresh">
            <Icon name="refresh" size={14} />
          </button>
        </div>
        {status.files.length === 0 && <div className="panel-empty">Working tree clean.</div>}
        {status.files.map((f) => {
          const ext = fileExt(f.path)
          return (
            <button key={f.path} className="changed-file" onClick={() => void openDiff(f.path)} title={f.path}>
              <span className={`file-ico ${ext}`}>{ext || '*'}</span>
              <span className="git-file-path">{f.path}</span>
              {f.added != null || f.deleted != null ? (
                <span className="file-stat">
                  {f.added ? <span className="add">+{f.added}</span> : null}
                  {f.deleted ? <span className="del">-{f.deleted}</span> : null}
                </span>
              ) : (
                <span className={`file-chip ${f.staged ? 'staged' : ''}`}>{f.status}</span>
              )}
            </button>
          )
        })}
      </div>

      <div className="review-section">
        <div className="section-head">
          <span className="section-title">Git</span>
        </div>
        <div className="branch-chip">
          <Icon name="git-branch" size={13} /> {status.branch}
        </div>
        {status.files.length > 0 && (
          <div className="git-commit">
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Commit message..." rows={2} />
            <button className="btn approve" disabled={busy || !message.trim()} onClick={() => void commit()}>
              Stage all &amp; commit
            </button>
          </div>
        )}
      </div>

      {snapshot && onUndo && (
        <div className="review-section">
          <div className="section-head">
            <span className="section-title">Snapshot</span>
          </div>
          <div className="snapshot-row">
            <span className="snapshot-meta">
              {snapshot.undone
                ? `Reverted ${snapshot.count} file${snapshot.count === 1 ? '' : 's'}`
                : `Last turn / ${snapshot.count} file${snapshot.count === 1 ? '' : 's'}`}
            </span>
            {!snapshot.undone && (
              <button className="mini-btn" onClick={() => onUndo(snapshot.turnId)}>
                <Icon name="refresh" size={13} /> Undo turn
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ReviewMap({ files, branch }: { files: GitFile[]; branch: string }) {
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0)
  const deleted = files.reduce((sum, file) => sum + (file.deleted ?? 0), 0)
  const staged = files.filter((file) => file.staged).length
  const maxLines = Math.max(1, added, deleted)
  const addHeight = Math.max(8, Math.round((added / maxLines) * 46))
  const delHeight = Math.max(8, Math.round((deleted / maxLines) * 46))
  const nodes = files.slice(0, 8)
  const coords = [
    [30, 62],
    [56, 28],
    [82, 50],
    [110, 22],
    [134, 58],
    [160, 34],
    [184, 54],
    [202, 24]
  ] as const

  return (
    <div className={`review-map ${files.length === 0 ? 'clean' : ''}`}>
      <div className="review-map-art" aria-hidden="true">
        <svg viewBox="0 0 232 88" className="review-map-svg">
          <path className="review-map-grid" d="M18 18H214M18 44H214M18 70H214M44 10V78M90 10V78M136 10V78M182 10V78" />
          <path className="review-map-trace" d="M24 64C54 18 88 54 116 30S172 72 210 24" />
          {nodes.map((file, i) => {
            const [cx, cy] = coords[i]
            return <circle key={file.path} className={`review-map-node ${file.staged ? 'staged' : ''}`} cx={cx} cy={cy} r={file.staged ? 5 : 4} />
          })}
          {files.length === 0 && <circle className="review-map-node clean" cx="116" cy="44" r="7" />}
          <rect className="review-map-add" x="22" y={76 - addHeight} width="8" height={addHeight} rx="3" />
          <rect className="review-map-del" x="36" y={76 - delHeight} width="8" height={delHeight} rx="3" />
        </svg>
      </div>
      <div className="review-map-copy">
        <div className="review-map-kicker">{files.length === 0 ? 'Clean branch' : `${files.length} changed file${files.length === 1 ? '' : 's'}`}</div>
        <div className="review-map-title">{branch}</div>
        <div className="review-map-stats">
          <span className="add">+{added}</span>
          <span className="del">-{deleted}</span>
          <span>{staged} staged</span>
        </div>
      </div>
    </div>
  )
}

function fileExt(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}
