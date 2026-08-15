import { describe, it, expect } from 'vitest'
import { buildAgentConfig, resolveTicketWorker } from './boardInner'
import type { Settings, Connection } from '../../shared/domain-types'
import type { LoopConfig } from '../../shared/ipc-types'
import type { BoardTicket } from './boardRunner'

// Minimal Settings/Connection shapes — buildAgentConfig only reads the fields below (mirrors the
// `as unknown as Settings` pattern the other board tests use).
const settings = { temperature: 0.2, maxTokens: 4096, maxTurns: 50, contextLimitTokens: 32_768, image: false } as unknown as Settings
const conn = (over: Partial<Connection> = {}): Connection =>
  ({ id: 'w', label: 'worker', kind: 'lmstudio', model: 'qwen', ...over }) as unknown as Connection

describe('buildAgentConfig — Hermes worker defaults', () => {
  it('R1: defaults preferTextToolCalls ON and reasoningEffort off when the connection leaves them unset', () => {
    const c = buildAgentConfig(settings, conn())
    expect(c.preferTextToolCalls).toBe(true)
    expect(c.reasoningEffort).toBe('off')
  })

  it('R1: an explicit per-connection value still wins over the Hermes default', () => {
    const c = buildAgentConfig(settings, conn({ preferTextToolCalls: false, reasoningEffort: 'high' }))
    expect(c.preferTextToolCalls).toBe(false)
    expect(c.reasoningEffort).toBe('high')
  })

  it('R8: caps maxTurns at the per-ticket budget (28 default), below the settings allowance', () => {
    expect(buildAgentConfig(settings, conn()).maxTurns).toBe(28)
  })

  it('R8: settings.loopMaxTurnsPerTicket overrides the default budget (still clamped to settings.maxTurns)', () => {
    const bigger = { ...settings, loopMaxTurnsPerTicket: 40 } as unknown as Settings
    expect(buildAgentConfig(bigger, conn()).maxTurns).toBe(40)
    // Never exceeds the global settings.maxTurns allowance.
    const capped = { ...settings, maxTurns: 20, loopMaxTurnsPerTicket: 40 } as unknown as Settings
    expect(buildAgentConfig(capped, conn()).maxTurns).toBe(20)
  })

  it('R1: clamps contextLimitTokens to the genius zone (80k); no-op when already under', () => {
    expect(buildAgentConfig(settings, conn()).contextLimitTokens).toBe(32_768) // settings value is under the cap → unchanged
    expect(buildAgentConfig(settings, conn({ contextLimitTokens: 200_000 })).contextLimitTokens).toBe(80_000) // a high window is clamped down
  })

  it('caps maxTokens so a single completion can never run unbounded (loop protection)', () => {
    expect(buildAgentConfig(settings, conn()).maxTokens).toBe(4096) // settings 4096 is under the cap → unchanged
    expect(buildAgentConfig(settings, conn({ maxTokens: 99_000 })).maxTokens).toBe(16_384) // a high value clamps to the cap
    const noMax = { ...settings, maxTokens: null } as unknown as Settings
    expect(buildAgentConfig(noMax, conn({ maxTokens: null })).maxTokens).toBe(16_384) // null (unbounded) → the cap, NEVER null
  })
})

describe('resolveTicketWorker — role → model routing (coder vs designer)', () => {
  const cfg = { connectionId: 'w', workerModel: 'coder-35b' } as unknown as LoopConfig
  const conns = [
    { id: 'w', label: 'worker', kind: 'lmstudio', model: 'coder-35b' },
    { id: 'd', label: 'designer', kind: 'lmstudio', model: 'designer-27b' }
  ] as unknown as Connection[]
  const tkt = (role: string): BoardTicket => ({ id: 1, title: 'T', body: `**Department: ${role}** — guidance\n\nbody`, status: 'in_progress', project: 'p' }) as BoardTicket

  it('routes a DESIGN ticket to the configured designer model', () => {
    const s = { connections: conns, hermesDesignerConnectionId: 'd', hermesDesignerModel: 'designer-27b' } as unknown as Settings
    const { conn, model } = resolveTicketWorker(tkt('design'), cfg, s)
    expect(conn?.id).toBe('d')
    expect(model).toBe('designer-27b')
  })

  it('routes an IMPLEMENTATION ticket to the worker/coder even when a designer is set', () => {
    const s = { connections: conns, hermesDesignerConnectionId: 'd', hermesDesignerModel: 'designer-27b' } as unknown as Settings
    const { conn, model } = resolveTicketWorker(tkt('implementation'), cfg, s)
    expect(conn?.id).toBe('w')
    expect(model).toBe('coder-35b')
  })

  it('falls back to the worker for a design ticket when NO designer is configured', () => {
    const s = { connections: conns } as unknown as Settings
    const { conn, model } = resolveTicketWorker(tkt('design'), cfg, s)
    expect(conn?.id).toBe('w')
    expect(model).toBe('coder-35b')
  })
})
