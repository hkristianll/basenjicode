import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { addTicket, addDependency, setStatus, setSpec, fetchTickets } from './loopBoard'

// loopBoard talks to the board over plain fetch from the main process (no Origin). These tests stub
// global.fetch and assert the method/URL/body each write method sends, plus error surfacing.

type Call = { url: string; method: string; body: unknown }

function stubFetch(status: number, payload: unknown): { calls: Call[] } {
  const calls: Call[] = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method || 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload
    } as Response
  })
  vi.stubGlobal('fetch', fn)
  return { calls }
}

beforeEach(() => {
  vi.unstubAllGlobals()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('addTicket', () => {
  it('POSTs to /api/tickets with the ticket and returns the created row', async () => {
    const { calls } = stubFetch(201, { id: 7, project: 'p', title: 'Scaffold', status: 'todo', check: 'npm test' })
    const row = await addTicket({ project: 'p', title: 'Scaffold', body: 'do it', check: 'npm test', deps: [3], priority: 10 })
    expect(row.id).toBe(7)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toMatch(/\/api\/tickets$/)
    expect(calls[0].body).toEqual({ project: 'p', title: 'Scaffold', body: 'do it', check: 'npm test', deps: [3], priority: 10 })
  })
})

describe('addDependency', () => {
  it('POSTs depends_on to the ticket dependency endpoint', async () => {
    const { calls } = stubFetch(200, { id: 5 })
    await addDependency(5, 2)
    expect(calls[0].url).toMatch(/\/api\/tickets\/5\/dependency$/)
    expect(calls[0].body).toEqual({ depends_on: 2 })
  })
})

describe('setStatus', () => {
  it('POSTs status + note + author to the status endpoint', async () => {
    const { calls } = stubFetch(200, { id: 4, status: 'todo' })
    await setStatus(4, 'todo', 'reopened from review')
    expect(calls[0].url).toMatch(/\/api\/tickets\/4\/status$/)
    expect(calls[0].body).toMatchObject({ status: 'todo', note: 'reopened from review' })
  })
})

describe('setSpec', () => {
  it('POSTs the project spec content', async () => {
    const { calls } = stubFetch(200, { project: 'p' })
    await setSpec('p', '# spec', 'My Feature')
    expect(calls[0].url).toMatch(/\/api\/spec$/)
    expect(calls[0].body).toEqual({ project: 'p', content: '# spec', title: 'My Feature' })
  })
})

describe('fetchTickets', () => {
  it('GETs the project (and status) and returns the rows', async () => {
    const { calls } = stubFetch(200, [{ id: 1 }, { id: 2 }])
    const rows = await fetchTickets('p', 'review')
    expect(rows).toHaveLength(2)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toContain('project=p')
    expect(calls[0].url).toContain('status=review')
  })
})

describe('error surfacing', () => {
  it('throws the board error message on a non-2xx write', async () => {
    stubFetch(400, { error: 'title is required' })
    await expect(addTicket({ project: 'p', title: '' })).rejects.toThrow('title is required')
  })
})
