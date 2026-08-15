import { useState } from 'react'
import { Icon } from './Icon'

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* clipboard unavailable */
    }
    setDone(true)
    setTimeout(() => setDone(false), 1200)
  }
  return (
    <button className="copy-btn" onClick={copy} title="Copy" aria-label="Copy">
      <Icon name={done ? 'check' : 'copy'} size={13} /> {done ? 'Copied' : 'Copy'}
    </button>
  )
}
