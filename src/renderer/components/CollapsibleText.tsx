import { useState, useRef, useLayoutEffect, type ReactNode } from 'react'

// Collapse a tall block (a long user prompt, a big pasted message) to a fixed max height with a fade and a
// Show more/less toggle, so one long message can't push the rest of the chat off-screen. Only shows the
// toggle when the content actually overflows the collapsed height — short messages render untouched.
const DEFAULT_COLLAPSED_MAX_PX = 220

export function CollapsibleText({
  children,
  maxHeight = DEFAULT_COLLAPSED_MAX_PX,
  variant = 'default'
}: {
  children: ReactNode
  maxHeight?: number
  variant?: 'default' | 'prompt'
}) {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const text = typeof children === 'string' ? children : ''
  const lineCount = text ? text.split(/\r\n|\r|\n/).length : 0
  const wordCount = text ? text.trim().split(/\s+/).filter(Boolean).length : 0

  useLayoutEffect(() => {
    const el = ref.current
    if (el) setOverflows(el.scrollHeight > maxHeight + 8)
  }, [children, maxHeight])

  const collapsed = overflows && !expanded
  return (
    <div className={`collapsible-wrap ${variant === 'prompt' ? 'prompt' : ''}`}>
      {variant === 'prompt' && overflows && (
        <div className="collapsible-receipt" aria-hidden="true">
          <span>Prompt</span>
          {lineCount > 1 && <span>{lineCount} lines</span>}
          {wordCount > 0 && <span>{wordCount} words</span>}
        </div>
      )}
      <div
        ref={ref}
        className={`collapsible-body${collapsed ? ' collapsed' : ''}`}
        style={collapsed ? { maxHeight } : undefined}
      >
        {children}
      </div>
      {overflows && (
        <button
          type="button"
          className="collapsible-toggle"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}
