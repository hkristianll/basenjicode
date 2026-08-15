import { spawn, spawnSync } from 'node:child_process'

export interface ShellResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * PS 5.1 (the default `powershell.exe`) has no `&&` / `||` operators — a model that emits Bash-style
 * `cd x && npm run dev` gets a parse error and, lacking feedback, repeats it forever. When we fall
 * back to 5.1 we rewrite top-level `&&`/`||` (outside quotes) to `;` so the chain at least runs.
 * PowerShell 7 (`pwsh`) supports both natively, so we leave its commands untouched.
 */
export function normalizePowerShellChaining(command: string): string {
  let out = ''
  let quote: '"' | "'" | null = null
  let here: '"' | "'" | null = null // inside an @' … '@ / @" … "@ here-string
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    // Inside a here-string nothing is an operator; only a line-start '@ / "@ terminator closes it.
    if (here) {
      out += c
      if (c === here && command[i + 1] === '@' && (i === 0 || command[i - 1] === '\n')) {
        out += '@'
        i++
        here = null
      }
      continue
    }
    if (quote) {
      // In a double-quoted string a backtick escapes the next char (e.g. `" or `$) — keep both verbatim
      // so an escaped quote doesn't prematurely end the string and expose a literal && to the rewrite.
      if (c === '`' && quote === '"' && i + 1 < command.length) {
        out += c + command[i + 1]
        i++
        continue
      }
      out += c
      if (c === quote) quote = null
      continue
    }
    // Start of a here-string: @' or @" that ends the line.
    if (c === '@' && (command[i + 1] === "'" || command[i + 1] === '"')) {
      const after = command[i + 2]
      if (after === undefined || after === '\n' || after === '\r') {
        here = command[i + 1] as '"' | "'"
        out += c + command[i + 1]
        i++
        continue
      }
    }
    // A backtick outside quotes escapes the next char in PowerShell — never an operator boundary.
    if (c === '`' && i + 1 < command.length) {
      out += c + command[i + 1]
      i++
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      out += c
      continue
    }
    if ((c === '&' && command[i + 1] === '&') || (c === '|' && command[i + 1] === '|')) {
      out += ';'
      i++ // skip the second operator char
      continue
    }
    out += c
  }
  return out
}

/** The PowerShell executable + args for a command, given whether PowerShell 7 is available. */
export function buildPsInvocation(opts: {
  command: string
  pwshAvailable: boolean
}): { exe: string; args: string[] } {
  const exe = opts.pwshAvailable ? 'pwsh.exe' : 'powershell.exe'
  // PS7 keeps `&&`/`||`; only the 5.1 fallback needs the rewrite.
  const command = opts.pwshAvailable ? opts.command : normalizePowerShellChaining(opts.command)
  // `-ExecutionPolicy Bypass` lets npm/npx `.ps1` launchers run even when the machine policy is
  // Restricted — otherwise `npx ...` dies with "running scripts is disabled on this system".
  return { exe, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command] }
}

// Detect PowerShell 7 once per process; spawning the real shell goes through buildPsInvocation.
let pwshAvailableCache: boolean | null = null
function isPwshAvailable(): boolean {
  if (pwshAvailableCache !== null) return pwshAvailableCache
  try {
    const r = spawnSync('pwsh.exe', ['-NoProfile', '-NoLogo', '-Command', '$PSVersionTable.PSVersion.Major'], {
      windowsHide: true,
      timeout: 4000
    })
    pwshAvailableCache = r.status === 0
  } catch {
    pwshAvailableCache = false
  }
  return pwshAvailableCache
}

export type ShellFamily = 'powershell' | 'posix'

/** Which shell family this OS uses — PowerShell on Windows, a POSIX shell (sh/bash) elsewhere. */
export function shellFamily(): ShellFamily {
  return process.platform === 'win32' ? 'powershell' : 'posix'
}

/** OS name for the system prompt ("Windows" / "macOS" / "Linux"). */
export function osLabel(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux'
}

/**
 * The platform-correct shell syntax rules injected into the system prompt, so the model is told to
 * write PowerShell on Windows and POSIX sh/bash on macOS/Linux (using the right chaining, tools, and
 * redirects for each) instead of always being given Windows rules.
 */
