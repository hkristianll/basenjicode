import { useState } from 'react'
import { Icon } from './Icon'

type CopyState = 'idle' | 'done' | 'failed'

/**
 * Copy through the MAIN process, not navigator.clipboard.
 *
 * navigator.clipboard.writeText requires the document to be focused. Whenever the Preview <webview> or
 * devtools holds focus it rejects with "Document is not focused", and the old version swallowed that in
 * an empty catch while still flashing "Copied" — so a failed copy was indistinguishable from a real one.
 * Electron's clipboard has no focus precondition; navigator remains only as a fallback, and the button
 * now reports a failure instead of claiming success.
 */
export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<CopyState>('idle')

  async function copy(): Promise<void> {
    setState((await writeClipboard(text)) ? 'done' : 'failed')
    setTimeout(() => setState('idle'), 1200)
  }

  const label = state === 'done' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'
  return (
    <button className="copy-btn" onClick={copy} title={label} aria-label={label}>
      <Icon name={state === 'done' ? 'check' : state === 'failed' ? 'x' : 'copy'} size={13} /> {label}
    </button>
  )
}

async function writeClipboard(text: string): Promise<boolean> {
  if (!text) return false
  try {
    if (await window.api.clipboard.write(text)) return true
  } catch {
    /* main unreachable — try the renderer API below */
  }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
