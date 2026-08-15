import type { QueuedPrompt } from '../../shared/domain-types'
import { Icon } from './Icon'

export function PromptQueue(props: {
  entries: QueuedPrompt[]
  editingId: string | null
  running: boolean
  onEdit: (id: string) => void
  onRemove: (id: string) => void
  onPromote: (id: string) => void
}) {
  if (!props.entries.length) return null
  return (
    <section className="prompt-queue" aria-label={`${props.entries.length} queued prompt${props.entries.length === 1 ? '' : 's'}`}>
      <div className="prompt-queue-title">
        <span>Queued</span>
        <span>{props.entries.length}</span>
      </div>
      <div className="prompt-queue-list">
        {props.entries.map((entry, index) => (
          <div key={entry.id} className={`prompt-queue-row ${props.editingId === entry.id ? 'editing' : ''}`}>
            <span className="prompt-queue-index">{index + 1}</span>
            <span className="prompt-queue-text" title={entry.text || 'Image attachment'}>
              {entry.text || 'Image attachment'}
              {!!entry.images?.length && <span className="prompt-queue-attachments"> · {entry.images.length} image{entry.images.length === 1 ? '' : 's'}</span>}
            </span>
            <span className="prompt-queue-actions">
              <button type="button" className="icon-btn" onClick={() => props.onEdit(entry.id)} title="Edit queued prompt" aria-label="Edit queued prompt">
                <Icon name="pencil" size={12} />
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => props.onPromote(entry.id)}
                disabled={props.running && !!entry.images?.length}
                title={
                  props.running
                    ? entry.images?.length
                      ? 'Image prompts cannot steer a running task — sends next turn'
                      : 'Steer the running task with this prompt now'
                    : 'Send this prompt next'
                }
                aria-label="Send queued prompt"
              >
                <Icon name="send" size={12} />
              </button>
              <button type="button" className="icon-btn" onClick={() => props.onRemove(entry.id)} title="Remove queued prompt" aria-label="Remove queued prompt">
                <Icon name="x" size={12} />
              </button>
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