export function shellPromptRules(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `Shell: PowerShell on Windows. run_shell/run_background syntax rules — get these right or commands fail:
- Chain commands with ';', NOT '&&' or '||' (those are parse errors in Windows PowerShell). For "run B only if A succeeds" use 'A; if ($?) { B }'.
- Use PowerShell cmdlets, not Unix tools: Remove-Item (not rm), Copy-Item (not cp), Move-Item (not mv), New-Item -ItemType Directory (not mkdir -p). Quote any path that contains spaces.
- Prefer 'npm.cmd' / 'npx.cmd' / 'node' over bare 'npm'/'npx'. Redirect with '2>$null', not '2>/dev/null'.`
  }
  return `Shell: a POSIX shell (sh/bash) on ${osLabel(platform)}. run_shell/run_background syntax rules:
- Chain commands with '&&', '||', and ';' as usual (e.g. 'cd app && npm run build').
- Use standard Unix tools: rm (not Remove-Item), cp, mv, mkdir -p. Quote any path that contains spaces.
- Use 'npm' / 'npx' / 'node' directly. Redirect with '2>/dev/null'.`
}

/**
 * The real shell exe + args for a command. On Windows: PowerShell (PS7 when present, execution-policy
 * bypass, &&/|| normalization on the 5.1 fallback). On macOS/Linux: the user's $SHELL (or /bin/sh)
 * with `-c` — POSIX shells have native &&/|| so the PowerShell rewrite is NOT applied (it would change
 * short-circuit semantics). Used by every spawn site (run_shell AND run_background) so they agree.
 */
export function resolveShellInvocation(command: string): { exe: string; args: string[] } {
  if (process.platform === 'win32') {
    return buildPsInvocation({ command, pwshAvailable: isPwshAvailable() })
  }
  const shell = process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL : '/bin/sh'
  return { exe: shell, args: ['-c', command] }
}

/** @deprecated name kept for back-compat; use {@link resolveShellInvocation}. */
export const resolvePsInvocation = resolveShellInvocation

/** True when a child must be spawned as its own process-group leader so the whole tree can be killed. */
export const SPAWN_DETACHED = process.platform !== 'win32'

/**
 * Kill a child process AND its descendants, cross-platform. Windows: `taskkill /T /F` walks the tree.
 * POSIX: signal the process GROUP (negative pid) — which only works if the child was spawned
 * `detached: true` (SPAWN_DETACHED) so it leads its own group; falls back to a direct kill otherwise.
 */
export function treeKill(pid: number | undefined, opts?: { sync?: boolean; platform?: NodeJS.Platform }): void {
  if (!pid) return
  if ((opts?.platform ?? process.platform) === 'win32') {
    try {
      if (opts?.sync) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'])
      else spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } catch {
      /* ignore */
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL') // whole process group
  } catch {
    try {
      process.kill(pid, 'SIGKILL') // group kill failed (not a leader) — at least kill the child
    } catch {
      /* ignore */
    }
  }
}

// Track live foreground children so they can be tree-killed on app quit (N3).
const foreground = new Set<number>()

export function killAllForeground(): void {
  for (const pid of foreground) treeKill(pid, { sync: true })
  foreground.clear()
}

/** Run a single shell command (PowerShell on Windows, $SHELL on POSIX), capturing output with a
 *  timeout and abort support. */
export function runPowerShell(opts: {
  command: string
  cwd: string
  timeoutMs: number
  signal: AbortSignal
}): Promise<ShellResult> {
  return new Promise((resolve) => {
    const { exe, args } = resolveShellInvocation(opts.command)
    // detached on POSIX so the child leads its own process group and treeKill can take the whole tree.
    const child = spawn(exe, args, { cwd: opts.cwd, windowsHide: true, detached: SPAWN_DETACHED })
    if (child.pid) foreground.add(child.pid)

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const MAX = 1_000_000 // cap captured bytes per stream to avoid runaway memory

    // Stream-level UTF-8 decode so multi-byte output isn't corrupted at chunk boundaries.
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      if (stdout.length < MAX) stdout += d
    })
    child.stderr.on('data', (d: string) => {
      if (stderr.length < MAX) stderr += d
    })

    const kill = (): void => {
      // Kill the whole tree — a command may have spawned children that outlive the shell.
      if (child.pid) treeKill(child.pid)
      else child.kill()
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, opts.timeoutMs)
    const onAbort = (): void => kill()
    opts.signal.addEventListener('abort', onAbort, { once: true })

    const finish = (code: number | null, extraErr = ''): void => {
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
      if (child.pid) foreground.delete(child.pid)
      resolve({ code, stdout, stderr: stderr + extraErr, timedOut })
    }

    child.on('error', (err) => finish(null, `\n[spawn error] ${err.message}`))
    child.on('close', (code) => finish(code))
  })
}
