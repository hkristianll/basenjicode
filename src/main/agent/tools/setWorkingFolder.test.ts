import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { refuseWorkingFolder, setWorkingFolderTool } from './setWorkingFolder'
import { Workspace } from '../workspace'
import { ReadTracker, SnapshotRecorder, type ToolContext } from '../registry'

const ROOT = path.join(os.tmpdir(), 'nordcode-set-working-folder-test')

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspace: new Workspace(ROOT),
    signal: new AbortController().signal,
    reads: new ReadTracker(),
    snapshots: new SnapshotRecorder(),
    ...overrides
  }
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(path.join(ROOT, 'new-project'), { recursive: true })
})

describe('refuseWorkingFolder (structural guards)', () => {
  it('refuses a filesystem root', () => {
    expect(refuseWorkingFolder(path.parse(ROOT).root)).toMatch(/filesystem root/)
  })
  it('refuses the home directory itself', () => {
    expect(refuseWorkingFolder(os.homedir())).toMatch(/home directory itself/)
  })
  it('refuses anything under a hidden (dot) directory', () => {
    expect(refuseWorkingFolder(path.join(os.homedir(), '.ssh'))).toMatch(/hidden/)
    expect(refuseWorkingFolder(path.join(os.homedir(), '.config', 'nordcode'))).toMatch(/hidden/)
  })
  it('accepts an ordinary project folder', () => {
    expect(refuseWorkingFolder(path.join(os.homedir(), 'projects', 'demo'))).toBeNull()
  })
})

describe('set_working_folder handler', () => {
  it('errors without the chat-only capability (board/manager sessions)', async () => {
    const out = await setWorkingFolderTool.handler({ path: 'new-project' }, ctx())
    expect(out).toMatch(/^ERROR: this session type cannot/)
  })

  it('errors when the target does not exist, telling the model to create it first', async () => {
    const out = await setWorkingFolderTool.handler({ path: 'missing' }, ctx({ setWorkspaceRoot: (p) => p }))
    expect(out).toMatch(/does not exist/)
  })

  it('errors when the target is a file', async () => {
    fs.writeFileSync(path.join(ROOT, 'notes.txt'), 'x')
    const out = await setWorkingFolderTool.handler({ path: 'notes.txt' }, ctx({ setWorkspaceRoot: (p) => p }))
    expect(out).toMatch(/not a directory/)
  })

  it('resolves a relative path against the current root and re-roots there', async () => {
    const seen: string[] = []
    const out = await setWorkingFolderTool.handler(
      { path: 'new-project' },
      ctx({
        setWorkspaceRoot: (p) => {
          seen.push(p)
          return p
        }
      })
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(fs.realpathSync.native(path.join(ROOT, 'new-project')))
    expect(out).toContain('Working folder is now')
    expect(out).toContain(seen[0])
  })

  it('refuses an absolute path into a hidden directory without calling the capability', async () => {
    const hidden = path.join(ROOT, '.secrets')
    fs.mkdirSync(hidden, { recursive: true })
    const seen: string[] = []
    const out = await setWorkingFolderTool.handler(
      { path: hidden },
      ctx({
        setWorkspaceRoot: (p) => {
          seen.push(p)
          return p
        }
      })
    )
    expect(out).toMatch(/^ERROR: refusing a folder under a hidden/)
    expect(seen).toHaveLength(0)
  })
})
