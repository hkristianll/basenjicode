import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveUserDataDir } from './userData'

const APPDATA = path.join('C:', 'Users', 'x', 'AppData', 'Roaming')
const NEW_DIR = path.join(APPDATA, 'basenjicode')
const OLD_DIR = path.join(APPDATA, 'nordcode')

const OLD_SETTINGS = path.join(OLD_DIR, 'settings.json')
const NEW_SETTINGS = path.join(NEW_DIR, 'settings.json')

describe('resolveUserDataDir (rename migration pin)', () => {
  it('pins to the legacy nordcode dir when it holds settings and the new dir does not', () => {
    expect(resolveUserDataDir(NEW_DIR, (p) => p === OLD_DIR || p === OLD_SETTINGS)).toBe(OLD_DIR)
  })

  it('pins even when Chromium pre-created the new dir (crashpad/caches, no settings.json)', () => {
    expect(resolveUserDataDir(NEW_DIR, (p) => p !== NEW_SETTINGS)).toBe(OLD_DIR)
  })

  it('keeps the default once the new dir has been adopted', () => {
    expect(resolveUserDataDir(NEW_DIR, () => true)).toBeNull()
  })

  it('keeps the default on a fresh machine (neither dir exists)', () => {
    expect(resolveUserDataDir(NEW_DIR, () => false)).toBeNull()
  })

  it('is a no-op when the default already IS the legacy dir (pre-rename build)', () => {
    expect(resolveUserDataDir(OLD_DIR, () => true)).toBeNull()
  })
})
