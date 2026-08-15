import { describe, it, expect } from 'vitest'
import { validateCheck, rewriteCheck } from './checkLint'

describe('validateCheck', () => {
  it('accepts portable tool commands and valid PowerShell', () => {
    for (const ok of [
      'npm test',
      'npx tsc --noEmit',
      'pytest',
      'npm run build',
      'go build ./...',
      'cargo build',
      '(Test-Path a) -and (Test-Path b)',
      'cd frontend; npm run build', // top-level `;` chaining is valid — only `;` INSIDE parens is the parse error
      'Select-String foo file',
      'npm run build 2>&1', // 2>&1 is VALID PowerShell stream-merge — must NOT be rejected
      'true'
    ]) {
      expect(validateCheck(ok).ok, ok).toBe(true)
    }
  })

  it('rejects the bash `test -f/-d` idiom', () => {
    expect(validateCheck('test -f dist/app.js').ok).toBe(false)
    expect(validateCheck('test -d build').ok).toBe(false)
  })

  it('rejects a Unix command used as the command head', () => {
    expect(validateCheck('grep -q foo src/x.ts').ok).toBe(false)
    expect(validateCheck('cat package.json').ok).toBe(false)
    expect(validateCheck('ls dist').ok).toBe(false)
  })

  it('rejects a /dev/null redirect (bash)', () => {
    expect(validateCheck('node build.js > /dev/null').ok).toBe(false)
  })

  it('rejects an unparenthesized `Test-Path a -and Test-Path b` (PowerShell parse error)', () => {
    expect(validateCheck('Test-Path a -and Test-Path b').ok).toBe(false)
  })

  it('rejects a `;` inside parentheses — the (cd X; npm test) parse error that re-filed the Theme Switcher', () => {
    expect(validateCheck('(Test-Path frontend/src/components/ThemeSwitcher.tsx) -and (cd frontend; npm run build)').ok).toBe(false)
    expect(validateCheck('(cd frontend; npm test)').ok).toBe(false)
  })

  it('treats an empty/missing check as ok (routed to review elsewhere, not a lint failure)', () => {
    expect(validateCheck('').ok).toBe(true)
    expect(validateCheck('   ').ok).toBe(true)
    expect(validateCheck(undefined).ok).toBe(true)
    expect(validateCheck(null).ok).toBe(true)
  })
})

describe('rewriteCheck', () => {
  it('rewrites the trivial bash test to Test-Path', () => {
    expect(rewriteCheck('test -f dist/app.js')).toBe('Test-Path dist/app.js')
  })
  it('returns null when there is no safe trivial rewrite', () => {
    expect(rewriteCheck('grep -q foo x')).toBeNull()
    expect(rewriteCheck('npm test')).toBeNull()
  })
  it('unwraps a `(cd X; cmd)` parenthesized statement-list to a valid top-level chain', () => {
    const rewritten = rewriteCheck('(Test-Path frontend/src/components/ThemeSwitcher.tsx) -and (cd frontend; npm run build)')
    expect(rewritten).toBe('cd frontend; npm run build')
    // and the rewrite is itself valid — the done work can finally pass instead of parking forever
    expect(validateCheck(rewritten).ok).toBe(true)
  })
})
