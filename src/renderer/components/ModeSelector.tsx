import type { AgentMode } from '../../shared/domain-types'
import { MODE_META, MODE_ORDER } from '../modeMeta'
import { Icon } from './Icon'

const SHORT: Record<AgentMode, string> = {
  ask: 'Ask',
  acceptEdits: 'Accept',
  auto: 'Auto',
  plan: 'Plan'
}

export function ModeSelector({ mode, onChange }: { mode: AgentMode; onChange: (m: AgentMode) => void }) {
  return (
    <div className="mode-segment" role="group" aria-label="Approval mode">
      {MODE_ORDER.map((m) => (
        <button
          key={m}
          className={`seg-btn mode-${m} ${m === mode ? 'active' : ''}`}
          onClick={() => onChange(m)}
          title={MODE_META[m].desc}
          aria-pressed={m === mode}
        >
          <Icon name={MODE_META[m].icon} size={13} />
          {SHORT[m]}
        </button>
      ))}
    </div>
  )
}
