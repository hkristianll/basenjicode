import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { scoreRun } from './score.mjs'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-fixtures')
const json = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))
const lines = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8').trim().split(/\r?\n/)

describe('scoreRun — 2026-08-14 baseline vs 2026-08-15 rematch excerpts', () => {
  it('scores the breaker-death baseline and its documented 65–70 s high-context gaps', () => {
    expect(scoreRun(json('baseline-turns.json'), lines('baseline-main.log'), json('baseline-checks.json'))).toEqual({
      turns: 6,
      wallClockSec: 135,
      toolErrors: 17,
      breakerFires: 1,
      warnContinues: 0,
      reasoningChars: 6000,
      avgTurnGapAtHighCtx: 67.5,
      completionChecksPassed: false
    })
  })

  it('scores the clean rematch and its documented 7–20 s high-context gaps', () => {
    expect(scoreRun(json('rematch-turns.json'), lines('rematch-main.log'), json('rematch-checks.json'))).toEqual({
      turns: 128,
      wallClockSec: 27,
      toolErrors: 1,
      breakerFires: 0,
      warnContinues: 2,
      reasoningChars: 2500,
      avgTurnGapAtHighCtx: 13.5,
      completionChecksPassed: true
    })
  })
})
