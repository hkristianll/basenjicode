import type { VoiceProbeResult, WakeEvent } from '../shared/ipc-types'

/**
 * Thin client for the local voice sidecar (faster-whisper STT + Kokoro TTS).
 * All network access stays in the main process — the renderer never fetches the
 * sidecar directly, exactly like the LM Studio / web tools. Loopback only.
 */

function root(baseURL: string): string {
  return baseURL.replace(/\/+$/, '')
}

export async function probeVoice(baseURL: string): Promise<VoiceProbeResult> {
  try {
    const res = await fetch(`${root(baseURL)}/health`, { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
    const j = (await res.json()) as { stt?: { model?: string; error?: string }; tts?: { voice?: string; error?: string } }
    // Surface a per-engine load error (e.g. a model still downloading) without flipping `ok` false —
    // the sidecar is reachable, just not fully warm.
    const detail = j.stt?.error ? `STT: ${j.stt.error}` : j.tts?.error ? `TTS: ${j.tts.error}` : undefined
    return { ok: true, stt: j.stt?.model, tts: j.tts?.voice, detail }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

export async function transcribe(baseURL: string, wav: ArrayBuffer): Promise<{ text: string; error?: string }> {
  try {
    const res = await fetch(`${root(baseURL)}/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: Buffer.from(wav),
      signal: AbortSignal.timeout(30000)
    })
    const j = (await res.json().catch(() => ({}))) as { text?: string; error?: string }
    if (!res.ok) return { text: '', error: j.error || `HTTP ${res.status}` }
    return { text: j.text ?? '' }
  } catch (e) {
    return { text: '', error: e instanceof Error ? e.message : String(e) }
  }
}

export async function setWake(baseURL: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${root(baseURL)}/wake/${enabled ? 'start' : 'stop'}`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Open a streaming connection to the sidecar's SSE event feed and call `onEvent` per wake event.
 * Returns a stop() that aborts the stream. `onClose` fires when the stream ends (for reconnect).
 */
export function subscribeWake(
  baseURL: string,
  onEvent: (e: WakeEvent) => void,
  onClose: () => void
): () => void {
  const ctrl = new AbortController()
  void (async () => {
    try {
      const res = await fetch(`${root(baseURL)}/events`, {
        headers: { Accept: 'text/event-stream' },
        signal: ctrl.signal
      })
      if (!res.ok || !res.body) return
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const dataLine = block.split('\n').find((l) => l.startsWith('data:'))
          if (dataLine) {
            try {
              onEvent(JSON.parse(dataLine.slice(5).trim()) as WakeEvent)
            } catch {
              /* malformed event — skip */
            }
          }
        }
      }
    } catch {
      /* aborted, or sidecar unreachable */
    } finally {
      if (!ctrl.signal.aborted) onClose()
    }
  })()
  return () => ctrl.abort()
}

export async function speak(baseURL: string, text: string, voice?: string): Promise<{ wav?: ArrayBuffer; error?: string }> {
  try {
    const res = await fetch(`${root(baseURL)}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
      signal: AbortSignal.timeout(30000)
    })
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      return { error: j.error || `HTTP ${res.status}` }
    }
    return { wav: await res.arrayBuffer() }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
