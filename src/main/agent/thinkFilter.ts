/** Longest suffix of `s` that is a (proper) prefix of `tag` — so a tag split across stream chunks
 *  ("…<thi" then "nk>…") is held back instead of leaking into the visible text. */
export function tagTail(s: string, tag: string): string {
  const max = Math.min(s.length, tag.length - 1)
  for (let n = max; n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return s.slice(s.length - n)
  }
  return ''
}

/** Case-insensitive tagTail across several candidate tags: a held-back partial could be the start of
 *  any of them (e.g. "<thin" may still become <think> OR <thinking>). Returns the longest match. */
function tagTailMulti(s: string, tags: string[]): string {
  let best = ''
  for (const tag of tags) {
    const lt = tag.toLowerCase()
    const max = Math.min(s.length, tag.length - 1)
    for (let n = max; n > best.length; n--) {
      if (lt.startsWith(s.slice(s.length - n).toLowerCase())) {
        best = s.slice(s.length - n)
        break
      }
    }
  }
  return best
}

// Match both the <think> and <thinking> spellings, case-insensitively, in the STREAMING path (not just
// the stripThinkTags backstop) so chain-of-thought never flashes into the visible bubble then vanishes.
const OPEN_RE = /<think(?:ing)?>/i
const CLOSE_RE = /<\/think(?:ing)?>/i
const OPEN_TAGS = ['<think>', '<thinking>']
const CLOSE_TAGS = ['</think>', '</thinking>']

/** Backstop for any <think>/<thinking> chain-of-thought that slipped past the streaming filter (e.g.
 *  a non-streamed completion or the <thinking> variant) so it never shows in the visible bubble. */
export function stripThinkTags(s: string): string {
  return s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').replace(/<\/?think(?:ing)?>/gi, '').trim()
}

/**
 * Streaming filter that pulls inline <think>…</think> chain-of-thought (Qwen3 et al. emit it in the
 * CONTENT stream) out of the visible text and routes it to reasoning. Stateful across chunks: a tag
 * split between two chunks is buffered, never leaked. Feed each content delta to push(); call flush()
 * once at stream end.
 */
export class ThinkFilter {
  private inThink = false
  private carry = ''

  push(chunk: string): { visible: string; reasoning: string } {
    let s = this.carry + chunk
    this.carry = ''
    let visible = ''
    let reasoning = ''
    while (s) {
      if (this.inThink) {
        const m = CLOSE_RE.exec(s)
        if (!m) {
          const keep = tagTailMulti(s, CLOSE_TAGS)
          reasoning += s.slice(0, s.length - keep.length)
          this.carry = keep
          s = ''
        } else {
          reasoning += s.slice(0, m.index)
          s = s.slice(m.index + m[0].length)
          this.inThink = false
        }
      } else {
        const m = OPEN_RE.exec(s)
        if (!m) {
          const keep = tagTailMulti(s, OPEN_TAGS)
          visible += s.slice(0, s.length - keep.length)
          this.carry = keep
          s = ''
        } else {
          visible += s.slice(0, m.index)
          s = s.slice(m.index + m[0].length)
          this.inThink = true
        }
      }
    }
    return { visible, reasoning }
  }

  /** Trailing partial tag at stream end: reasoning if we ended mid-<think>, else it was never a tag. */
  flush(): { visible: string; reasoning: string } {
    const c = this.carry
    this.carry = ''
    if (!c) return { visible: '', reasoning: '' }
    return this.inThink ? { visible: '', reasoning: c } : { visible: c, reasoning: '' }
  }
}
