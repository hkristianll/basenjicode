import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

/**
 * Full-screen overlay that shows a chat image at full size (like Slack/Discord).
 * Click the backdrop or press Esc to close; the image and the toolbar don't close it.
 * Rendered through a portal to document.body so no ancestor's overflow/transform can clip it.
 */
export function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const focusables = (): HTMLElement[] => Array.from(ref.current?.querySelectorAll<HTMLElement>('a[href], button') ?? [])
    focusables().at(-1)?.focus() // land on the Close button when the preview opens

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'Tab') {
        const f = focusables()
        if (f.length === 0) return
        const first = f[0]
        const last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      prev?.focus?.() // restore focus to the thumbnail that opened the preview
    }
  }, [onClose])

  return createPortal(
    <div className="lightbox" ref={ref} onClick={onClose} role="dialog" aria-modal="true" aria-label="Image preview">
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <a href={src} download="image.png" className="lightbox-btn" title="Save image" aria-label="Save image">
          <Icon name="image" size={16} />
        </a>
        <button type="button" className="lightbox-btn" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <Icon name="x" size={16} />
        </button>
      </div>
      <img src={src} alt="" className="lightbox-img" onClick={(e) => e.stopPropagation()} />
    </div>,
    document.body
  )
}
