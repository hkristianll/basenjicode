import { describe, expect, it } from 'vitest'
import { probeLmStudio } from './run.mjs'

describe('bench runner connection handling', () => {
  it('returns a clear non-crashing message for an unreachable LM Studio URL', async () => {
    const result = await probeLmStudio({ baseURL: 'http://127.0.0.1:1/v1', apiKey: '' }, 250)

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/^LM Studio unreachable at http:\/\/127\.0\.0\.1:1\/v1:/)
  })
})
