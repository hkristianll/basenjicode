import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { dangerousRecursiveDelete } from './deleteGuard'

const root = path.resolve('tmp-ws', 'app') // absolute, platform-correct
const parent = path.dirname(root)
const sub = path.join(root, 'node_modules')

describe('dangerousRecursiveDelete — refuses deleting the workspace or above', () => {
  it('refuses Remove-Item -Recurse -Force of the workspace root (the real incident)', () => {
    expect(dangerousRecursiveDelete(`Remove-Item -Recurse -Force "${root}"`, root)).toMatch(/workspace directory or a parent/)
  })
  it('refuses rm -rf of the workspace root', () => {
    expect(dangerousRecursiveDelete(`rm -rf "${root}"`, root)).not.toBeNull()
  })
  it('refuses deleting a PARENT of the workspace', () => {
    expect(dangerousRecursiveDelete(`Remove-Item -Recurse -Force "${parent}"`, root)).not.toBeNull()
  })
  it('refuses blanket targets: . * / ~', () => {
    expect(dangerousRecursiveDelete('rm -rf .', root)).not.toBeNull()
    expect(dangerousRecursiveDelete('rm -rf *', root)).not.toBeNull()
    expect(dangerousRecursiveDelete('rm -rf /', root)).not.toBeNull()
    expect(dangerousRecursiveDelete('rm -rf ~', root)).not.toBeNull()
  })
  it('catches a destructive delete chained after another command', () => {
    expect(dangerousRecursiveDelete(`taskkill /F /IM python3.exe ; Remove-Item -Recurse -Force "${root}"`, root)).not.toBeNull()
  })
  it('refuses relative .. that resolves to a parent', () => {
    expect(dangerousRecursiveDelete('rm -rf ../', root)).not.toBeNull()
  })
})

describe('dangerousRecursiveDelete — allows legitimate deletes', () => {
  it('allows recursively deleting a SUBFOLDER (node_modules)', () => {
    expect(dangerousRecursiveDelete(`Remove-Item -Recurse -Force "${sub}"`, root)).toBeNull()
    expect(dangerousRecursiveDelete('rm -rf node_modules', root)).toBeNull()
    expect(dangerousRecursiveDelete('rm -rf dist build/tmp', root)).toBeNull()
  })
  it('allows a non-recursive single-file delete', () => {
    expect(dangerousRecursiveDelete('Remove-Item -Force stale.txt', root)).toBeNull()
    expect(dangerousRecursiveDelete('rm file.txt', root)).toBeNull()
  })
  it('ignores non-delete commands', () => {
    expect(dangerousRecursiveDelete('npm install', root)).toBeNull()
    expect(dangerousRecursiveDelete('taskkill /F /IM python3.exe', root)).toBeNull()
    expect(dangerousRecursiveDelete('git clean -n', root)).toBeNull()
  })
})
