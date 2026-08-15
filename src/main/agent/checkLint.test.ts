import { describe, it, expect } from 'vitest'
import { checkPromptRules, rewriteCheck, shellCheckLabel, validateCheck } from './checkLint'

describe('validateCheck — PowerShell', () => {
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
      expect(validateCheck(ok, 'powershell').ok, ok).toBe(true)
    }
  })

  it('rejects the bash `test -f/-d` idiom', () => {
    expect(validateCheck('test -f dist/app.js', 'powershell').ok).toBe(false)
    expect(validateCheck('test -d build', 'powershell').ok).toBe(false)
  })

  it('rejects a Unix command used as the command head', () => {
    expect(validateCheck('grep -q foo src/x.ts', 'powershell').ok).toBe(false)
    expect(validateCheck('cat package.json', 'powershell').ok).toBe(false)
    expect(validateCheck('ls dist', 'powershell').ok).toBe(false)
  })

  it('rejects a /dev/null redirect (bash)', () => {
    expect(validateCheck('node build.js > /dev/null', 'powershell').ok).toBe(false)
  })

  it('rejects an unparenthesized `Test-Path a -and Test-Path b` (PowerShell parse error)', () => {
    expect(validateCheck('Test-Path a -and Test-Path b', 'powershell').ok).toBe(false)
  })

  it('rejects a `;` inside parentheses — the (cd X; npm test) parse error that re-filed the Theme Switcher', () => {
    expect(validateCheck('(Test-Path frontend/src/components/ThemeSwitcher.tsx) -and (cd frontend; npm run build)', 'powershell').ok).toBe(false)
    expect(validateCheck('(cd frontend; npm test)', 'powershell').ok).toBe(false)
  })

  it('treats an empty/missing check as ok (routed to review elsewhere, not a lint failure)', () => {
    expect(validateCheck('', 'powershell').ok).toBe(true)
    expect(validateCheck('   ', 'powershell').ok).toBe(true)
    expect(validateCheck(undefined, 'powershell').ok).toBe(true)
    expect(validateCheck(null, 'powershell').ok).toBe(true)
  })
})

describe('validateCheck — POSIX', () => {
  it('accepts portable commands and POSIX checks', () => {
    for (const ok of [
      'npm test',
      'npx tsc --noEmit',
      'test -f dist/app.js',
      'test -d build && grep -q ready build/meta.txt',
      'cat package.json',
      'node build.js > /dev/null',
      '(cd frontend; npm run build)'
    ]) {
      expect(validateCheck(ok, 'posix').ok, ok).toBe(true)
    }
  })

  it('rejects unmistakable PowerShell syntax', () => {
    expect(validateCheck('Test-Path dist/app.js', 'posix').ok).toBe(false)
    expect(validateCheck('Select-String ready build/meta.txt', 'posix').ok).toBe(false)
    expect(validateCheck("'{}' | Set-Content generated.json", 'posix').ok).toBe(false)
    expect(validateCheck('node build.js 2>$null', 'posix').ok).toBe(false)
    expect(validateCheck('(Test-Path a) -and (Test-Path b)', 'posix').ok).toBe(false)
  })
})

describe('rewriteCheck per dialect', () => {
  it('rewrites the trivial bash test to Test-Path', () => {
    expect(rewriteCheck('test -f dist/app.js', 'powershell')).toBe('Test-Path dist/app.js -PathType Leaf')
    expect(rewriteCheck('test -d build', 'powershell')).toBe('Test-Path build -PathType Container')
  })
  it('rewrites trivial Test-Path checks to POSIX test', () => {
    expect(rewriteCheck('Test-Path dist/app.js', 'posix')).toBe('test -e dist/app.js')
    expect(rewriteCheck('Test-Path -PathType Leaf dist/app.js', 'posix')).toBe('test -f dist/app.js')
    expect(rewriteCheck('Test-Path -PathType Container build', 'posix')).toBe('test -d build')
    expect(rewriteCheck('Test-Path dist/app.js -PathType Leaf', 'posix')).toBe('test -f dist/app.js')
  })
  it('returns null when there is no safe trivial rewrite', () => {
    expect(rewriteCheck('grep -q foo x', 'powershell')).toBeNull()
    expect(rewriteCheck('npm test', 'powershell')).toBeNull()
    expect(rewriteCheck('Select-String foo x', 'posix')).toBeNull()
  })
  it('fails closed on compound PowerShell conditions instead of producing a permanently-failing POSIX check', () => {
    expect(rewriteCheck('Test-Path a -and Test-Path b', 'posix')).toBeNull()
    expect(rewriteCheck('Test-Path a -or Test-Path b', 'posix')).toBeNull()
    expect(rewriteCheck('Test-Path -PathType Leaf a -and Test-Path b', 'posix')).toBeNull()
    expect(rewriteCheck('Test-Path a -and Get-Item b', 'posix')).toBeNull()
    expect(rewriteCheck('Test-Path a b', 'posix')).toBeNull()
    expect(rewriteCheck('Test-Path a,b', 'posix')).toBeNull()
    expect(rewriteCheck('Test-Path src\\foo.ts', 'posix')).toBeNull()
  })
  it('unwraps a `(cd X; cmd)` parenthesized statement-list to a valid top-level chain', () => {
    const rewritten = rewriteCheck('(Test-Path frontend/src/components/ThemeSwitcher.tsx) -and (cd frontend; npm run build)', 'powershell')
    expect(rewritten).toBe('cd frontend; npm run build')
    // and the rewrite is itself valid — the done work can finally pass instead of parking forever
    expect(validateCheck(rewritten, 'powershell').ok).toBe(true)
  })
})

describe('check prompt contract', () => {
  it('describes the same dialect the validator accepts', () => {
    expect(checkPromptRules('powershell')).toContain('PowerShell on Windows')
    expect(checkPromptRules('powershell')).toContain('Test-Path')
    expect(checkPromptRules('posix')).toContain('POSIX shell on macOS/Linux')
    expect(checkPromptRules('posix')).toContain('test -f')
    expect(shellCheckLabel('powershell')).toBe('PowerShell')
    expect(shellCheckLabel('posix')).toBe('POSIX shell')
  })
})
