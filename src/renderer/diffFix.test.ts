import { describe, expect, it } from 'vitest'
import { buildFixOnlyThisPrompt } from './diffFix'

describe('buildFixOnlyThisPrompt', () => {
  it('identifies the file and gives the selected lines strict scope', () => {
    const prompt = buildFixOnlyThisPrompt('src/app.ts', '- return false\n+ return true')

    expect(prompt).toContain('Fix only the selected diff in src/app.ts.')
    expect(prompt).toContain('Do not revert, rewrite, format, or otherwise change unrelated work.')
    expect(prompt).toContain('- return false\n+ return true')
  })

  it('bounds selected diff context', () => {
    const prompt = buildFixOnlyThisPrompt('large.ts', `+${'x'.repeat(20_000)}`)
    expect(prompt.length).toBeLessThan(13_000)
    expect(prompt).toContain('--- End selected diff ---')
  })
})
