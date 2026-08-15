import { describe, it, expect } from 'vitest'
import { stripForSpeech, segmentSentences, endsComplete, pullSentences } from './narration'

describe('stripForSpeech', () => {
  it('drops fenced code blocks entirely', () => {
    const out = stripForSpeech('Here is the fix:\n```ts\nconst x = 1\n```\nDone.')
    expect(out).not.toContain('const x')
    expect(out).toContain('Here is the fix')
    expect(out).toContain('Done.')
  })

  it('holds everything from an unclosed (still-streaming) fence onward', () => {
    expect(stripForSpeech('Updating it now.\n```ts\nconst y =')).toBe('Updating it now.')
  })

  it('strips inline code, links (keeping text), and bare URLs', () => {
    expect(stripForSpeech('Call `doThing()` per [the docs](https://x.io/y) now.')).toBe('Call per the docs now.')
    expect(stripForSpeech('See https://example.com/a for details.')).toBe('See for details.')
  })

  it('removes slash-bearing file paths', () => {
    expect(stripForSpeech('I edited src/main/index.ts and styles/main.css for you.')).toBe('I edited and for you.')
  })

  it('strips markdown emphasis, headings, and list markers', () => {
    expect(stripForSpeech('## Plan\n- **First** step\n- _second_ step')).toBe('Plan\nFirst step\nsecond step')
  })
})

describe('segmentSentences', () => {
  it('splits on sentence-final punctuation, keeping it', () => {
    expect(segmentSentences('Done. It works! Really?')).toEqual(['Done.', 'It works!', 'Really?'])
  })

  it('returns a trailing fragment as the last element', () => {
    expect(segmentSentences('All set. Now I will')).toEqual(['All set.', 'Now I will'])
  })

  it('is empty for blank input', () => {
    expect(segmentSentences('   ')).toEqual([])
  })
})

describe('endsComplete', () => {
  it('detects terminal punctuation', () => {
    expect(endsComplete('Done.')).toBe(true)
    expect(endsComplete('Wait')).toBe(false)
    expect(endsComplete('Really?"')).toBe(true)
  })
})

describe('pullSentences (streaming)', () => {
  it('holds the trailing fragment until more arrives, then flushes on final', () => {
    const a = pullSentences('Hello there. I am NordC', 0, false)
    expect(a.sentences).toEqual(['Hello there.'])
    expect(a.spoken).toBe(1)

    const b = pullSentences('Hello there. I am NordCode online.', a.spoken, false)
    expect(b.sentences).toEqual(['I am NordCode online.'])

    // Nothing new, not final → nothing more to say.
    const c = pullSentences('Hello there. I am NordCode online.', b.spoken, false)
    expect(c.sentences).toEqual([])
  })

  it('flushes an unterminated final fragment when the turn ends', () => {
    const r = pullSentences('Working on it', 0, true)
    expect(r.sentences).toEqual(['Working on it'])
  })

  it('never re-speaks code that was stripped out', () => {
    const buf = 'Applying the patch.\n```ts\nconst z = 2\n```\n'
    const r = pullSentences(buf, 0, false)
    expect(r.sentences).toEqual(['Applying the patch.'])
  })
})
