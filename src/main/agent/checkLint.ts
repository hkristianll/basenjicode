// Lint a model-authored CHECK command for shapes that cannot run in the host shell. The executor already selects
// PowerShell on Windows and a POSIX shell on macOS/Linux; this is the matching authoring contract for planners,
// repair paths, and terminal decisions. Reject only unmistakably cross-dialect or structurally invalid commands:
// a false rejection parks correct work just as surely as a broken check does.
import { shellFamily, type ShellFamily } from '../shell/powershell'

export interface CheckLintResult {
  ok: boolean
  reason?: string
}

const BASH_TEST = /\btest\s+-[a-zA-Z]\b/
const BASH_HEAD = /^\s*(grep|sed|awk|cat|ls|rm|cp|mv|touch|chmod|chown|which|head|tail|find)\b/i
const DEV_NULL = /\/dev\/null/
const POWERSHELL_COMMAND =
  /(?:^|[;|&()]\s*)(Test-Path|Select-String|Get-Content|Get-Item|Get-ChildItem|Set-Content|New-Item|Remove-Item|Copy-Item|Move-Item|Write-Output)\b/i
const POWERSHELL_NULL = /\$null\b/i
// `Test-Path a -and …` with no wrapping parens is a PowerShell parse error (`-and` is read as a parameter).
const BARE_TESTPATH_AND = /Test-Path\b[^()\n]*\s-(and|or)\b/i
// `(cd frontend; npm run build)` is invalid as a PowerShell condition but a valid POSIX subshell.
const PAREN_SEMICOLON = /\([^()]*;[^()]*\)/

export function shellCheckLabel(family: ShellFamily = shellFamily()): string {
  return family === 'powershell' ? 'PowerShell' : 'POSIX shell'
}

/** Prompt fragment shared by every place that asks a model to author an autonomous check. */
export function checkPromptRules(family: ShellFamily = shellFamily()): string {
  const common =
    'The check must pass (exit 0) only when the work is done. Prefer one portable tool command such as `npm test`, ' +
    '`pytest`, `npx tsc --noEmit`, or `npm run build`.'
  if (family === 'powershell') {
    return (
      common +
      ' It runs in PowerShell on Windows: never use bash-only syntax (`test -f`, `grep`, `/dev/null`, `&&`, `||`). ' +
      'For scaffold/config/docs existence checks use `Test-Path`/`Select-String`; combine conditions as `(Test-Path a) -and (Test-Path b)`.'
    )
  }
  return (
    common +
    ' It runs in a POSIX shell on macOS/Linux: never use PowerShell cmdlets (`Test-Path`, `Select-String`, `Get-Content`) or `$null`. ' +
    'For scaffold/config/docs existence checks use `test -f`/`test -d` and `grep -q`; combine conditions with `&&`/`||`.'
  )
}

/** Validate a check for the shell that will actually execute it. */
export function validateCheck(
  cmd: string | undefined | null,
  family: ShellFamily = shellFamily()
): CheckLintResult {
  const c = (cmd ?? '').trim()
  if (!c) return { ok: true } // an empty check routes to review elsewhere; it is not a lint failure

  if (family === 'powershell') {
    if (BASH_TEST.test(c)) return { ok: false, reason: 'uses bash `test -f/-d`; use PowerShell `Test-Path`' }
    if (BASH_HEAD.test(c)) {
      return {
        ok: false,
        reason: `starts with the Unix command \`${c.split(/\s+/)[0]}\`; use a PowerShell cmdlet or a portable tool command (npm/npx/pytest)`
      }
    }
    if (DEV_NULL.test(c)) return { ok: false, reason: 'redirects to /dev/null; use PowerShell `2>$null`' }
    if (BARE_TESTPATH_AND.test(c)) {
      return {
        ok: false,
        reason: '`Test-Path a -and …` is a PowerShell parse error; wrap each condition: `(Test-Path a) -and (Test-Path b)`'
      }
    }
    if (PAREN_SEMICOLON.test(c)) {
      return {
        ok: false,
        reason: 'puts `;` inside `(...)`, which PowerShell cannot use as a condition; use one tool command or chain with `;` at top level'
      }
    }
    return { ok: true }
  }

  const psCommand = POWERSHELL_COMMAND.exec(c)
  if (psCommand) {
    return {
      ok: false,
      reason: `uses the PowerShell cmdlet \`${psCommand[1]}\`; use a POSIX command or a portable tool command (npm/npx/pytest)`
    }
  }
  if (POWERSHELL_NULL.test(c)) return { ok: false, reason: 'redirects to PowerShell `$null`; use `2>/dev/null`' }
  return { ok: true }
}

/** Auto-rewrite only trivial, semantics-preserving cross-dialect slips. */
export function rewriteCheck(cmd: string, family: ShellFamily = shellFamily()): string | null {
  const c = cmd.trim()
  const parenSemi = /\(([^()]*;[^()]*)\)/g
  let inner: string | null = null
  let g: RegExpExecArray | null
  while ((g = parenSemi.exec(c)) !== null) inner = g[1].trim()
  if (inner && family === 'powershell') return inner

  if (family === 'powershell') {
    const m = /^\s*test\s+-([efd])\s+(.+)$/i.exec(c)
    if (!m) return null
    const kind = m[1].toLowerCase()
    const path = m[2].trim()
    return kind === 'd' ? `Test-Path ${path} -PathType Container` : kind === 'f' ? `Test-Path ${path} -PathType Leaf` : `Test-Path ${path}`
  }

  // A Test-Path rewrite is safe only when its operand is one inert path. Fail closed on compound PowerShell:
  // returning a half-rewritten `test -e a -and Test-Path b` passes our conservative linter but can never pass in sh.
  const posixTest = (flag: '-e' | '-f' | '-d', operand: string): string | null => {
    const path = operand.trim()
    const oneInertPath =
      /^'[^']*'$/.test(path) || /^"[^"$`]*"$/.test(path) || /^[^\s;&|()$`*?\[\]{}<>!,\\]+$/.test(path)
    if (!oneInertPath) return null
    const candidate = `test ${flag} ${path}`
    return validateCheck(candidate, 'posix').ok ? candidate : null
  }

  const namedFirst = /^\s*Test-Path\s+-PathType\s+(Leaf|Container)\s+(.+)$/i.exec(c)
  const pathFirst = /^\s*Test-Path\s+(.+?)\s+-PathType\s+(Leaf|Container)\s*$/i.exec(c)
  if (namedFirst) {
    const flag = namedFirst[1].toLowerCase() === 'leaf' ? '-f' : '-d'
    return posixTest(flag, namedFirst[2])
  }
  if (pathFirst) {
    const flag = pathFirst[2].toLowerCase() === 'leaf' ? '-f' : '-d'
    return posixTest(flag, pathFirst[1])
  }
  const plain = /^\s*Test-Path\s+(.+)$/i.exec(c)
  return plain ? posixTest('-e', plain[1]) : null
}
