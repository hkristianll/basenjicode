import { describe, it, expect } from 'vitest'
import { createSingleFlight } from './singleFlight'

describe('createSingleFlight', () => {
  it('starts idle and grants the first claim', () => {
    const sf = createSingleFlight()
    expect(sf.activeProject()).toBeNull()
    const r = sf.tryStart('alpha')
    expect(r.ok).toBe(true)
    expect(sf.activeProject()).toBe('alpha')
  })

  it('refuses a second start while one is active, naming the busy project', () => {
    const sf = createSingleFlight()
    sf.tryStart('alpha')
    const r = sf.tryStart('beta')
    expect(r).toEqual({ ok: false, busyProject: 'alpha' })
    expect(sf.activeProject()).toBe('alpha') // unchanged — the first run was NOT aborted
  })

  it('finish() frees the slot so the next run can start', () => {
    const sf = createSingleFlight()
    const a = sf.tryStart('alpha')
    if (!a.ok) throw new Error('unreachable')
    sf.finish(a.token)
    expect(sf.activeProject()).toBeNull()
    expect(sf.tryStart('beta').ok).toBe(true)
  })

  it('clear() force-frees the slot (explicit stop)', () => {
    const sf = createSingleFlight()
    sf.tryStart('alpha')
    sf.clear()
    expect(sf.activeProject()).toBeNull()
    expect(sf.tryStart('beta').ok).toBe(true)
  })

  it('an old run finishing AFTER a stop→start swap does NOT wipe the new run (token guard)', () => {
    const sf = createSingleFlight()
    const a = sf.tryStart('alpha')
    if (!a.ok) throw new Error('unreachable')
    sf.clear() // user stops alpha
    const b = sf.tryStart('beta') // and immediately starts beta
    if (!b.ok) throw new Error('unreachable')
    sf.finish(a.token) // alpha's late .finally fires — must NOT clear beta
    expect(sf.activeProject()).toBe('beta')
    // beta's own finish still works
    sf.finish(b.token)
    expect(sf.activeProject()).toBeNull()
  })
})
