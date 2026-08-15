import { describe, expect, it } from 'vitest'
import { buildResumeMessages, isMidStreamDropError, MAX_STREAM_RESUMES, OverlapTrimmer } from './streamResume'

describe('isMidStreamDropError', () => {
  it('matches transport-shaped failures', () => {
    expect(isMidStreamDropError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isMidStreamDropError(Object.assign(new Error('boom'), { code: 'EPIPE' }))).toBe(true)
    expect(isMidStreamDropError(new Error('Premature close'))).toBe(true)
    expect(isMidStreamDropError(new Error('fetch failed'))).toBe(true)
    expect(isMidStreamDropError(new Error('terminated'))).toBe(true)
    const apiConn = new Error('Connection error.')
    apiConn.name = 'APIConnectionError'
    expect(isMidStreamDropError(apiConn)).toBe(true)
  })

  it('rejects non-transport failures (server verdicts, user abort, nonsense)', () => {
    expect(isMidStreamDropError(new Error('400 Bad Request'))).toBe(false)
    expect(isMidStreamDropError(new Error('model_not_found: no such model'))).toBe(false)
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    expect(isMidStreamDropError(abort)).toBe(false)
    expect(isMidStreamDropError(null)).toBe(false)
    expect(isMidStreamDropError('str')).toBe(false)
  })
})

describe('buildResumeMessages', () => {
  it('appends the partial as the assistant turn plus the continue steer, without mutating the input', () => {
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'do the thing' }
    ]
    const out = buildResumeMessages(messages, 'I started by')
    expect(messages).toHaveLength(2) // input untouched
    expect(out).toHaveLength(4)
    expect(out[2]).toMatchObject({ role: 'assistant', content: 'I started by' })
    expect(out[3].role).toBe('system')
    expect(out[3].content).toMatch(/cut off mid-stream/i)
    expect(out[3].content).toMatch(/do not repeat/i)
  })
})

describe('OverlapTrimmer', () => {
  const collect = (trimmer: OverlapTrimmer, chunks: string[]): string =>
    chunks.map((c) => trimmer.push(c)).join('') + trimmer.flush()

  it('trims a regenerated overlap at the seam exactly once', () => {
    const committed = 'The fix lives in the parser: it drops the trailing comma'
    const trimmer = new OverlapTrimmer(committed)
    // The model restarts from inside the committed text, as weak models do despite the steer.
    const out = collect(trimmer, ['it drops the trailing comma', ' before the close brace.'])
    expect(out).toBe(' before the close brace.')
    expect(committed + out).toBe('The fix lives in the parser: it drops the trailing comma before the close brace.')
  })

  it('passes a genuine continuation through untouched (no overlap)', () => {
    const trimmer = new OverlapTrimmer('Step one is complete.')
    expect(collect(trimmer, [' Step two: run the', ' tests and report.'])).toBe(' Step two: run the tests and report.')
  })

  it('holds back the head, then streams the rest through unbuffered', () => {
    const trimmer = new OverlapTrimmer('abcdefghijklmnopqrstuvwxyz')
    expect(trimmer.push('short')).toBe('') // below the holdback — still buffering
    const settled = trimmer.push('x'.repeat(300)) // crosses the holdback — settles, no overlap found
    expect(settled).toBe('short' + 'x'.repeat(300))
    expect(trimmer.push('tail')).toBe('tail') // passthrough after settling
    expect(trimmer.flush()).toBe('')
  })

  it('does not trim tiny chance matches (below the minimum overlap)', () => {
    const trimmer = new OverlapTrimmer('I will check the ')
    // Continuation happens to start with "the " (4 chars) — chance, not repetition; nothing is trimmed.
    expect(collect(trimmer, ['the config file next.'])).toBe('the config file next.')
  })

  it('settles at flush when the whole continuation is shorter than the holdback', () => {
    const trimmer = new OverlapTrimmer('and now the final answer is')
    expect(trimmer.push('the final answer is 42.')).toBe('')
    expect(trimmer.flush()).toBe(' 42.')
  })

  it('exposes a sane resume budget', () => {
    expect(MAX_STREAM_RESUMES).toBe(2)
  })
})
