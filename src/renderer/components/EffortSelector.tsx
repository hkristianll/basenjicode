export type ChatEffort = '' | 'off' | 'low' | 'medium' | 'high'

const LABELS: Record<ChatEffort, string> = {
  '': 'Effort: auto',
  off: 'Effort: off',
  low: 'Effort: low',
  medium: 'Effort: med',
  high: 'Effort: high'
}

/** Per-chat reasoning-effort dial, next to the mode selector (frontier-CLI convention). '' = the
 *  connection/profile default; anything else overrides for THIS chat only. Below high, the harness
 *  ENFORCES the budget by closing an over-long think mid-stream — works even for models that
 *  ignore /no_think. */
export function EffortSelector({ value, onChange }: { value: ChatEffort; onChange: (v: ChatEffort) => void }) {
  return (
    <select
      className="effort-select"
      value={value}
      onChange={(e) => onChange(e.target.value as ChatEffort)}
      title="Thinking budget for this chat. Below high, an over-long think is closed mid-stream and the model is steered to its answer — enforced even for models that ignore /no_think."
      aria-label="Reasoning effort for this chat"
    >
      {(Object.keys(LABELS) as ChatEffort[]).map((k) => (
        <option key={k} value={k}>
          {LABELS[k]}
        </option>
      ))}
    </select>
  )
}
