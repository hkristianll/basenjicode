import { describe, it, expect } from 'vitest'
import { recordEscalation, takeEscalation } from './escalation'
import { escalateTool } from './tools/escalate'
import type { ToolContext } from './registry'

describe('escalation store', () => {
  it('records a reason and take() returns then clears it', () => {
    recordEscalation('the check needs a DB that is not provisioned')
    expect(takeEscalation()).toBe('the check needs a DB that is not provisioned')
    expect(takeEscalation()).toBeNull() // cleared after taking
  })

  it('substitutes a default rather than storing an empty reason', () => {
    recordEscalation('   ')
    expect(takeEscalation()).toMatch(/stuck/i)
  })
})

describe('escalate_to_lead tool', () => {
  it('records the worker reason and tells it to STOP', async () => {
    const out = await escalateTool.handler({ reason: 'the requirement is ambiguous about X' }, {} as ToolContext)
    expect(out).toMatch(/STOP/i)
    expect(out).toMatch(/team lead/i)
    expect(takeEscalation()).toBe('the requirement is ambiguous about X')
  })
})
