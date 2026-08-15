import { useEffect, useState } from 'react'
import type { PlanFile } from '../../shared/ipc-types'
import { Markdown } from './Markdown'
import { Icon } from './Icon'

export function PlanPanel({ sessionId, planText }: { sessionId: string | null; planText: string }) {
  const [plans, setPlans] = useState<PlanFile[]>([])
  const [viewing, setViewing] = useState<{ name: string; content: string } | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    if (!sessionId) return
    setPlans(await window.api.workspace.listPlans({ sessionId }))
  }
  useEffect(() => {
    void refresh()
  }, [sessionId])

  async function save(): Promise<void> {
    if (!sessionId || !planText.trim()) return
    const title =
      planText
        .split('\n')
        .find((l) => l.trim())
        ?.replace(/^#+\s*/, '')
        .slice(0, 30) || 'plan'
    const p = await window.api.workspace.savePlan({ sessionId, content: planText, title })
    setSaved(p)
    await refresh()
  }

  async function open(pf: PlanFile): Promise<void> {
    if (!sessionId) return
    const content = await window.api.workspace.readFile({ sessionId, path: pf.path })
    setViewing({ name: pf.name, content: content ?? '(could not read file)' })
  }

  if (viewing) {
    return (
      <div className="panel plan-panel">
        <div className="plan-bar">
          <button className="mini-btn" onClick={() => setViewing(null)}>
            <Icon name="chevron-right" size={13} style={{ transform: 'rotate(180deg)' }} />
            Back
          </button>
          <span className="plan-name">{viewing.name}</span>
        </div>
        <div className="plan-content">
          <Markdown text={viewing.content} />
        </div>
      </div>
    )
  }

  return (
    <div className="panel plan-panel">
      <div className="plan-bar">
        <span className="plan-title">
          <Icon name="file-text" size={14} />
          Response
        </span>
        <button className="btn small" onClick={save} disabled={!planText.trim()}>
          Save to plans/
        </button>
      </div>
      <ResponseScope text={planText} savedCount={plans.length} />
      {saved && <div className="plan-saved">Saved -&gt; {saved}</div>}
      <div className="plan-content">
        {planText.trim() ? (
          <Markdown text={planText} />
        ) : (
          <div className="panel-empty">
            The agent's latest response shows here. Use Plan mode to draft a plan, then save it.
          </div>
        )}
      </div>
      {plans.length > 0 && (
        <div className="plan-list">
          <div className="plan-list-title">Saved plans</div>
          {plans.map((pf) => (
            <button key={pf.path} className="plan-file" onClick={() => open(pf)}>
              {pf.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ResponseScope({ text, savedCount }: { text: string; savedCount: number }) {
  const trimmed = text.trim()
  const words = trimmed ? trimmed.split(/\s+/).length : 0
  const lines = trimmed ? trimmed.split(/\r\n|\r|\n/).length : 0
  return (
    <div className={`response-scope ${trimmed ? 'ready' : 'empty'}`}>
      <svg className="response-scope-art" viewBox="0 0 202 78" aria-hidden="true" focusable="false">
        <path className="response-scope-grid" d="M18 18H184M18 39H184M18 60H184M52 10V68M102 10V68M152 10V68" />
        <path className="response-scope-page back" d="M58 17h64l22 22v31H58z" />
        <path className="response-scope-page front" d="M42 11h68l22 22v34H42z" />
        <path className="response-scope-fold" d="M110 11v22h22" />
        <path className="response-scope-line one" d="M56 39h54" />
        <path className="response-scope-line two" d="M56 50h68" />
        <path className="response-scope-line three" d="M56 61h40" />
      </svg>
      <div className="response-scope-copy">
        <span>{trimmed ? 'Latest response' : 'No response yet'}</span>
        <b>{words} words / {lines} lines</b>
        <small>{savedCount} saved plan{savedCount === 1 ? '' : 's'}</small>
      </div>
    </div>
  )
}
