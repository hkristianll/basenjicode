import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

export interface PaletteItem {
  label: string
  hint?: string
  run: () => void
}

const optId = (i: number): string => `palette-opt-${i}`

export function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus the input on open; restore focus to whatever was focused before, on close (a11y).
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    return () => prev?.focus?.()
  }, [])

  const filtered = useMemo(() => {
    const s = q.toLowerCase().trim()
    return items.filter((i) => i.label.toLowerCase().includes(s)).slice(0, 50)
  }, [q, items])

  useEffect(() => {
    setActive(0)
  }, [q])

  // Keep the highlighted option scrolled into view as the user arrows through a long list.
  useEffect(() => {
    document.getElementById(optId(active))?.scrollIntoView({ block: 'nearest' })
  }, [active])

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(Math.max(0, filtered.length - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const it = filtered[active]
      if (it) {
        onClose()
        it.run()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Tab') {
      // Modal: the combobox input is the only tab stop (options are navigated with the arrows via
      // aria-activedescendant), so trap Tab here rather than letting focus escape behind the overlay.
      e.preventDefault()
    }
  }

  const hasActive = filtered.length > 0

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Type a command or search chats…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-listbox"
          aria-autocomplete="list"
          aria-activedescendant={hasActive ? optId(active) : undefined}
          aria-label="Type a command or search chats"
        />
        <div className="palette-list" id="palette-listbox" role="listbox" aria-label="Commands and chats">
          {filtered.length === 0 && <div className="palette-empty">No matches</div>}
          {filtered.map((it, i) => (
            <div
              key={`${it.label}-${i}`}
              id={optId(i)}
              role="option"
              aria-selected={i === active}
              className={`palette-item ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onClose()
                it.run()
              }}
            >
              <span className="palette-label">{it.label}</span>
              {it.hint && <span className="palette-hint">{it.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
