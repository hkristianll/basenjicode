/** Encode mono Float32 PCM ([-1,1]) as a 16-bit little-endian WAV. faster-whisper resamples
 *  to 16 kHz on its side, so we can hand it the AudioContext's native rate untouched. */
export function encodeWavMono(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataLen = samples.length * 2
  const buf = new ArrayBuffer(44 + dataLen)
  const view = new DataView(buf)

  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataLen, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, dataLen, true)

  let off = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    off += 2
  }
  return buf
}

/** Down-mix a multi-channel AudioBuffer to a single Float32 track. */
export function downmixToMono(buffer: AudioBuffer): Float32Array {
  const ch = buffer.numberOfChannels
  if (ch === 1) return buffer.getChannelData(0).slice()
  const len = buffer.length
  const out = new Float32Array(len)
  for (let c = 0; c < ch; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < len; i++) out[i] += data[i] / ch
  }
  return out
}
