/**
 * Turn a coding agent's markdown reply into something worth *speaking*.
 *
 * The transcript is full of things you never want read aloud — fenced code, diffs,
 * inline identifiers, file paths, URLs, markdown punctuation. `stripForSpeech` reduces
 * a reply to clean prose; `segmentSentences` chops that into sentence-sized chunks so
 * the TTS can start talking while the model is still generating.
 */

/** Strip markdown / code / paths down to plain narratable prose. */
export function stripForSpeech(text: string): string {
  let t = text

  // Closed fenced code blocks → gone entirely (never speak code).
  t = t.replace(/```[\s\S]*?```/g, ' ')
  // An unclosed trailing fence means code is still streaming in — drop from it onward so we
  // don't start narrating a half-written code block.
  const openFence = t.indexOf('```')
  if (openFence !== -1) t = t.slice(0, openFence)

  // Inline code, images, links (keep the link's text, drop the URL).
  t = t.replace(/`[^`]*`/g, ' ')
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')

  // Line-leading markdown: headings, blockquotes, list bullets, ordered markers, table pipes.
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  t = t.replace(/^\s{0,3}>\s?/gm, '')
  t = t.replace(/^\s*[-*+]\s+/gm, '')
  t = t.replace(/^\s*\d+\.\s+/gm, '')
  t = t.replace(/\|/g, ' ')

  // Emphasis / bold / strikethrough markers.
  t = t.replace(/[*_~]{1,3}/g, '')

  // Bare URLs and slash-bearing tokens (file paths like src/main/index.ts) — unspeakable noise.
  t = t.replace(/https?:\/\/\S+/g, ' ')
  t = t.replace(/\S*\/\S+/g, ' ')

  // Collapse whitespace.
  return t.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim()
}

/**
 * Split prose into sentences, keeping terminal punctuation. A trailing fragment with no
 * sentence-ending punctuation comes back as the final element, so a streaming caller can hold
 * it until more text (or the end of the turn) arrives.
 */
export function segmentSentences(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const parts = clean.match(/[^.!?]*[.!?]+(?=\s|$)|[^.!?]+$/g) ?? []
  return parts.map((s) => s.trim()).filter(Boolean)
}

/** True when the text ends on sentence-final punctuation (so the last segment is complete). */
export function endsComplete(text: string): boolean {
  return /[.!?]["')\]]*\s*$/.test(text)
}

/**
 * Pull newly-complete sentences out of a growing buffer.
 *
 * `alreadySpoken` is how many sentences the caller has already emitted. Returns the next
 * complete ones plus the new count. While streaming (`final` false) the trailing fragment is
 * held back unless the buffer already ends on punctuation; on `final` everything is flushed.
 */
export function pullSentences(
  buffer: string,
  alreadySpoken: number,
  final: boolean
): { sentences: string[]; spoken: number } {
  const prose = stripForSpeech(buffer)
  const all = segmentSentences(prose)
  const upto = final || endsComplete(prose) ? all.length : all.length - 1
  const sentences: string[] = []
  let spoken = alreadySpoken
  for (let i = alreadySpoken; i < upto; i++) {
    const s = all[i]?.trim()
    if (s) sentences.push(s)
    spoken = i + 1
  }
  return { sentences, spoken }
}
