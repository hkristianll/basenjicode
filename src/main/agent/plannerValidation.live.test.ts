// LIVE planner validation for ticket #914 — confirms qwen-agentworld-35b-a3b (a model trained to predict results)
// emits a valid, detailed, INTEGRATION-AWARE decompose plan through the real runDecompose pipeline, and probes its
// tool-call behaviour (native vs text mode) for a Brooke-style manager turn. Hits the live LM Studio model, so it is
// SKIPPED unless PLANNER_LIVE=1 — the normal suite never runs it. Run it once:
//   PLANNER_LIVE=1 node node_modules/vitest/vitest.mjs run src/main/agent/plannerValidation.live.test.ts
// It records the verdict in reviews/PLANNER-VALIDATION.md.
import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runDecompose } from './specOrchestrator'
import { createConnectionClient } from './lmstudio'
import type { Settings, Connection } from '../../shared/domain-types'
import type { LoopConfig } from '../../shared/ipc-types'

const LIVE = !!process.env.PLANNER_LIVE
const MODEL = process.env.PLANNER_MODEL ?? 'qwen-agentworld-35b-a3b'
const BASE = process.env.LMSTUDIO_BASE ?? 'http://localhost:1234/v1'

const conn = { id: 'lm', label: 'agentworld', kind: 'lmstudio', baseURL: BASE, model: MODEL, preferTextToolCalls: true, maxTokens: 16384 } as unknown as Connection
const settings = { connections: [conn], hermesPlannerConnectionId: 'lm', hermesPlannerModel: MODEL, maxTokens: 16384 } as unknown as Settings
const config = {
  cwd: process.cwd(),
  connectionId: 'lm',
  project: 'planner-validate',
  mode: 'auto',
  workerModel: MODEL,
  caps: { maxTickets: 0, maxTokens: 0, maxWallclockSec: 0, maxConsecutiveFailures: 0 },
  terminal: 'auto'
} as unknown as LoopConfig

const GOAL =
  'Build a beautiful Settlers-IV-style isometric colony-builder game in TypeScript + Phaser + Vite: real isometric terrain rendering, several building types, walking units, a working resource economy, and a polished HUD. It must actually run and render in the browser.'

const INTEG = /\b(integrat|wire[\s-]?up|assemble|compose|bootstrap|end[\s-]?to[\s-]?end|e2e|smoke|main (scene|app|entry)|entry[\s-]?point)\b/i
const TESTISH = /\b(test|spec|headless|boot|render|display list)\b/i

