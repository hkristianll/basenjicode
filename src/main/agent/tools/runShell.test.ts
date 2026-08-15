import { describe, it, expect } from 'vitest'
import { shellHint } from './runShell'
import type { ShellResult } from '../../shell/powershell'

const res = (over: Partial<ShellResult>): ShellResult => ({
  code: 1,
  stdout: '',
  stderr: '',
  timedOut: false,
  ...over
})

// The PowerShell coaching hints only exist on win32 (shellHint platform-branches by design);
// on POSIX these stderr shapes never occur, so the tests are genuinely Windows-scenarios.
describe.runIf(process.platform === 'win32')('shellHint — PowerShell coaching (win32-only)', () => {
  it('coaches on the && statement-separator error', () => {
    const hint = shellHint('cd app && npm run dev', res({ stderr: "The token '&&' is not a valid statement separator" }))
    expect(hint).toMatch(/&&|;/)
  })

  it('coaches on the execution-policy / .ps1 block', () => {
    const hint = shellHint('npx tsc', res({ stderr: 'npx.ps1 cannot be loaded because running scripts is disabled' }))
    expect(hint).toMatch(/execution policy|\.cmd|node/i)
  })

  it('coaches when a Unix command is used', () => {
    const hint = shellHint('rm -rf dist', res({ stderr: "rm : The term 'rm' is not recognized as the name of a cmdlet" }))
    expect(hint).toMatch(/Remove-Item/)
  })
})

describe('shellHint', () => {
  it('suggests run_background when a server command times out', () => {
    const hint = shellHint('npx serve -l 3000', res({ timedOut: true, stderr: '' }))
    expect(hint).toMatch(/run_background/)
  })

  it('returns null when nothing is actionable', () => {
    expect(shellHint('npm test', res({ code: 0, stdout: 'ok' }))).toBeNull()
  })
})
