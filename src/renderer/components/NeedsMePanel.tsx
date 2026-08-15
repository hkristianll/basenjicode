import { Icon, type IconName } from './Icon'

export type AttentionTone = 'error' | 'warn' | 'info'

export interface AttentionItem {
  id: string
  tone: AttentionTone
  title: string
  detail: string
  source?: string
}

const TONE_ICON: Record<AttentionTone, IconName> = {
  error: 'x',
  warn: 'shield',
  info: 'eye'
}

const TONE_LABEL: Record<AttentionTone, string> = {
  error: 'Breakers',
  warn: 'Actions',
  info: 'FYI'
}

export function NeedsMePanel({ items, onDismiss }: { items: AttentionItem[]; onDismiss?: (id: string) => void }) {
  const counts: Record<AttentionTone, number> = { error: 0, warn: 0, info: 0 }
  for (const item of items) counts[item.tone] += 1
  const activeCount = counts.error + counts.warn
  const count = activeCount || counts.info
  const topItem = items[0]
  const heroTone = counts.error > 0 ? 'error' : counts.warn > 0 ? 'warn' : counts.info > 0 ? 'info' : 'calm'

  return (
    <div className="panel needs-panel">
      <div className={`needs-hero ${items.length > 0 ? 'active' : 'calm'} ${heroTone}`}>
        <div className="needs-map" aria-hidden="true">
          <svg className="needs-signal" viewBox="0 0 360 170" role="presentation">
            <defs>
              <linearGradient id="needsRouteHot" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity="0.08" />
                <stop offset="52%" stopColor="currentColor" stopOpacity="0.86" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0.18" />
              </linearGradient>
            </defs>
            <path className="needs-signal-grid" d="M28 26H334M28 70H334M28 114H334M66 14v142M139 14v142M213 14v142M287 14v142" />
            <path className="needs-signal-route route-back" d="M25 119C70 74 111 130 154 84S230 38 333 52" />
            <path className="needs-signal-route" d="M25 119C70 74 111 130 154 84S230 38 333 52" />
            <path className="needs-signal-route route-alt" d="M52 46c42 8 62 42 104 42 48 0 66-48 128-45" />
            <circle className="needs-signal-node node-a" cx="76" cy="82" r="8" />
            <circle className="needs-signal-node node-b" cx="158" cy="83" r="10" />
            <circle className="needs-signal-node node-c" cx="266" cy="54" r="8" />
            <path className="needs-signal-check" d="m245 112 17 18 36-44" />
          </svg>
          <span className="needs-scan" />
        </div>
        <div className="needs-compass" aria-hidden="true">
          <Icon name={topItem ? TONE_ICON[topItem.tone] : 'check'} size={20} />
        </div>
        <div className="needs-hero-copy">
          <div>
            <div className="needs-kicker">{items.length > 0 ? `${count} signal${count === 1 ? '' : 's'}` : 'All clear'}</div>
            <div className="needs-title">{items.length > 0 ? 'Needs your attention' : 'Nothing needs you right now'}</div>
          </div>
          <div className="needs-hero-meta">
            {topItem ? topItem.source || TONE_LABEL[topItem.tone] : 'Ready'}
          </div>
        </div>
      </div>

      <div className="needs-stats" aria-label="Needs Me summary">
        {(['error', 'warn', 'info'] as AttentionTone[]).map((tone) => (
          <div key={tone} className={`needs-stat ${tone} ${counts[tone] > 0 ? 'live' : ''}`}>
            <span className="needs-stat-count">{counts[tone]}</span>
            <span className="needs-stat-label">{TONE_LABEL[tone]}</span>
          </div>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="needs-empty">
          <span className="needs-empty-icon" aria-hidden="true">
            <Icon name="check" size={16} />
          </span>
          <span>
            <strong>Clear runway</strong>
            <small>No blockers in the current chat.</small>
          </span>
        </div>
      ) : (
        <div className="needs-list">
          {items.map((item) => (
            <div key={item.id} className={`needs-item ${item.tone}`}>
              <span className="needs-item-rail" aria-hidden="true" />
              <button
                className="needs-item-icon needs-dismiss"
                type="button"
                onClick={() => onDismiss?.(item.id)}
                disabled={!onDismiss}
                title="Dismiss signal"
                aria-label={`Dismiss ${item.title}`}
              >
                <Icon name={TONE_ICON[item.tone]} size={14} />
              </button>
              <span className="needs-item-copy">
                <span className="needs-item-topline">
                  <span className="needs-item-title">{item.title}</span>
                  <span className="needs-item-tag">{TONE_LABEL[item.tone]}</span>
                </span>
                <span className="needs-item-detail">{item.detail}</span>
                {item.source && <span className="needs-item-source">{item.source}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
