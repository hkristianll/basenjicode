import { describe, expect, it } from 'vitest'
import { osLabel, shellPromptRules } from './powershell'

describe('shellPromptRules per platform (A3)', () => {
  it('win32 keeps the exact PowerShell rules', () => {
    const rules = shellPromptRules('win32')
    expect(rules).toContain('PowerShell on Windows')
    expect(rules).toContain("Chain commands with ';', NOT '&&'")
    expect(rules).toContain("'npm.cmd'")
    expect(rules).toContain("'2>$null'")
    expect(rules).not.toContain('POSIX')
  })

  it('darwin gets POSIX rules labeled macOS', () => {
    const rules = shellPromptRules('darwin')
    expect(rules).toContain('POSIX shell (sh/bash) on macOS')
    expect(rules).toContain("'&&', '||', and ';' as usual")
    expect(rules).toContain('rm (not Remove-Item)')
    expect(rules).toContain('2>/dev/null')
    expect(rules).not.toContain('PowerShell cmdlets')
  })

  it('linux gets POSIX rules labeled Linux', () => {
    expect(shellPromptRules('linux')).toContain('POSIX shell (sh/bash) on Linux')
  })

  it('osLabel maps all three platforms', () => {
    expect(osLabel('win32')).toBe('Windows')
    expect(osLabel('darwin')).toBe('macOS')
    expect(osLabel('linux')).toBe('Linux')
  })
})
