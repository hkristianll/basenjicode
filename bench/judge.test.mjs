import { describe, expect, it } from 'vitest'
import { judgeRun, parseJudgeReply, buildJudgePrompt, JUDGE_RUBRIC } from './judge.mjs'

const GOOD_REPLY = `Here is my assessment:
\`\`\`json
{"scores":{"completeness":4,"truthfulness":5,"verification":4,"taskTracking":2,"craft":4},
 "evidence":{"completeness":"game boots","truthfulness":"report matches files","verification":"16 screenshots","taskTracking":"one bulk update","craft":"modular"},
 "verdict":4}
\`\`\``

const ARTIFACTS = {
  taskPrompt: 'make a gta clone that works in the browser',
  checkResults: [{ type: 'fileExists', arg: 'index.html', pass: true }],
  finalMessage: 'Done — playable at localhost.',
  fileListing: [{ name: 'index.html', bytes: 530 }],
  keyFiles: [{ name: 'game.js', content: 'const x = 1' }]
}

describe('bench judge', () => {
  it('parses a fenced judge reply into scores + verdict', async () => {
    const result = await judgeRun(ARTIFACTS, async () => GOOD_REPLY)
    expect(result.verdict).toBe(4)
    expect(result.scores.taskTracking).toBe(2)
    expect(result.evidence.verification).toContain('screenshots')
  })

  it('a malformed reply records verdict null and preserves the raw text', async () => {
    const result = await judgeRun(ARTIFACTS, async () => 'I think it is pretty good overall!')
    expect(result.verdict).toBeNull()
    expect(result.raw).toContain('pretty good')
  })

  it('parseJudgeReply rejects JSON without a numeric verdict', () => {
    expect(parseJudgeReply('{"scores":{}}')).toBeNull()
  })

  it('the prompt carries the rubric, task, checks, and truncated sources', () => {
    const prompt = buildJudgePrompt(ARTIFACTS)
    expect(prompt).toContain(JUDGE_RUBRIC)
    expect(prompt).toContain('gta clone')
    expect(prompt).toContain('fileExists')
    expect(prompt).toContain('game.js')
  })
})
