import { describe, it, expect } from 'vitest'
import { SafetyController } from './safety'
import type { ToolDef } from './registry'

function tool(name: string, mutating: boolean, category?: 'read' | 'edit' | 'shell'): ToolDef {
  return {
    name,
    description: '',
    schema: {} as ToolDef['schema'],
    mutating,
    category,
    handler: async () => ''
  } as unknown as ToolDef
}

const readTool = tool('read_file', false, 'read')
const editTool = tool('edit_file', true, 'edit')
const shellTool = tool('run_shell', true, 'shell')

describe('SafetyController.authorize', () => {
  it('auto-allows non-mutating tools', async () => {
    const s = new SafetyController(async () => ({ decision: 'reject' }), 'ask')
    expect((await s.authorize(readTool, {}, 'c1')).allowed).toBe(true)
  })

  it('denies all mutations in plan mode', async () => {
    const s = new SafetyController(async () => ({ decision: 'approve' }), 'plan')
    expect((await s.authorize(editTool, {}, 'c1')).allowed).toBe(false)
    expect((await s.authorize(shellTool, { command: 'ls' }, 'c2')).allowed).toBe(false)
  })

  it('runs everything including shell without prompting in auto mode', async () => {
    let prompted = 0
    const s = new SafetyController(async () => {
      prompted++
      return { decision: 'reject' }
    }, 'auto')
    expect((await s.authorize(editTool, {}, 'c1')).allowed).toBe(true)
    expect((await s.authorize(shellTool, { command: 'rm x' }, 'c2')).allowed).toBe(true)
    expect(prompted).toBe(0)
  })

  it('accept-edits auto-applies edits but still prompts for shell', async () => {
    let prompted = 0
    const s = new SafetyController(async () => {
      prompted++
      return { decision: 'reject' }
    }, 'acceptEdits')
    expect((await s.authorize(editTool, {}, 'c1')).allowed).toBe(true)
    expect(prompted).toBe(0)
    const shellRes = await s.authorize(shellTool, { command: 'rm x' }, 'c2')
    expect(prompted).toBe(1)
    expect(shellRes.allowed).toBe(false)
  })

  it('feeds the reject note back into the reason', async () => {
    const s = new SafetyController(async () => ({ decision: 'reject', note: 'use the test dir' }), 'ask')
    const res = await s.authorize(editTool, {}, 'c1')
    expect(res.allowed).toBe(false)
    expect(res.reason).toContain('use the test dir')
  })

  it('remembers always_tool for the session', async () => {
    let prompted = 0
    const s = new SafetyController(async () => {
      prompted++
      return { decision: 'always_tool' }
    }, 'ask')
    expect((await s.authorize(editTool, { a: 1 }, 'c1')).allowed).toBe(true)
    expect((await s.authorize(editTool, { a: 2 }, 'c2')).allowed).toBe(true)
    expect(prompted).toBe(1)
  })

  it('shell always_exact permits only the exact command', async () => {
    let prompted = 0
    const s = new SafetyController(async () => {
      prompted++
      return { decision: 'always_exact' }
    }, 'ask')
    expect((await s.authorize(shellTool, { command: 'npm run dev' }, 'c1')).allowed).toBe(true)
    expect((await s.authorize(shellTool, { command: 'npm run dev' }, 'c2')).allowed).toBe(true)
    const chained = await s.authorize(shellTool, { command: 'npm run dev; Remove-Item -Recurse -Force .\\src' }, 'c3')
    expect(chained.allowed).toBe(true) // approved by the prompt callback, not the prior decision
    expect(prompted).toBe(2)
  })

  it('clear() forgets the allow-list', async () => {
    let prompted = 0
    const s = new SafetyController(async () => {
      prompted++
      return { decision: 'always_tool' }
    }, 'ask')
    await s.authorize(editTool, {}, 'c1')
    s.clear()
    await s.authorize(editTool, {}, 'c2')
    expect(prompted).toBe(2)
  })
})

describe('SafetyController — W3a shell screening in auto mode', () => {
  const ROOT = String.raw`C:\ws\proj`
  const dangerous = { command: String.raw`Remove-Item -Recurse C:\Users\hansk\Documents` }
  const safe = { command: 'npx vitest run' }

  it('headless (board worker): a dangerous command is DENIED with guidance, safe ones run silently', async () => {
    let prompted = 0
    const s = new SafetyController(
      async () => {
        prompted++
        return { decision: 'approve' }
      },
      'auto',
      undefined,
      { screenShell: true, headless: true, workspaceRoot: ROOT }
    )
    const denied = await s.authorize(shellTool, dangerous, 'c1')
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toMatch(/outside-workspace/)
    expect(denied.reason).toMatch(/INSIDE the workspace/)
    expect((await s.authorize(shellTool, safe, 'c2')).allowed).toBe(true)
    expect(prompted).toBe(0) // headless never prompts
  })

  it('chat: a dangerous command drops to an approval prompt — approve runs it, reject blocks it', async () => {
    const decisions: Array<'approve' | 'reject'> = ['approve', 'reject']
    let prompted = 0
    const s = new SafetyController(
      async () => {
        prompted++
        return { decision: decisions.shift() ?? 'reject' }
      },
      'auto',
      undefined,
      { screenShell: true, headless: false, workspaceRoot: ROOT }
    )
    expect((await s.authorize(shellTool, dangerous, 'c1')).allowed).toBe(true) // human approved
    expect((await s.authorize(shellTool, dangerous, 'c2')).allowed).toBe(false) // human rejected
    expect(prompted).toBe(2)
    expect((await s.authorize(shellTool, safe, 'c3')).allowed).toBe(true) // safe: no prompt
    expect(prompted).toBe(2)
  })

  it('screening off restores verbatim full-auto', async () => {
    let prompted = 0
    const s = new SafetyController(
      async () => {
        prompted++
        return { decision: 'reject' }
      },
      'auto',
      undefined,
      { screenShell: false, headless: true, workspaceRoot: ROOT }
    )
    expect((await s.authorize(shellTool, dangerous, 'c1')).allowed).toBe(true)
    expect(prompted).toBe(0)
  })

  it('screening only applies to shell tools — edits in auto stay untouched', async () => {
    const s = new SafetyController(async () => ({ decision: 'reject' }), 'auto', undefined, {
      screenShell: true,
      headless: true,
      workspaceRoot: ROOT
    })
    expect((await s.authorize(editTool, { path: String.raw`C:\elsewhere\x` }, 'c1')).allowed).toBe(true)
  })
})
