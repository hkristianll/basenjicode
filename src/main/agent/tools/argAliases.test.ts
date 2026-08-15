import { describe, it, expect } from 'vitest'
import { multiEditTool } from './multiEdit'
import { editFileTool } from './editFile'
import { writeFileTool } from './writeFile'
import { readFileTool } from './readFile'

describe('edit/file tool arg normalization (weak-model shapes)', () => {
  it('multi_edit: file_path + old/new aliases (the shape that failed in the wild)', () => {
    const r = multiEditTool.schema.safeParse({ file_path: 'Tower.ts', edits: [{ old: 'a', new: 'b' }] })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.path).toBe('Tower.ts')
      expect(r.data.edits[0].old_string).toBe('a')
      expect(r.data.edits[0].new_string).toBe('b')
    }
  })

  it('multi_edit: single-edit shape (no edits array) gets wrapped into one', () => {
    const r = multiEditTool.schema.safeParse({ path: 'a.ts', old_string: 'x', new_string: 'y' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.edits).toHaveLength(1)
  })

  it('multi_edit: edits passed as a single object becomes a one-element array', () => {
    const r = multiEditTool.schema.safeParse({ path: 'a.ts', edits: { old_string: 'x', new_string: 'y' } })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.edits).toHaveLength(1)
  })

  it('multi_edit: the correct shape still parses unchanged', () => {
    const r = multiEditTool.schema.safeParse({ path: 'a.ts', edits: [{ old_string: 'x', new_string: 'y', replace_all: true }] })
    expect(r.success && r.data.edits[0].replace_all).toBe(true)
  })

  it('edit_file: file + old/new aliases', () => {
    const r = editFileTool.schema.safeParse({ file: 'a.ts', old: 'x', new: 'y' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.path).toBe('a.ts')
  })

  it('write_file: filename + text aliases', () => {
    const r = writeFileTool.schema.safeParse({ filename: 'a.ts', text: 'hello' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.path).toBe('a.ts')
      expect(r.data.content).toBe('hello')
    }
  })

  it('read_file: file alias nested under "arguments"', () => {
    const r = readFileTool.schema.safeParse({ arguments: { file: 'a.ts' } })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.path).toBe('a.ts')
  })

  it('does NOT clobber a correct path when a stray alias is also present', () => {
    const r = editFileTool.schema.safeParse({ path: 'real.ts', file: 'wrong.ts', old_string: 'x', new_string: 'y' })
    expect(r.success && r.data.path).toBe('real.ts')
  })

  it('still rejects genuinely unrecoverable args (no path anywhere)', () => {
    expect(multiEditTool.schema.safeParse({ edits: [{ old_string: 'x', new_string: 'y' }] }).success).toBe(false)
  })
})
