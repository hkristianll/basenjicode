import { useEffect, useRef } from 'react'

export type OrbState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'

const HINT: Record<OrbState, string> = {
  idle: 'Hold to talk',
  listening: 'Listening…',
  transcribing: 'Transcribing…',
  thinking: 'Thinking…',
  speaking: 'Speaking…'
}

/**
 * The arc-reactor orb: hold to talk (push-to-talk), and an at-a-glance state indicator the
 * rest of the time. Audio amplitude (`levelRef`, 0..1) is pushed into a CSS variable every
 * frame so the rings pulse with your voice / the reply without re-rendering React.
 */
export function VoiceOrb(props: {
  state: OrbState
  levelRef: React.MutableRefObject<number>
  disabled?: boolean
  onPressStart: () => void
  onPressEnd: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      const el = ref.current
      if (el) el.style.setProperty('--level', props.levelRef.current.toFixed(3))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [props.levelRef])

  // Press-and-hold. pointerup/leave/cancel all end the take so a drag-off can't wedge it open.
  const start = (e: React.PointerEvent): void => {
    if (props.disabled) return
    e.preventDefault()
    props.onPressStart()
  }
  const end = (e: React.PointerEvent): void => {
    e.preventDefault()
    props.onPressEnd()
  }

  return (
    <button
      ref={ref}
      type="button"
      className={`voice-orb ${props.state}`}
      disabled={props.disabled}
      onPointerDown={start}
      onPointerUp={end}
      onPointerLeave={end}
      onPointerCancel={end}
      title={HINT[props.state]}
      aria-label={HINT[props.state]}
      aria-pressed={props.state === 'listening'}
    >
      <span className="orb-aura" aria-hidden="true" />
      <span className="orb-ring ring-a" aria-hidden="true" />
      <span className="orb-ring ring-b" aria-hidden="true" />
      <span className="orb-core" aria-hidden="true" />
      <svg className="orb-glyph" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path
          d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"
          fill="currentColor"
        />
        <path
          d="M5 11a7 7 0 0 0 14 0M12 18v3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </button>
  )
}
