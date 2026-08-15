import { useEffect, useState } from 'react'
import { BasenjiPet, type PetState } from './BasenjiPet'
import bedEmptyArt from '../assets/basenji/bed-empty.webp'
import bedSleepArt from '../assets/basenji/bed-sleep.webp'
import bedSleepDogArt from '../assets/basenji/bed-sleep-dog.webp'
import bedSleepBellyUpArt from '../assets/basenji/bed-sleep-belly-up.webp'
import bedSleepBellyUpDogArt from '../assets/basenji/bed-sleep-belly-up-dog.webp'
import bedEntry01Art from '../assets/basenji/bed-entry-01.webp'
import bedEntry02Art from '../assets/basenji/bed-entry-02.webp'
import bedEntry03Art from '../assets/basenji/bed-entry-03.webp'
import bedEntry04Art from '../assets/basenji/bed-entry-04.webp'
import bedEntry05Art from '../assets/basenji/bed-entry-05.webp'
import bedEntry06Art from '../assets/basenji/bed-entry-06.webp'
import bedEntry07Art from '../assets/basenji/bed-entry-07.webp'
import bedEntry08Art from '../assets/basenji/bed-entry-08.webp'
import bedWake01Art from '../assets/basenji/bed-wake-01.webp'
import bedWake02Art from '../assets/basenji/bed-wake-02.webp'
import bedWake03Art from '../assets/basenji/bed-wake-03.webp'
import bedWake04Art from '../assets/basenji/bed-wake-04.webp'
import bedWake05Art from '../assets/basenji/bed-wake-05.webp'
import bedWake06Art from '../assets/basenji/bed-wake-06.webp'
import walkSpriteArt from '../assets/basenji/walk-sprite.png'

type NookPhase = 'awake' | 'tucking' | 'walking-to-bed' | 'settling-in' | 'sleeping' | 'walking-home' | 'rising'

const NEXT_PHASE: Partial<Record<NookPhase, NookPhase>> = {
  tucking: 'walking-to-bed',
  'walking-to-bed': 'settling-in',
  'settling-in': 'sleeping',
  rising: 'walking-home',
  'walking-home': 'awake'
}

const PHASE_DURATION: Partial<Record<NookPhase, number>> = {
  tucking: 460,
  'walking-to-bed': 2160,
  'settling-in': 1280,
  rising: 980,
  'walking-home': 2160
}

const BED_FRAME_MS = 150
const BED_ENTRY_FRAMES = [
  bedEntry01Art,
  bedEntry02Art,
  bedEntry03Art,
  bedEntry04Art,
  bedEntry05Art,
  bedEntry06Art,
  bedEntry07Art,
  bedEntry08Art
]
const BED_WAKE_FRAMES = [
  bedWake01Art,
  bedWake02Art,
  bedWake03Art,
  bedWake04Art,
  bedWake05Art,
  bedWake06Art
]

/** The bed owns the little leave-and-return performance so its click state stays self-contained. */
export function BasenjiNook(props: { state: PetState }) {
  const [phase, setPhase] = useState<NookPhase>('awake')
  const [sleepPose, setSleepPose] = useState(false)
  const [bedFrame, setBedFrame] = useState(0)
  const walking = phase === 'walking-to-bed' || phase === 'walking-home'
  const settlingIn = phase === 'settling-in'
  const waking = phase === 'rising'
  const sleeping = phase === 'sleeping'
  const bedSequenceFrames = settlingIn ? BED_ENTRY_FRAMES : waking ? BED_WAKE_FRAMES : null

  useEffect(() => {
    const next = NEXT_PHASE[phase]
    const duration = PHASE_DURATION[phase]
    if (!next || duration == null) return
    const timer = window.setTimeout(() => setPhase(next), duration)
    return () => window.clearTimeout(timer)
  }, [phase])

  useEffect(() => {
    if (!bedSequenceFrames) {
      setBedFrame(0)
      return
    }
    setBedFrame(0)
    const timer = window.setInterval(() => {
      setBedFrame((frame) => Math.min(frame + 1, bedSequenceFrames.length - 1))
    }, BED_FRAME_MS)
    return () => window.clearInterval(timer)
  }, [bedSequenceFrames])

  useEffect(() => {
    if (!sleeping) {
      setSleepPose(false)
      return
    }
    const timer = window.setInterval(() => setSleepPose((pose) => !pose), 60_000)
    return () => window.clearInterval(timer)
  }, [sleeping])

  const home = phase === 'awake'
    ? 'awake'
    : phase === 'tucking'
      ? 'tucking'
      : phase === 'rising'
        ? 'rising'
        : 'hidden'

  const toggleBed = (): void => {
    if (phase === 'awake') setPhase('tucking')
    if (phase === 'sleeping') setPhase('rising')
  }
  const sleepingBase = sleepPose ? bedSleepBellyUpArt : bedSleepArt
  const sleepingDog = sleepPose ? bedSleepBellyUpDogArt : bedSleepDogArt
  const bedSequenceFrame = bedSequenceFrames?.[Math.min(bedFrame, bedSequenceFrames.length - 1)]

  return (
    <div className={`basenji-nook ${phase}`}>
      <BasenjiPet state={props.state} home={home} />

      <button
        type="button"
        className={`basenji-bed ${sleeping ? 'sleeping' : ''} ${bedSequenceFrame ? 'sequence-hidden' : ''}`}
        onClick={toggleBed}
        disabled={!['awake', 'sleeping'].includes(phase)}
        title={sleeping ? 'Wake your basenji' : 'Send your basenji to bed'}
        aria-label={sleeping ? 'Wake your basenji' : 'Send your basenji to bed'}
      >
        <img className="basenji-bed-base" src={sleeping ? sleepingBase : bedEmptyArt} alt="" draggable={false} />
        {sleeping && <img className="basenji-sleep-breath" src={sleepingDog} alt="" draggable={false} />}
      </button>

      {bedSequenceFrame && (
        <span className={`basenji-bed-sequence ${phase}`} aria-hidden="true">
          <img src={bedSequenceFrame} alt="" draggable={false} />
        </span>
      )}

      {walking && (
        <span className={`basenji-walker ${phase}`} aria-hidden="true">
          <span className="basenji-walk-frame" style={{ backgroundImage: `url(${walkSpriteArt})` }} />
        </span>
      )}
    </div>
  )
}
