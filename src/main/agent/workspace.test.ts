import { describe, it, expect } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import { Workspace, SandboxError } from './workspace'

const root = fs.realpathSync.native(os.tmpdir())
const ws = new Workspace(root)

describe('Workspace.resolve', () => {
  it('resolves a relative path inside the root', () => {
    const p = ws.resolve('foo/bar.txt')
    expect(p.startsWith(root)).toBe(true)
  })

  it('rejects parent traversal', () => {
    expect(() => ws.resolve('../escape.txt')).toThrow(SandboxError)
  })

  it('rejects an absolute path outside the root', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/passwd'
    expect(() => ws.resolve(outside)).toThrow(SandboxError)
  })

  it('rejects a sneaky traversal that climbs out', () => {
    expect(() => ws.resolve('a/b/../../../..')).toThrow(SandboxError)
  })
})
