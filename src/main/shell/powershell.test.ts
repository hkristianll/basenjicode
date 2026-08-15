import { describe, it, expect } from 'vitest'
import {
  buildPsInvocation,
  normalizePowerShellChaining,
  shellFamily,
  osLabel,
  resolveShellInvocation,
  shellPromptRules,
  treeKill,
  SPAWN_DETACHED
} from './powershell'

describe('normalizePowerShellChaining', () => {
  it('rewrites top-level && to ; (PS 5.1 has no &&)', () => {
    expect(normalizePowerShellChaining('cd app && npm run dev')).toBe('cd app ; npm run dev')
  })
  it('rewrites || to ; as well', () => {
    expect(normalizePowerShellChaining('npm test || echo failed')).toBe('npm test ; echo failed')
  })
  it('leaves a single pipe untouched', () => {
    expect(normalizePowerShellChaining('Get-Process | Select-Object -First 1')).toBe(
      'Get-Process | Select-Object -First 1'
    )
  })
  it('does not touch && inside a quoted string', () => {
    expect(normalizePowerShellChaining('Write-Output "a && b"')).toBe('Write-Output "a && b"')
  })
  it('handles multiple chained commands', () => {
    expect(normalizePowerShellChaining('a && b && c')).toBe('a ; b ; c')
  })
  it('does not rewrite && inside a here-string', () => {
    const hs = "@'\n a && b \n'@"
    expect(normalizePowerShellChaining(hs)).toBe(hs)
  })
  it('does not exit a double-quoted string at a backtick-escaped quote (so its && stays literal)', () => {
    const cmd = 'Write-Output "a `" && b"'
    expect(normalizePowerShellChaining(cmd)).toBe(cmd)
  })
})

describe('cross-platform shell helpers', () => {
  const isWin = process.platform === 'win32'

  it('shellFamily + osLabel reflect the host OS', () => {
    expect(shellFamily()).toBe(isWin ? 'powershell' : 'posix')
    expect(osLabel()).toBe(isWin ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux')
  })

  it('resolveShellInvocation targets the right shell for the OS', () => {
    const { exe, args } = resolveShellInvocation('echo hi')
    if (isWin) {
      expect(exe).toMatch(/powershell\.exe|pwsh\.exe/)
      expect(args).toContain('-Command')
    } else {
      expect(args).toEqual(['-c', 'echo hi'])
    }
  })

  it('does NOT rewrite && to ; on POSIX (bash has native short-circuit)', () => {
    if (isWin) return // the Windows PS-5.1 rewrite is covered by buildPsInvocation tests
    const { args } = resolveShellInvocation('a && b')
    expect(args).toEqual(['-c', 'a && b'])
  })

  it('shellPromptRules matches the platform shell', () => {
    const rules = shellPromptRules()
    if (isWin) expect(rules).toMatch(/PowerShell on Windows/)
    else expect(rules).toMatch(/POSIX shell/)
  })

  it('SPAWN_DETACHED is false on Windows, true on POSIX', () => {
    expect(SPAWN_DETACHED).toBe(!isWin)
  })

  it('treeKill is a no-op for an undefined pid', () => {
    expect(() => treeKill(undefined)).not.toThrow()
  })
})

describe('buildPsInvocation', () => {
  it('uses pwsh.exe and preserves && when PowerShell 7 is available', () => {
    const { exe, args } = buildPsInvocation({ command: 'a && b', pwshAvailable: true })
    expect(exe).toBe('pwsh.exe')
    expect(args).toContain('a && b')
  })
  it('falls back to powershell.exe and normalizes && when PS7 is absent', () => {
    const { exe, args } = buildPsInvocation({ command: 'a && b', pwshAvailable: false })
    expect(exe).toBe('powershell.exe')
    expect(args[args.length - 1]).toBe('a ; b')
  })
  it('always passes -ExecutionPolicy Bypass (unblocks npm/npx .ps1 launchers)', () => {
    for (const pwshAvailable of [true, false]) {
      const { args } = buildPsInvocation({ command: 'npx tsc', pwshAvailable })
      const i = args.indexOf('-ExecutionPolicy')
      expect(i).toBeGreaterThanOrEqual(0)
      expect(args[i + 1]).toBe('Bypass')
    }
  })
})
