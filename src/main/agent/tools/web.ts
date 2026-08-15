import dns from 'node:dns/promises'
import { z } from 'zod'
import type { ToolDef } from '../registry'
import { htmlToText, isBlockedHost, parseDuckDuckGoHtml } from '../../web-util'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const FETCH_TIMEOUT_MS = 20_000
const MAX_TEXT = 15_000
const MAX_REDIRECTS = 5
// Hard byte ceiling on a fetched body. fetchWithTimeout bounds elapsed time but not size; without this a
// hostile URL (the exact threat the SSRF guard already assumes) can OOM the MAIN process and crash the whole
// app. Node's fetch transparently decompresses gzip/br, so a small gzip-bombed body expands unbounded — the
// streaming reader below counts DECOMPRESSED bytes, so it trips on the expansion, not just the wire size.
const MAX_FETCH_BYTES = 5 * 1024 * 1024 // 5 MB — generous for docs/JSON, far below an OOM.

export class FetchBlocked extends Error {}

/** Seam (mirrors boardRunner's git/makeClient injection) so the SSRF enforcement below — DNS-rebinding
 *  defense, per-hop redirect re-validation, redirect cap — is testable without real network or DNS. */
export interface FetchDeps {
  fetchImpl: typeof fetch
  lookup: (hostname: string) => Promise<{ address: string }[]>
}
const liveFetchDeps: FetchDeps = {
  fetchImpl: (...a) => fetch(...a),
  lookup: (hostname) => dns.lookup(hostname, { all: true })
}

/**
 * Read a response body into a Buffer with a hard byte budget. Rejects early on an over-large advertised
 * Content-Length, then streams chunk-by-chunk and aborts the moment the running total exceeds the cap (so a
 * lying/absent Content-Length, or a decompression bomb whose wire size is tiny, can't grow the buffer past the
 * budget). Unlike `res.arrayBuffer()`, nothing larger than the cap is ever materialized.
 */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new FetchBlocked(`response too large: Content-Length ${declared} exceeds the ${maxBytes}-byte cap.`)
  }
  const reader = res.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new FetchBlocked(`response exceeded the ${maxBytes}-byte cap (stopped mid-stream).`)
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
  }
  return Buffer.concat(chunks)
}

/**
 * DNS-rebinding defense: isBlockedHost only inspects the host STRING. Resolve it and refuse if any A/AAAA
 * record points at a loopback/private/link-local address — so a public-looking name whose record is
 * 127.0.0.1 / 169.254.169.254 / a LAN IP can't slip a fetch (or any redirect hop) past the name check.
 */
async function assertPublicResolved(hostname: string, deps: FetchDeps): Promise<void> {
  let addrs: { address: string }[]
  try {
    addrs = await deps.lookup(hostname)
  } catch {
    return // let fetch surface the resolution error itself
  }
  for (const a of addrs) {
    if (isBlockedHost(a.address)) {
      throw new FetchBlocked(`refusing to fetch ${hostname}: it resolves to a private/loopback address (${a.address}).`)
    }
  }
}

/**
 * fetch() that aborts on the tool's cancel signal or after a timeout, and follows redirects MANUALLY
 * so every hop's host is re-checked against isBlockedHost. With redirect:'follow' a public URL could
 * 302 into 127.0.0.1 / 169.254.169.254 / the LAN (SSRF) — only the initial host was ever validated.
 */
