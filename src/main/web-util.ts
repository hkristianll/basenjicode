/** Pure helpers for the web tools — electron-free so they can be unit-tested. */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#x27': "'",
  '#x2F': '/',
  '#47': '/'
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body: string) => {
    const key = body.toLowerCase()
    if (key in ENTITIES) return ENTITIES[key]
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code)
        } catch {
          return m
        }
      }
    }
    return m
  })
}

/** Strip HTML to readable plain text, preserving rough block/line structure. */
export function htmlToText(html: string): string {
  let s = html
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<li[^>]*>/gi, '\n- ')
  s = s.replace(/<\/(p|div|section|article|h[1-6]|li|tr|ul|ol|header|footer|nav|table)>/gi, '\n')
  // Opening block tags also start a new line (e.g. text<p>block</p>).
  s = s.replace(/<(p|div|section|article|h[1-6]|tr|ul|ol|header|footer|nav|table)[^>]*>/gi, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  s = s.replace(/[ \t\f\v]+/g, ' ')
  s = s.replace(/[ \t]*\n[ \t]*/g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

/**
 * Extract a dotted-quad from a host that is a literal IPv4 OR an IPv4-mapped IPv6 address
 * (::ffff:127.0.0.1 dotted, or ::ffff:7f00:1 hex). Returns null for names and pure IPv6.
 * The mapped forms are the SSRF bypass that a plain IPv4 regex misses.
 */
function asIPv4(h: string): [number, number, number, number] | null {
  const dotted = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(h)
  if (dotted) return [Number(dotted[1]), Number(dotted[2]), Number(dotted[3]), Number(dotted[4])]
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h)
  if (hex) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]
  }
  return null
}

export type HostClass = 'loopback' | 'private' | 'public'

/** Classify a hostname for SSRF decisions. loopback = this-machine; private = LAN/link-local/reserved. */
export function classifyHost(hostname: string): HostClass {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return 'private' // empty/unparseable → safest is to treat as internal
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback'
  if (h === '::' || h === '::1') return 'loopback'
  const ip = asIPv4(h)
  if (ip) {
    const [a, b] = ip
    if (a === 127 || a === 0) return 'loopback' // 127/8 loopback, 0/8 "this host"
    if (a === 10) return 'private'
    if (a === 192 && b === 168) return 'private'
    if (a === 169 && b === 254) return 'private' // link-local incl. cloud metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return 'private'
    if (a >= 224) return 'private' // multicast / reserved
    return 'public'
  }
  if (/^fe80:/i.test(h)) return 'private' // IPv6 link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return 'private' // IPv6 unique-local
  return 'public'
}

/** Block loopback / private / link-local hosts so web_fetch can't be used for SSRF into the LAN or this box. */
export function isBlockedHost(hostname: string): boolean {
  const c = classifyHost(hostname)
  return c === 'loopback' || c === 'private'
}

/**
 * Like isBlockedHost but ALLOWS the loopback subset — the Preview panel's whole purpose is to load a
 * local dev server (localhost / 127.0.0.1 / [::1] / 0.0.0.0). LAN-private and link-local stay blocked.
 */
export function isBlockedHostForPreview(hostname: string): boolean {
  return classifyHost(hostname) === 'private'
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

function decodeDuckUrl(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href)
  if (m) {
    try {
      return decodeURIComponent(m[1])
    } catch {
      return href
    }
  }
  return href.startsWith('//') ? `https:${href}` : href
}

/** Parse the DuckDuckGo HTML-endpoint results page into structured results (best-effort). */
export function parseDuckDuckGoHtml(html: string, max = 8): SearchResult[] {
  // Capture snippets WITH their positions. Pairing a link to a snippet by global index silently
  // misaligns the moment one result lacks a snippet (an ad row, a "no description" hit) — every later
  // result then shows the wrong description. Instead, pair each link with the snippet that physically
  // follows it (and precedes the next link).
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  const snippets: { index: number; text: string }[] = []
  let sm: RegExpExecArray | null
  while ((sm = snippetRe.exec(html))) snippets.push({ index: sm.index, text: htmlToText(sm[1]) })

  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const links: { index: number; href: string; title: string }[] = []
  let lm: RegExpExecArray | null
  while ((lm = linkRe.exec(html))) {
    const title = htmlToText(lm[2])
    if (title) links.push({ index: lm.index, href: lm[1], title })
  }

  const results: SearchResult[] = []
  for (let i = 0; i < links.length && results.length < max; i++) {
    const start = links[i].index
    const end = i + 1 < links.length ? links[i + 1].index : html.length
    const snip = snippets.find((s) => s.index > start && s.index < end)
    results.push({ title: links[i].title, url: decodeDuckUrl(links[i].href), snippet: snip?.text ?? '' })
  }
  return results
}
