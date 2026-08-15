// Lint a model-authored CHECK command for shapes that can NEVER pass in PowerShell-on-Windows, so a
// structurally-broken check never parks a ticket whose work is actually correct (mode 2). The check is run
// VERBATIM through PowerShell (boardInner.runCheck), so a bash idiom or invalid-PS syntax exits non-zero
// forever. This is the deterministic, zero-model-cost gate that the failure data shows is missing.
//
// CONSERVATIVE BY DESIGN — reject ONLY unambiguously-bash / invalid-PS shapes; a false reject would itself
// park good work. Deliberately NOT rejected: `2>&1` (valid PowerShell stream-merge), `&&`/`||` (already
// rewritten to `;` for checks by normalizePowerShellChaining on PS5.1 / native on pwsh7), and `grep` used
// mid-command (Git-for-Windows ships grep.exe on many dev PATHs — only the bash-command-as-HEAD form is rejected).

export interface CheckLintResult {
  ok: boolean
  reason?: string
}

const BASH_TEST = /\btest\s+-[a-zA-Z]\b/ //                     `test -f x`, `test -d x` — bash, not PowerShell
const BASH_HEAD = /^\s*(grep|sed|awk|cat|ls|rm|cp|mv|touch|chmod|chown|which|head|tail|find)\b/i // Unix cmd as the command head
const DEV_NULL = /\/dev\/null/ //                              bash redirect target (PS uses $null)
// `Test-Path a -and …` with NO wrapping parens is a PowerShell parse error (`-and` is read as a parameter to
// Test-Path). The valid form `(Test-Path a) -and (Test-Path b)` has a `)` before `-and`, so it does NOT match.
const BARE_TESTPATH_AND = /Test-Path\b[^()\n]*\s-(and|or)\b/i
// `(cd frontend; npm run build)` — a `;` INSIDE parentheses. PowerShell can't parse a parenthesized statement
// list as a value/condition (esp. as a `-and` operand), so the check is a parse error and parks good work
// FOREVER (the Theme-Switcher pathology: component built + 146 tests green, but `(Test-Path X) -and (cd Y; cmd)`
// never exits 0). Valid top-level chaining (`cd Y; cmd`) needs no parens, so this only catches the broken shape.
const PAREN_SEMICOLON = /\([^()]*;[^()]*\)/

/** Validate a check command. ok:true for an empty/missing check (handled elsewhere → review), valid PS, or a
 *  portable tool command; ok:false with a one-line reason for a known-broken shape. */
export function validateCheck(cmd: string | undefined | null): CheckLintResult {
  const c = (cmd ?? '').trim()
  if (!c) return { ok: true } // an empty check is not a lint failure — decideTerminal routes it to review
  if (BASH_TEST.test(c)) return { ok: false, reason: 'uses bash `test -f/-d`; use PowerShell `Test-Path`' }
  if (BASH_HEAD.test(c)) return { ok: false, reason: `starts with the Unix command \`${c.split(/\s+/)[0]}\`; use a PowerShell cmdlet or a portable tool command (npm/npx/pytest)` }
  if (DEV_NULL.test(c)) return { ok: false, reason: 'redirects to /dev/null (bash); use `2>$null` in PowerShell' }
  if (BARE_TESTPATH_AND.test(c)) return { ok: false, reason: '`Test-Path a -and …` is a PowerShell parse error; wrap each in parens: `(Test-Path a) -and (Test-Path b)`' }
  if (PAREN_SEMICOLON.test(c)) return { ok: false, reason: 'puts `;` inside `(...)` — PowerShell cannot parse `(cmd; cmd)` as a condition; use ONE tool command (e.g. `npm --prefix frontend run build`) or chain with `;` at top level (no parens)' }
  return { ok: true }
}

/** Auto-rewrite the two recoverable slips. Returns null when there is no safe rewrite — the caller then drops
 *  the check (→ ticket goes to review, never park-forever).
 *   1. `(cd X; npm test)` parenthesized statement-list (usually `(Test-Path …) -and (cd X; cmd)`): the real
 *      verification is the command group with the `;`; an `(Test-Path …) -and` prefix is a redundant existence
 *      check the command itself already implies. Unwrap the LAST such group → a valid top-level chain.
 *   2. `test -f X` → `Test-Path X`. */
export function rewriteCheck(cmd: string): string | null {
  const c = cmd.trim()
  const parenSemi = /\(([^()]*;[^()]*)\)/g
  let inner: string | null = null
  let g: RegExpExecArray | null
  while ((g = parenSemi.exec(c)) !== null) inner = g[1].trim()
  if (inner) return inner
  const m = /^\s*test\s+-[a-zA-Z]\s+(.+)$/i.exec(c)
  return m ? `Test-Path ${m[1].trim()}` : null
}