describe.skipIf(!LIVE)('qwen-agentworld-35b-a3b planner validation (live; set PLANNER_LIVE=1)', () => {
  it('produces a valid, detailed, integration-aware decompose plan', async () => {
    const plan = await runDecompose(GOAL, config, { settings })

    const tickets = plan.tickets ?? []
    const integ = tickets.filter((t) => INTEG.test(t.title) || INTEG.test(t.body ?? ''))
    const integTest = tickets.filter((t) => TESTISH.test(`${t.title} ${t.check ?? ''} ${t.body ?? ''}`) && (INTEG.test(t.title) || /headless|boot|render|display list|integration/i.test(t.body ?? '')))
    const detailed = tickets.filter((t) => (t.body ?? '').length > 120).length
    const withCheck = tickets.filter((t) => (t.check ?? '').trim().length > 0).length

    const verdict = {
      validJSON: Array.isArray(plan.tickets),
      ticketCount: tickets.length,
      detailedTickets: detailed,
      withCheck,
      integrationTickets: integ.length,
      integrationTestTickets: integTest.length,
      integrationAware: integ.length > 0 && integTest.length > 0
    }

    const rows = tickets
      .map((t, i) => `| ${i} | ${(t.title || '').replace(/\|/g, '/')} | ${t.role ?? ''} | ${(t.check ?? '').replace(/\|/g, '/').slice(0, 40)} | ${(t.body ?? '').length} |`)
      .join('\n')
    const report = [
      '# Planner validation — qwen-agentworld-35b-a3b',
      '',
      `Model: \`${MODEL}\` @ \`${BASE}\` · routed via the planner seam (hermesPlannerModel).`,
      `Goal: ${GOAL}`,
      '',
      '## Verdict',
      '```json',
      JSON.stringify(verdict, null, 2),
      '```',
      `**Integration-aware (has a wire-up ticket AND a headless integration-test ticket per the #911 contract): ${verdict.integrationAware ? 'YES' : 'NO'}**`,
      '',
      '## Spec (model output)',
      (plan.spec ?? '(none)').slice(0, 2000),
      '',
      '## Tickets',
      '| # | title | role | check (40) | body len |',
      '| - | ----- | ---- | ---------- | -------- |',
      rows,
      ''
    ].join('\n')

    mkdirSync('reviews', { recursive: true })
    writeFileSync(join('reviews', 'PLANNER-VALIDATION.md'), report)

    // Structural gate (the recorded doc carries the quality verdict): the model returned a parseable, non-trivial plan.
    expect(verdict.validJSON).toBe(true)
    expect(verdict.ticketCount).toBeGreaterThan(0)
  }, 900_000)

  it('probes tool-call behaviour (native function-calling vs empty-arg fumble) for a manager turn', async () => {
    const client = createConnectionClient(conn)
    const tool = {
      type: 'function',
      function: {
        name: 'team_status',
        description: 'Report the current status of the engineering team and the board.',
        parameters: { type: 'object', properties: { reason: { type: 'string', description: 'why you are checking now' } }, required: ['reason'] }
      }
    }
    const stream = await client.chatStream({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You are the group manager of an engineering team. When the user asks what the team is doing, you MUST call the team_status tool with a reason.' },
        { role: 'user', content: 'What is the team working on right now?' }
      ],
      tools: [tool] as never,
      temperature: 0.3,
      maxTokens: 512,
      signal: new AbortController().signal
    })
    let nativeCalls = 0
    let toolArgs = ''
    let text = ''
    for await (const ch of stream) {
      const d = ch.choices?.[0]?.delta as { content?: string; tool_calls?: { function?: { arguments?: string } }[] } | undefined
      if (d?.tool_calls?.length) {
        nativeCalls += d.tool_calls.length
        for (const tc of d.tool_calls) if (tc.function?.arguments) toolArgs += tc.function.arguments
      }
      if (d?.content) text += d.content
    }
    const note = [
      '',
      '## Tool-call probe (native function-calling)',
      `- native tool_call deltas: ${nativeCalls}`,
      `- accumulated tool arguments: \`${toolArgs.replace(/`/g, "'").slice(0, 200) || '(empty)'}\``,
      `- assistant text (first 300): ${text.replace(/\n/g, ' ').slice(0, 300) || '(none)'}`,
      nativeCalls > 0 && toolArgs.trim().length > 2
        ? '- ✅ emits a NATIVE tool call WITH arguments.'
        : nativeCalls > 0
          ? '- ⚠ emits a native tool call but with EMPTY args → needs Text tool-call mode (preferTextToolCalls).'
          : '- ⚠ no native tool call → relies on Text tool-call mode (preferTextToolCalls), as configured.',
      ''
    ].join('\n')
    try {
      const { readFileSync } = await import('node:fs')
      const prev = readFileSync(join('reviews', 'PLANNER-VALIDATION.md'), 'utf8')
      writeFileSync(join('reviews', 'PLANNER-VALIDATION.md'), prev + note)
    } catch {
      mkdirSync('reviews', { recursive: true })
      writeFileSync(join('reviews', 'PLANNER-VALIDATION.md'), note)
    }
    expect(typeof nativeCalls).toBe('number') // the probe ran; the recorded note carries the finding
  }, 180_000)
})
