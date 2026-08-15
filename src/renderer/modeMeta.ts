import type { AgentMode } from '../shared/domain-types'
import type { IconName } from './components/Icon'

export const MODE_ORDER: AgentMode[] = ['ask', 'acceptEdits', 'auto', 'plan']

export const MODE_META: Record<AgentMode, { label: string; icon: IconName; desc: string }> = {
  ask: { label: 'Ask', icon: 'shield', desc: 'Approve each change' },
  acceptEdits: { label: 'Accept edits', icon: 'clipboard-check', desc: 'Auto-apply edits, ask for commands' },
  auto: { label: 'Auto', icon: 'zap', desc: 'Run everything — incl. shell commands — without asking' },
  plan: { label: 'Plan', icon: 'eye', desc: 'Read-only — plan without changes' }
}
