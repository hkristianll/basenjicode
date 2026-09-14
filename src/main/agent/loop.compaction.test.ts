import { describe, it, expect } from 'vitest'
import { shouldCompactNow } from './loop'

// Numbers from the real report: LM Studio served qwen3.8-27b at a 134107 loaded context, chat frac 0.55,
// and the session sat at ~51k real prompt tokens when it announced a compaction it should not have run.
const CAP = 134_107
const FRAC = 0.55

describe('shouldCompactNow', () => {
  it('holds below the fraction and fires above it, on real usage', () => {
    expect(shouldCompactNow({ promptTokens: 51_000, estimatedTokens: 0, contextLimitTokens: CAP, frac: FRAC })).toBe(false)
    expect(shouldCompactNow({ promptTokens: 80_000, estimatedTokens: 0, contextLimitTokens: CAP, frac: FRAC })).toBe(true)
  })

  it('uses the SAME ceiling for the estimate path as for real usage', () => {
    // The regression: a restored session has no usage yet, so the estimate decides. At ~55k estimated the
    // old reserve-subtracting formula triggered (threshold 54.6k) while real usage would not (73.8k).
    const atEstimate = (estimatedTokens: number): boolean =>
      shouldCompactNow({ promptTokens: 0, estimatedTokens, contextLimitTokens: CAP, frac: FRAC })
    const atUsage = (promptTokens: number): boolean =>
      shouldCompactNow({ promptTokens, estimatedTokens: 0, contextLimitTokens: CAP, frac: FRAC })

    expect(atEstimate(55_000)).toBe(false)
    for (const n of [51_000, 55_000, 70_000, 73_000, 80_000, 120_000]) expect(atEstimate(n)).toBe(atUsage(n))
  })

  it('does not compact sooner just because the output budget grew', () => {
    // maxTokens is deliberately absent from the signature — a larger reply allowance is not a reason to
    // summarize earlier. This pins that: the decision depends only on usage, cap and fraction.
    const args = { promptTokens: 0, estimatedTokens: 60_000, contextLimitTokens: CAP, frac: FRAC }
    expect(shouldCompactNow(args)).toBe(false)
    expect(60_000 > (CAP - 32_768 - 2_000) * FRAC).toBe(true) // the OLD formula would have compacted here
  })

  it('prefers real usage over the estimate whenever usage is known', () => {
    // A wildly wrong estimate must not force a compaction once the model has reported its real size.
    expect(shouldCompactNow({ promptTokens: 10_000, estimatedTokens: 999_999, contextLimitTokens: CAP, frac: FRAC })).toBe(false)
  })

  it('never compacts when the cap is unknown/zero', () => {
    expect(shouldCompactNow({ promptTokens: 99_999, estimatedTokens: 99_999, contextLimitTokens: 0, frac: FRAC })).toBe(false)
  })
})
