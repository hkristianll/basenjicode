import { useEffect, useRef, useState } from 'react'
import headArt from '../assets/basenji/head.webp'
import blinkHalfArt from '../assets/basenji/head-blink-half.webp'
import blinkSlitArt from '../assets/basenji/head-blink-slit.webp'
import blinkArt from '../assets/basenji/head-blink.webp'
import tiltStartArt from '../assets/basenji/head-tilt-start.webp'
import tiltMidArt from '../assets/basenji/head-tilt-mid.webp'
import tiltLightArt from '../assets/basenji/head-tilt.webp'
import tiltPeakArt from '../assets/basenji/head-tilt-peak.webp'
import alertArt from '../assets/basenji/head-alert.webp'
import barooArt from '../assets/basenji/head-baroo-up-corrected.webp'
import pawsArt from '../assets/basenji/paws.webp'

export type PetState = 'idle' | 'thinking' | 'working' | 'happy'

const HINT: Record<PetState, string> = {
  idle: 'Your basenji is keeping you company',
  thinking: 'Sniffing out an answer…',
  working: 'On the hunt — working…',
  happy: 'Good dog!'
}

type PetFrame = {
  art: string
  className: string
  duration: number
}

const NEUTRAL: PetFrame = { art: headArt, className: 'neutral', duration: 0 }

const BLINK: PetFrame[] = [
  { art: blinkHalfArt, className: 'blink-half', duration: 45 },
  { art: blinkSlitArt, className: 'blink-slit', duration: 45 },
  { art: blinkArt, className: 'blink', duration: 80 },
  { art: blinkSlitArt, className: 'blink-slit', duration: 45 },
  { art: blinkHalfArt, className: 'blink-half', duration: 55 }
]

const CURIOUS_TILT: PetFrame[] = [
  { art: tiltStartArt, className: 'tilt-start', duration: 120 },
  { art: tiltMidArt, className: 'tilt-mid', duration: 140 },
  { art: tiltLightArt, className: 'tilt-light', duration: 180 },
  { art: tiltPeakArt, className: 'tilt-peak', duration: 420 },
  { art: tiltLightArt, className: 'tilt-light', duration: 150 },
  { art: tiltMidArt, className: 'tilt-mid', duration: 130 },
  { art: tiltStartArt, className: 'tilt-start', duration: 110 }
]

const ALERT_GLANCE: PetFrame[] = [
  { art: alertArt, className: 'alert', duration: 220 },
  { art: headArt, className: 'neutral', duration: 90 }
]

const pickIdleBeat = (state: PetState): PetFrame[] => {
  if (state === 'working') return Math.random() < 0.48 ? ALERT_GLANCE : BLINK
  if (state === 'thinking') return Math.random() < 0.38 ? CURIOUS_TILT : BLINK
  return Math.random() < 0.22 ? CURIOUS_TILT : BLINK
}

const idleDelay = (state: PetState): number => {
  const jitter = Math.floor(Math.random() * 900)
  if (state === 'working') return 1800 + jitter
  if (state === 'thinking') return 2300 + jitter
  return 3600 + Math.floor(Math.random() * 1800)
}

/**
 * The basenji peeks out directly over the send button. Each beat is a separate, matched photo
 * frame so the blink, head tilt, and baroo play as a small performance rather than a CSS bobble.
 */
export function BasenjiPet(props: { state: PetState, home?: 'awake' | 'tucking' | 'hidden' | 'rising' }) {
  const [petted, setPetted] = useState(false)
  const [frame, setFrame] = useState<PetFrame>(NEUTRAL)
  const timer = useRef<number | undefined>(undefined)
  const beatTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  useEffect(() => {
    const state: PetState = petted ? 'happy' : props.state
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let cancelled = false

    const clearBeat = (): void => window.clearTimeout(beatTimer.current)

    if (reduceMotion.matches || state === 'happy') {
      clearBeat()
      setFrame(NEUTRAL)
      return clearBeat
    }

    const scheduleIdle = (): void => {
      beatTimer.current = window.setTimeout(() => playBeat(pickIdleBeat(state), 0), idleDelay(state))
    }

    const playBeat = (frames: PetFrame[], index: number): void => {
      if (cancelled) return
      if (index >= frames.length) {
        setFrame(NEUTRAL)
        scheduleIdle()
        return
      }
      const next = frames[index]
      setFrame(next)
      beatTimer.current = window.setTimeout(() => playBeat(frames, index + 1), next.duration)
    }

    setFrame(NEUTRAL)
    scheduleIdle()

    return () => {
      cancelled = true
      clearBeat()
    }
  }, [petted, props.state])

  const state: PetState = petted ? 'happy' : props.state
  const activeFrame = state === 'happy'
    ? { art: barooArt, className: 'baroo' }
    : frame

  const pet = (): void => {
    setPetted(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setPetted(false), 1600)
  }

  return (
    <button
      type="button"
      className={`basenji-pet ${state} home-${props.home ?? 'awake'}`}
      onClick={pet}
      title={HINT[state]}
      aria-label={HINT[state]}
    >
      <span className="basenji-pet-head back" aria-hidden="true">
        <img className={`basenji-head-frame ${activeFrame.className}`} src={activeFrame.art} alt="" draggable={false} />
      </span>
      <span className="basenji-pet-head snout" aria-hidden="true">
        <img className={`basenji-head-frame ${activeFrame.className}`} src={activeFrame.art} alt="" draggable={false} />
      </span>
      <span className="basenji-pet-paws" aria-hidden="true">
        <img src={pawsArt} alt="" draggable={false} />
      </span>
    </button>
  )
}