export async function fetchWithTimeout(url: string, signal: AbortSignal, deps: FetchDeps = liveFetchDeps): Promise<Response> {
  const ctl = new AbortController()
  const onAbort = (): void => ctl.abort()
  if (signal.aborted) ctl.abort()
  else signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    let current = url
    for (let hop = 0; ; hop++) {
      await assertPublicResolved(new URL(current).hostname, deps)
      const res = await deps.fetchImpl(current, {
        signal: ctl.signal,
        redirect: 'manual',
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
          // Ask for an undecoded body so a gzip/br decompression bomb can't expand past the byte cap; the
          // streaming reader is the real backstop (a server may ignore this), but identity defangs the common case.
          'accept-encoding': 'identity'
        }
      })
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
      if (!loc) return res
      if (hop >= MAX_REDIRECTS) throw new FetchBlocked(`too many redirects (>${MAX_REDIRECTS}).`)
      let next: URL
      try {
        next = new URL(loc, current)
      } catch {
        throw new FetchBlocked(`invalid redirect target: ${loc}`)
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new FetchBlocked(`refusing to follow a redirect to a non-http(s) URL (${next.protocol}).`)
      }
      if (isBlockedHost(next.hostname)) {
        throw new FetchBlocked(`refusing to follow a redirect to a private/loopback host (${next.hostname}).`)
      }
      current = next.href
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

function cap(text: string): string {
  if (text.length <= MAX_TEXT) return text
  return `${text.slice(0, MAX_TEXT)}\n... [truncated at ${MAX_TEXT} characters]`
}

const fetchSchema = z.object({
  url: z.string().min(1).describe('Absolute http(s) URL to fetch.')
})

const webFetchTool: ToolDef<typeof fetchSchema> = {
  name: 'web_fetch',
  description:
    'Fetch a web page or text/JSON resource over HTTP(S) and return its text content (HTML is stripped to plain ' +
    'text). For reading docs/references. Private/loopback addresses are refused.',
  schema: fetchSchema,
  mutating: false,
  async handler(args, ctx) {
    let u: URL
    try {
      u = new URL(args.url)
    } catch {
      return `ERROR: invalid URL: ${args.url}`
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'ERROR: only http(s) URLs are supported.'
    if (isBlockedHost(u.hostname)) return `ERROR: refusing to fetch a private/loopback host (${u.hostname}).`

    let res: Response
    try {
      res = await fetchWithTimeout(u.href, ctx.signal)
    } catch (e) {
      if (ctx.signal.aborted) return 'CANCELLED: fetch aborted.'
      if (e instanceof FetchBlocked) return `ERROR: ${e.message}`
      return `ERROR: fetch failed — ${e instanceof Error ? e.message : String(e)}`
    }

    const ctype = res.headers.get('content-type') ?? ''
    let body: Buffer
    try {
      body = await readCapped(res, MAX_FETCH_BYTES)
    } catch (e) {
      if (e instanceof FetchBlocked) return `ERROR: ${e.message}`
      if (ctx.signal.aborted) return 'CANCELLED: fetch aborted.'
      return `ERROR: failed to read response body — ${e instanceof Error ? e.message : String(e)}`
    }
    const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`
    let text: string
    if (/text\/html|application\/xhtml/i.test(ctype) || (!ctype && /<html|<!doctype/i.test(body.subarray(0, 200).toString('utf8')))) {
      text = htmlToText(body.toString('utf8'))
    } else if (/^text\/|application\/(json|xml|javascript|[\w.+-]*\+json|[\w.+-]*\+xml)/i.test(ctype)) {
      text = body.toString('utf8')
    } else {
      return `Fetched ${u.href} — ${status}, ${ctype || 'unknown type'}, ${body.length} bytes (not text; nothing to show).`
    }
    return `${u.href} — ${status}\n\n${cap(text.trim())}`
  }
}

const searchSchema = z.object({
  query: z.string().min(1).describe('Search query.'),
  count: z.number().int().min(1).max(15).optional().describe('Max results to return (default 8).')
})

const webSearchTool: ToolDef<typeof searchSchema> = {
  name: 'web_search',
  description:
    'Search the web (via DuckDuckGo) and return the top results as title + URL + snippet. Best-effort; follow up ' +
    'with web_fetch to read a result in full.',
  schema: searchSchema,
  mutating: false,
  async handler(args, ctx) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query.trim())}`
    let res: Response
    try {
      res = await fetchWithTimeout(url, ctx.signal)
    } catch (e) {
      if (ctx.signal.aborted) return 'CANCELLED: search aborted.'
      if (e instanceof FetchBlocked) return `ERROR: ${e.message}`
      return `ERROR: search request failed — ${e instanceof Error ? e.message : String(e)}`
    }
    if (!res.ok) return `ERROR: search returned HTTP ${res.status}. DuckDuckGo may be rate-limiting; try again shortly.`
    let html: string
    try {
      html = (await readCapped(res, MAX_FETCH_BYTES)).toString('utf8')
    } catch (e) {
      if (e instanceof FetchBlocked) return `ERROR: ${e.message}`
      return `ERROR: failed to read search response — ${e instanceof Error ? e.message : String(e)}`
    }
    const results = parseDuckDuckGoHtml(html, args.count ?? 8)
    if (!results.length) {
      return `No results parsed for "${args.query}". The search page may be rate-limited or its format changed; you can web_fetch a specific URL instead.`
    }
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n\n')
  }
}

export const webTools: ToolDef[] = [webFetchTool as ToolDef, webSearchTool as ToolDef]
