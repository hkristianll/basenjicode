import { describe, it, expect } from 'vitest'
import { htmlToText, isBlockedHost, isBlockedHostForPreview, parseDuckDuckGoHtml } from './web-util'

describe('htmlToText', () => {
  it('strips tags and keeps text', () => {
    expect(htmlToText('<p>Hello <b>world</b></p>')).toBe('Hello world')
  })

  it('drops script and style content', () => {
    const html = '<style>.a{color:red}</style><p>Keep</p><script>evil()</script>'
    expect(htmlToText(html)).toBe('Keep')
  })

  it('decodes entities (named and numeric)', () => {
    expect(htmlToText('a &amp; b &#39;q&#39; &lt;x&gt;')).toBe("a & b 'q' <x>")
  })

  it('turns <br> and block ends into newlines', () => {
    expect(htmlToText('one<br>two<p>three</p>')).toBe('one\ntwo\nthree')
  })
})

describe('isBlockedHost', () => {
  it('blocks loopback and localhost', () => {
    expect(isBlockedHost('localhost')).toBe(true)
    expect(isBlockedHost('127.0.0.1')).toBe(true)
    expect(isBlockedHost('::1')).toBe(true)
  })

  it('blocks private and link-local ranges', () => {
    expect(isBlockedHost('10.1.2.3')).toBe(true)
    expect(isBlockedHost('192.168.0.1')).toBe(true)
    expect(isBlockedHost('172.16.5.5')).toBe(true)
    expect(isBlockedHost('169.254.169.254')).toBe(true)
  })

  it('allows public hosts and out-of-range 172.x', () => {
    expect(isBlockedHost('example.com')).toBe(false)
    expect(isBlockedHost('8.8.8.8')).toBe(false)
    expect(isBlockedHost('172.32.0.1')).toBe(false)
  })

  it('blocks IPv4-mapped IPv6 forms (the bypass)', () => {
    expect(isBlockedHost('::ffff:127.0.0.1')).toBe(true)
    expect(isBlockedHost('::ffff:7f00:1')).toBe(true) // hex form of 127.0.0.1
    expect(isBlockedHost('::ffff:169.254.169.254')).toBe(true) // mapped cloud metadata
    expect(isBlockedHost('[::ffff:10.0.0.1]')).toBe(true) // bracketed
  })
})

describe('isBlockedHostForPreview', () => {
  it('ALLOWS loopback so local dev servers can be previewed', () => {
    expect(isBlockedHostForPreview('localhost')).toBe(false)
    expect(isBlockedHostForPreview('127.0.0.1')).toBe(false)
    expect(isBlockedHostForPreview('::1')).toBe(false)
    expect(isBlockedHostForPreview('0.0.0.0')).toBe(false)
    expect(isBlockedHostForPreview('::ffff:127.0.0.1')).toBe(false)
  })

  it('still blocks LAN-private / link-local hosts', () => {
    expect(isBlockedHostForPreview('192.168.0.10')).toBe(true)
    expect(isBlockedHostForPreview('10.1.2.3')).toBe(true)
    expect(isBlockedHostForPreview('169.254.169.254')).toBe(true)
    expect(isBlockedHostForPreview('172.16.0.1')).toBe(true)
  })

  it('allows public hosts', () => {
    expect(isBlockedHostForPreview('example.com')).toBe(false)
  })
})

describe('parseDuckDuckGoHtml', () => {
  it('parses title, decoded URL, and snippet', () => {
    const html = `
      <div class="result">
        <a class="result__a" rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc&rut=z">Example Title</a>
        <a class="result__snippet" href="x">A helpful snippet.</a>
      </div>`
    const r = parseDuckDuckGoHtml(html)
    expect(r).toHaveLength(1)
    expect(r[0]).toEqual({ title: 'Example Title', url: 'https://example.com/doc', snippet: 'A helpful snippet.' })
  })

  it('returns an empty array when nothing matches', () => {
    expect(parseDuckDuckGoHtml('<p>no results</p>')).toEqual([])
  })

  it('keeps snippets aligned when an earlier result has none (no index drift)', () => {
    // First result has NO snippet; second does. Index-pairing would wrongly give result #1 the snippet.
    const html = `
      <div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com">First</a></div>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.com">Second</a>
        <a class="result__snippet" href="x">Belongs to Second.</a>
      </div>`
    const r = parseDuckDuckGoHtml(html)
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ title: 'First', snippet: '' })
    expect(r[1]).toMatchObject({ title: 'Second', snippet: 'Belongs to Second.' })
  })
})
