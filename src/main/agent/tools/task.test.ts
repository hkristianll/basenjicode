import { describe, it, expect } from 'vitest'
import { taskTool, childRegistry } from './task'
import { buildRegistry } from './index'

describe('task (sub-agent) tool', () => {
  it('is registered in the main tool registry', () => {
    expect(buildRegistry().get('task')).toBeTruthy()
  })

  it('is approval-gated (spawning a sub-agent can cost tokens on a remote backend)', () => {
    expect(taskTool.mutating).toBe(true)
    expect(typeof taskTool.preview).toBe('function')
  })

  it('gives a sub-agent ONLY read-only tools — never edit/shell/spawn (the safety guarantee)', () => {
    const names = childRegistry()
      .list()
      .map((t) => t.name)
    // read-only research tools present
    expect(names).toContain('read_file')
    expect(names).toContain('grep')
    expect(names).toContain('glob')
    expect(names).toContain('list_dir')
    // mutating / recursive tools absent
    for (const forbidden of ['write_file', 'edit_file', 'multi_edit', 'delete_file', 'move_file', 'run_shell', 'run_background', 'task']) {
      expect(names).not.toContain(forbidden)
    }
    // and none of the sub-agent's tools are mutating
    expect(childRegistry().list().every((t) => !t.mutating)).toBe(true)
  })
})
