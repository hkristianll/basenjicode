import { describe, it, expect } from 'vitest'
import { pathGlobToRegExp } from './util'

describe('pathGlobToRegExp', () => {
  it('* does not cross directory separators', () => {
    const re = pathGlobToRegExp('*.ts')
    expect(re.test('a.ts')).toBe(true)
    expect(re.test('src/a.ts')).toBe(false)
  })

  it('**/ matches any number of leading segments (including none)', () => {
    const re = pathGlobToRegExp('**/*.ts')
    expect(re.test('a.ts')).toBe(true)
    expect(re.test('src/a.ts')).toBe(true)
    expect(re.test('src/deep/a.ts')).toBe(true)
    expect(re.test('a.tsx')).toBe(false)
  })

  it('anchors a mid-path ** to the prefix', () => {
    const re = pathGlobToRegExp('src/**/*.test.ts')
    expect(re.test('src/a.test.ts')).toBe(true)
    expect(re.test('src/x/y/a.test.ts')).toBe(true)
    expect(re.test('lib/a.test.ts')).toBe(false)
  })

  it('? matches exactly one non-separator char', () => {
    const re = pathGlobToRegExp('file?.js')
    expect(re.test('file1.js')).toBe(true)
    expect(re.test('file.js')).toBe(false)
    expect(re.test('file12.js')).toBe(false)
  })

  it('treats dots literally and is case-insensitive', () => {
    const re = pathGlobToRegExp('*.JS')
    expect(re.test('app.js')).toBe(true)
    expect(re.test('appxjs')).toBe(false)
  })

  it('normalizes backslashes to forward slashes', () => {
    const re = pathGlobToRegExp('src\\**\\*.ts')
    expect(re.test('src/a/b.ts')).toBe(true)
  })
})
