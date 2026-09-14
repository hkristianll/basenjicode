import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { ReadTracker, ToolRegistry, type ToolDef } from './registry'

function tool(name: string): ToolDef {
  return { name, description: name, schema: z.object({}), mutating: false, handler: async () => 'ok' }
}

describe('ToolRegistry.without', () => {
  it('returns a new registry with the named tools removed and the rest intact', () => {
    const r = new ToolRegistry()
    r.register(tool('read_file'))
    r.register(tool('kanban'))
    r.register(tool('claim_next'))
    r.register(tool('write_file'))

    const worker = r.without(['kanban', 'claim_next'])

    // The board-driving tools are gone for the worker...
    expect(worker.get('kanban')).toBeUndefined()
    expect(worker.get('claim_next')).toBeUndefined()
    // ...but the real work tools remain.
    expect(worker.get('read_file')).toBeDefined()
    expect(worker.get('write_file')).toBeDefined()
    expect(worker.list().map((t) => t.name).sort()).toEqual(['read_file', 'write_file'])
  })

  it('does not mutate the original registry', () => {
    const r = new ToolRegistry()
    r.register(tool('kanban'))
    r.without(['kanban'])
    expect(r.get('kanban')).toBeDefined() // original untouched
  })

  it('ignores names that are not present', () => {
    const r = new ToolRegistry()
    r.register(tool('read_file'))
    expect(r.without(['nope']).list()).toHaveLength(1)
  })
})

describe('ReadTracker telemetry', () => {
  it('distinguishes actual read_file calls from post-write mtime refreshes', () => {
    const reads = new ReadTracker()
    reads.record('/workspace/edited.ts', 1)
    reads.recordFileRead('/workspace/read.ts', 2)
    reads.recordFileRead('/workspace/read.ts', 3, false)

    expect(reads.readPaths()).toEqual(['/workspace/read.ts'])
  })
})
