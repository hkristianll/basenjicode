import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeTextAtomic } from './fsutil'

describe('writeTextAtomic', () => {
  it('creates a new file, making parent directories', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-atomic-'))
    try {
      const f = path.join(dir, 'sub', 'a.txt')
      await writeTextAtomic(f, 'hello')
      expect(await fs.readFile(f, 'utf8')).toBe('hello')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('overwrites an existing file and leaves no temp file behind', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-atomic-'))
    try {
      const f = path.join(dir, 'a.txt')
      await writeTextAtomic(f, 'one')
      await writeTextAtomic(f, 'two')
      expect(await fs.readFile(f, 'utf8')).toBe('two')
      const entries = await fs.readdir(dir)
      expect(entries.some((e) => e.includes('.tmp'))).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
