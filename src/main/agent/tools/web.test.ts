import { describe, it, expect } from 'vitest'
import { fetchWithTimeout, FetchBlocked, type FetchDeps } from './web'

// The SSRF enforcement in fetchWithTimeout — DNS-rebinding defense (assertPublicResolved), the manual
// redirect loop that re-validates every hop's host, the non-http(s) redirect refusal, and the redirect cap —
// was correct but completely untested (only the pure isBlockedHost classifier it leans on had coverage). A
// refactor that flipped redirect:'manual' back to 'follow', dropped an assertPublicResolved call, or mis-ordered
// the location check would silently reopen an SSRF hole into the LAN / cloud metadata with the suite still green.
// These lock the behavior via the injected fetch + dns seam — no real network, no real DNS.

const PUBLIC: { address: string }[] = [{ address: '93.184.216.34' }] // a public A record
const freshSignal = (): AbortSignal => new AbortController().signal

/** Default deps: a public DNS answer and a plain 200 OK. Override per test. */
function deps(over: Partial<FetchDeps> = {}): FetchDeps {
  return {
    fetchImpl: async () => new Response('ok', { status: 200 }),
    lookup: async () => PUBLIC,
    ...over
  }
}

const redirectTo = (location: string): Response => new Response(null, { status: 302, headers: { location } })

describe('fetchWithTimeout SSRF enforcement', () => {
  it('returns the response for a public host with no redirect', async () => {
    const res = await fetchWithTimeout('http://example.com/', freshSignal(), deps())
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it('refuses a public→loopback redirect (per-hop host re-check)', async () => {
    const d = deps({ fetchImpl: async () => redirectTo('http://127.0.0.1/admin') })
    await expect(fetchWithTimeout('http://example.com/', freshSignal(), d)).rejects.toThrow(FetchBlocked)
  })

  it('refuses a public→LAN redirect', async () => {
    const d = deps({ fetchImpl: async () => redirectTo('http://192.168.1.10/') })
    await expect(fetchWithTimeout('http://example.com/', freshSignal(), d)).rejects.toThrow(/private\/loopback host/)
  })

  it('refuses a public name that DNS-resolves to cloud metadata (169.254.169.254)', async () => {
    // DNS-rebinding: the host STRING looks public, but its A record points at link-local metadata.
    const d = deps({ lookup: async () => [{ address: '169.254.169.254' }] })
    await expect(fetchWithTimeout('http://rebind.example/', freshSignal(), d)).rejects.toThrow(/private\/loopback address/)
  })

  it('refuses a redirect to a non-http(s) scheme', async () => {
    const d = deps({ fetchImpl: async () => redirectTo('file:///etc/passwd') })
    await expect(fetchWithTimeout('http://example.com/', freshSignal(), d)).rejects.toThrow(/non-http/)
  })

  it('aborts after exceeding the redirect cap (>5 hops)', async () => {
    let n = 0
    const d = deps({ fetchImpl: async () => redirectTo(`http://example.com/r${n++}`) })
    await expect(fetchWithTimeout('http://example.com/', freshSignal(), d)).rejects.toThrow(/too many redirects/)
  })

  it('propagates an already-aborted signal to the underlying fetch', async () => {
    const ac = new AbortController()
    ac.abort()
    const d = deps({
      fetchImpl: async (_url, init) => {
        if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
        return new Response('ok', { status: 200 })
      }
    })
    await expect(fetchWithTimeout('http://example.com/', ac.signal, d)).rejects.toThrow(/abort/i)
  })
})
