import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'

export function AddMenu(props: {
  onAddFiles: () => void
  onAddFolder: () => void
  onAddImage: () => void
  onSlash: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  function pick(run: () => void): void {
    setOpen(false)
    run()
  }

  return (
    <div className="add-menu" ref={ref}>
      <button className="add-btn labeled" onClick={() => setOpen((v) => !v)} title="Add context" aria-label="Add context">
        <Icon name="plus" size={15} /> Add context
      </button>
      {open && (
        <div className="add-pop">
          <button className="add-item" onClick={() => pick(props.onAddFiles)}>
            <Icon name="file" size={15} className="add-icon" /> Add files
          </button>
          <button className="add-item" onClick={() => pick(props.onAddImage)}>
            <Icon name="image" size={15} className="add-icon" /> Add image
          </button>
          <button className="add-item" onClick={() => pick(props.onAddFolder)}>
            <Icon name="folder" size={15} className="add-icon" /> Add folder
          </button>
          <button className="add-item" onClick={() => pick(props.onSlash)}>
            <Icon name="slash" size={15} className="add-icon" /> Slash commands
          </button>
        </div>
      )}
    </div>
  )
}
