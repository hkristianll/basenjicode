import { describe, it, expect } from 'vitest'
import { ThinkFilter, stripThinkTags, tagTail } from './thinkFilter'

/** Feed chunks through a fresh filter; return concatenated visible + reasoning. */
function run(chunks: string[]): { visible: string; reasoning: string } {
  const f = new ThinkFilter()
  let visible = ''
  let reasoning = ''
  for (const c of chunks) {
    const r = f.push(c)
    visible += r.visible
    reasoning += r.reasoning
  }
  const t = f.flush()
  visible += t.visible
  reasoning += t.reasoning
  return { visible, reasoning }
}

describe('ThinkFilter', () => {
  it('routes a whole think span to reasoning and keeps the answer visible', () => {
    const { visible, reasoning } = run(['<think>plan it out</think>The answer is 42.'])
    expect(visible).toBe('The answer is 42.')
    expect(reasoning).toBe('plan it out')
  })

  it('handles a tag split across chunk boundaries (the key case)', () => {
    const { visible, reasoning } = run(['Hi <th', 'ink>secret rea', 'soning</thi', 'nk>done'])
    expect(visible).toBe('Hi done')
    expect(reasoning).toBe('secret reasoning')
  })

  it('passes through plain content untouched', () => {
    expect(run(['just ', 'a normal ', 'reply']).visible).toBe('just a normal reply')
  })

  it('treats an unclosed think (stream ended mid-thought) as reasoning, not visible', () => {
    const { visible, reasoning } = run(['answer<think>still thinking'])
    expect(visible).toBe('answer')
    expect(reasoning).toBe('still thinking')
  })

  it('does not leak a lone < that is not a think tag', () => {
    expect(run(['a < b and 1<2']).visible).toBe('a < b and 1<2')
  })

  it('handles the <thinking> spelling in the streaming path (not just the backstop)', () => {
    const { visible, reasoning } = run(['<thinking>plan</thinking>answer'])
    expect(visible).toBe('answer')
    expect(reasoning).toBe('plan')
  })

  it('is case-insensitive on the streaming tags', () => {
    const { visible, reasoning } = run(['<THINK>x</THINK>y'])
    expect(visible).toBe('y')
    expect(reasoning).toBe('x')
  })

  it('handles a <thinking> tag split across chunk boundaries', () => {
    const { visible, reasoning } = run(['<thinki', 'ng>deep</thinkin', 'g>ok'])
    expect(visible).toBe('ok')
    expect(reasoning).toBe('deep')
  })
})

describe('stripThinkTags backstop', () => {
  it('removes a full think block and the <thinking> variant', () => {
    expect(stripThinkTags('<think>x</think>visible')).toBe('visible')
    expect(stripThinkTags('<thinking>y</thinking> hi ')).toBe('hi')
  })
})

describe('tagTail', () => {
  it('returns the suffix that is a prefix of the tag', () => {
    expect(tagTail('hello <thi', '<think>')).toBe('<thi')
    expect(tagTail('no partial here', '<think>')).toBe('')
  })
})
