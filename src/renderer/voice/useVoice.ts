import { useCallback, useEffect, useRef, useState } from 'react'
import type { Settings } from '../../shared/domain-types'
import type { AgentEvent, VoiceProbeResult } from '../../shared/ipc-types'
import { pullSentences } from './narration'
import { encodeWavMono } from './wav'
import { toast } from '../toast'
import { VOICE_FEATURE_ENABLED } from '../../shared/features'

export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'speaking'

interface Capture {
  stream: MediaStream
  srcNode: MediaStreamAudioSourceNode
  processor: ScriptProcessorNode
  chunks: Float32Array[]
  sampleRate: number
}

interface Streamer {
  turnId: string
  buffer: string
  spoken: number
}

export interface VoiceApi {
  state: VoiceState
  enabled: boolean
  sidecar: VoiceProbeResult | null
  /** 0..1 amplitude, updated outside React so the orb can animate without re-rendering the app. */
  levelRef: React.MutableRefObject<number>
  startPTT(): void
  stopPTT(): void
  stopSpeaking(): void
  /** App pipes agent events here so replies can be spoken as they stream. */
  feed(sid: string, e: AgentEvent): void
}

/**
 * The whole voice loop in one hook: push-to-talk capture → STT, and streaming reply → TTS,
 * with barge-in. Talks only to `window.api.voice` (main owns the sidecar HTTP).
 */
export function useVoice(opts: {
  settings: Settings | null
  activeSessionId: string | null
  onTranscript: (text: string, o?: { forceSend?: boolean }) => void
}): VoiceApi {
  const [state, setState] = useState<VoiceState>('idle')
  const [sidecar, setSidecar] = useState<VoiceProbeResult | null>(null)

  // Feature-flagged off: the hook stays mounted but inert (no orb, no mic, no wake, no TTS).
  const enabled = VOICE_FEATURE_ENABLED && !!opts.settings?.voice.enabled

  // Refs mirrored every render so the stable callbacks below read fresh values.
  const settingsRef = useRef(opts.settings)
  settingsRef.current = opts.settings
  const sessionRef = useRef(opts.activeSessionId)
  sessionRef.current = opts.activeSessionId
  const onTranscriptRef = useRef(opts.onTranscript)
  onTranscriptRef.current = opts.onTranscript
  const stateRef = useRef<VoiceState>('idle')
  const setVoiceState = useCallback((s: VoiceState) => {
    stateRef.current = s
    setState(s)
  }, [])

  // ---- shared audio plumbing ------------------------------------------------
  const ctxRef = useRef<AudioContext | null>(null)
  const levelRef = useRef(0)
  const activeAnalyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)

  const ensureCtx = useCallback((): AudioContext => {
    if (!ctxRef.current || ctxRef.current.state === 'closed') {
      ctxRef.current = new AudioContext()
    }
    if (ctxRef.current.state === 'suspended') void ctxRef.current.resume()
    return ctxRef.current
  }, [])

  const levelLoop = useCallback(() => {
    const an = activeAnalyserRef.current
    if (an) {
      const buf = new Uint8Array(an.fftSize)
      an.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128
        sum += v * v
      }
      levelRef.current = Math.min(1, Math.sqrt(sum / buf.length) * 3)
    }
    rafRef.current = requestAnimationFrame(levelLoop)
  }, [])

  const startLevel = useCallback(
    (an: AnalyserNode) => {
      activeAnalyserRef.current = an
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(levelLoop)
    },
    [levelLoop]
  )

  const stopLevel = useCallback(() => {
    activeAnalyserRef.current = null
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    levelRef.current = 0
  }, [])

  // ---- text-to-speech (streaming queue + barge-in) --------------------------
  const queueRef = useRef<string[]>([])
  const speakingRef = useRef(false)
  const genRef = useRef(0) // bumped on barge-in to abandon in-flight playback
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const streamerRef = useRef<Streamer | null>(null)

  const playWav = useCallback(
    async (wav: ArrayBuffer, gen: number): Promise<void> => {
      const ctx = ensureCtx()
      const audio = await ctx.decodeAudioData(wav)
      if (gen !== genRef.current) return
      const src = ctx.createBufferSource()
      src.buffer = audio
      const an = ctx.createAnalyser()
      an.fftSize = 512
      src.connect(an)
      an.connect(ctx.destination)
      sourceRef.current = src
      startLevel(an)
      await new Promise<void>((resolve) => {
        src.onended = () => resolve()
        src.start()
      })
      if (sourceRef.current === src) sourceRef.current = null
    },
    [ensureCtx, startLevel]
  )

  const playLoop = useCallback(
    async (gen: number): Promise<void> => {
      speakingRef.current = true
      if (stateRef.current !== 'listening') setVoiceState('speaking')
      while (queueRef.current.length) {
        if (gen !== genRef.current) break
        const sentence = queueRef.current.shift() as string
        const { wav, error } = await window.api.voice.speak({ text: sentence })
        if (gen !== genRef.current) break
        if (error || !wav) continue
        try {
          await playWav(wav, gen)
        } catch {
          /* decode/playback hiccup — skip this sentence rather than wedging the queue */
        }
      }
      speakingRef.current = false
      if (gen === genRef.current) {
        stopLevel()
        if (stateRef.current === 'speaking') setVoiceState('idle')
      }
    },
    [playWav, setVoiceState, stopLevel]
  )

  const enqueueSpeak = useCallback(
    (sentence: string) => {
      queueRef.current.push(sentence)
      if (!speakingRef.current) void playLoop(genRef.current)
    },
    [playLoop]
  )

  const stopSpeaking = useCallback(() => {
    genRef.current++
    queueRef.current = []
    streamerRef.current = null
    try {
      sourceRef.current?.stop()
    } catch {
      /* already stopped */
    }
    sourceRef.current = null
    speakingRef.current = false
    stopLevel()
    if (stateRef.current === 'speaking') setVoiceState('idle')
  }, [setVoiceState, stopLevel])

  // ---- feed: agent events → spoken sentences --------------------------------
  const feed = useCallback(
    (sid: string, e: AgentEvent) => {
      if (!settingsRef.current?.voice.speakReplies) return
      if (sid !== sessionRef.current) return
      if (e.type === 'assistant-delta') {
        let s = streamerRef.current
        if (!s || s.turnId !== e.turnId) {
          s = { turnId: e.turnId, buffer: '', spoken: 0 }
          streamerRef.current = s
        }
        s.buffer += e.text
        const { sentences, spoken } = pullSentences(s.buffer, s.spoken, false)
        s.spoken = spoken
        sentences.forEach(enqueueSpeak)
      } else if (e.type === 'assistant-message-done' || e.type === 'turn-done') {
        const s = streamerRef.current
        if (s && s.turnId === e.turnId) {
          const { sentences } = pullSentences(s.buffer, s.spoken, true)
          sentences.forEach(enqueueSpeak)
          // An assistant message can be followed by tool calls + another message in the same turn;
          // reset so the next message starts a fresh buffer.
          streamerRef.current = e.type === 'turn-done' ? null : { turnId: e.turnId, buffer: '', spoken: 0 }
        }
      }
    },
    [enqueueSpeak]
  )

  // ---- speech-to-text (push-to-talk) ----------------------------------------
  const captureRef = useRef<Capture | null>(null)

  const startPTT = useCallback(() => {
    if (captureRef.current) return
    stopSpeaking() // barge-in: talking over the agent cancels its speech
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        })
        const ctx = ensureCtx()
        // Grab raw PCM straight off the graph (no MediaRecorder/webm → no decodeAudioData surprises).
        const srcNode = ctx.createMediaStreamSource(stream)
        const processor = ctx.createScriptProcessor(4096, 1, 1)
        const chunks: Float32Array[] = []
        processor.onaudioprocess = (ev) => {
          chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)))
        }
        const an = ctx.createAnalyser()
        an.fftSize = 512
        srcNode.connect(an)
        srcNode.connect(processor)
        // The processor only fires while connected to a destination; it writes no output, so this is silent.
        processor.connect(ctx.destination)
        captureRef.current = { stream, srcNode, processor, chunks, sampleRate: ctx.sampleRate }
        setVoiceState('listening')
        startLevel(an)
      } catch {
        toast.error('Microphone unavailable — check Windows mic permissions.')
        setVoiceState('idle')
      }
    })()
  }, [ensureCtx, setVoiceState, startLevel, stopSpeaking])

  const stopPTT = useCallback(() => {
    const cap = captureRef.current
    if (!cap) return
    captureRef.current = null
    setVoiceState('transcribing')
    stopLevel()
    cap.processor.onaudioprocess = null
    cap.processor.disconnect()
    cap.srcNode.disconnect()
    cap.stream.getTracks().forEach((t) => t.stop())
    void (async () => {
      try {
        const total = cap.chunks.reduce((n, c) => n + c.length, 0)
        if (total === 0) {
          setVoiceState('idle')
          return
        }
        const pcm = new Float32Array(total)
        let off = 0
        for (const c of cap.chunks) {
          pcm.set(c, off)
          off += c.length
        }
        const wav = encodeWavMono(pcm, cap.sampleRate)
        const { text, error } = await window.api.voice.transcribe({ wav })
        if (error) {
          toast.error(`Transcription failed: ${error}`)
        } else {
          const t = text.trim()
          if (t) onTranscriptRef.current(t)
        }
      } catch {
        toast.error('Could not process the recording.')
      } finally {
        if (stateRef.current === 'transcribing') setVoiceState('idle')
      }
    })()
  }, [setVoiceState, stopLevel])

  // ---- hands-free ("Hey Jarvis") --------------------------------------------
  const wakeWanted = enabled && !!opts.settings?.voice.wakeWord
  // Tell main to start/stop the sidecar wake listener as the setting changes.
  useEffect(() => {
    void window.api.voice.setWake(wakeWanted)
    return () => {
      void window.api.voice.setWake(false)
    }
  }, [wakeWanted, opts.settings?.voice.sidecarURL])
  // React to wake events forwarded from the sidecar.
  useEffect(() => {
    const unsub = window.api.voice.onWakeEvent((e) => {
      if (e.type === 'wake') {
        stopSpeaking() // saying the wake word interrupts a reply in progress
        setVoiceState('listening')
      } else if (e.type === 'listening') {
        setVoiceState('listening')
      } else if (e.type === 'transcribing') {
        setVoiceState('transcribing')
      } else if (e.type === 'command') {
        setVoiceState('idle')
        const t = e.text.trim()
        if (t) onTranscriptRef.current(t, { forceSend: true }) // a spoken command always sends
      } else if (e.type === 'idle') {
        setVoiceState('idle')
      } else if (e.type === 'error') {
        toast.error(`Hey Jarvis: ${e.detail}`)
        setVoiceState('idle')
      }
    })
    return () => unsub()
  }, [stopSpeaking, setVoiceState])

  // ---- sidecar health while voice is enabled --------------------------------
  useEffect(() => {
    if (!enabled) {
      setSidecar(null)
      return
    }
    let active = true
    const run = async (): Promise<void> => {
      const r = await window.api.voice.probe()
      if (active) setSidecar(r)
    }
    void run()
    const t = setInterval(() => void run(), 5000)
    return () => {
      active = false
      clearInterval(t)
    }
  }, [enabled, opts.settings?.voice.sidecarURL])

  // ---- teardown on unmount --------------------------------------------------
  useEffect(() => {
    return () => {
      stopSpeaking()
      captureRef.current?.stream.getTracks().forEach((t) => t.stop())
      captureRef.current = null
      stopLevel()
      void ctxRef.current?.close().catch(() => undefined)
      ctxRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { state, enabled, sidecar, levelRef, startPTT, stopPTT, stopSpeaking, feed }
}
