/**
 * W3a dangerous-shell screening — the pure classifier.
 *
 * Auto mode runs shell verbatim with full-machine blast radius (the file tools sandbox through
 * Workspace.resolve; run_shell/run_background never did). This classifier flags the four classes that
 * turn an unattended local-model run into a machine-wide hazard; SafetyController downgrades a flagged
 * command to an approval prompt (chat) or a deny-with-guidance (headless board workers).
 *
 * Tuning bias: in-workspace work must never be flagged (`npm install`, `git commit`, `npx vitest`,
 * `Remove-Item -Recurse node_modules`, `rm -rf node_modules` all pass) — a screen that cries wolf gets
 * turned off. Reads are never flagged; only mutations that reach OUTSIDE the workspace,
 * download-and-execute, system mutation, and credential paths.
 *
 * CROSS-PLATFORM (public-release A1): the path analysis is style-aware — the workspace root's own form
 * selects Windows or POSIX pattern sets (naturally injectable for tests). System-mutation and credential
 * lists for BOTH platforms are always active (a Windows command never appears legitimately on macOS and
 * vice versa). FAIL CLOSED: a path-like target the analyzer cannot resolve statically (~, $VAR, %VAR%)
 * inside a mutating command is treated as outside-workspace — never silently allowed.
 */

export type ShellScreenClass = 'outside-workspace' | 'download-execute' | 'system-mutation' | 'credentials'

export type ShellScreenVerdict = { ok: true } | { ok: false; class: ShellScreenClass; reason: string }

// Mutating verbs (PowerShell + cmd + POSIX coreutils). Deliberately does NOT include read verbs or `git`
// (git mutates only its own repo) — this list gates the outside-workspace path analysis, nothing else.
const MUTATING_VERB =
  /(^|[;|&(]\s*|\breturn\s+)(rm|del|erase|rd|rmdir|remove-item|ri|move-item|mv|move|copy-item|cp|copy|xcopy|robocopy|set-content|add-content|out-file|new-item|ni|mkdir|md|tee(-object)?|shred|ln|truncate|dd)\b/i

// ---------- Windows-style path patterns (byte-identical to the pre-A1 behavior) ----------

// Redirection writing to a target (>, >>) — its own mutation channel, independent of any verb.
const WIN_REDIRECT = />{1,2}\s*"?(?<target>([A-Za-z]:[\\/]|\\\\)[^\s"';|&)]*)/g

// Absolute paths anywhere in the command (drive-letter or UNC), quoted or bare.
const WIN_ABS_PATH = /(?:[A-Za-z]:[\\/]|\\\\[\w.$-]+[\\/])[^\s"';|&)]*/g

// cd / Set-Location / pushd to an absolute target: relative mutations after it land outside the workspace.
const WIN_CD_ABS = /\b(cd|chdir|set-location|sl|pushd)\b(\s+(\/d|-\w+))*\s+"?(?<target>([A-Za-z]:|\\\\)[^\s"';|&)]*)/i

// Statically unresolvable Windows target (%VAR%\…) — fail closed when mutating.
const WIN_UNRESOLVABLE = /%[A-Za-z_]\w*%[\\/][^\s"';|&)]*/

// ---------- POSIX-style path patterns ----------

const POSIX_REDIRECT = />{1,2}\s*"?(?<target>[/~][^\s"';|&)]*)/g

// Absolute paths at a token boundary (the boundary set excludes ':' so URLs' `//` never match).
const POSIX_ABS_PATH = /(?:^|[\s"'=|&;(])(\/[^\s"';|&)]*)/g

const POSIX_CD_ABS = /\b(cd|pushd)\b\s+"?(?<target>[/~][^\s"';|&)]*)/i

// Statically unresolvable POSIX target: bare ~, ~/path, $VAR/path, ${VAR}/path, $HOME — fail closed
// when mutating. A bare $word without a slash (e.g. a commit message variable) is NOT path-like.
const POSIX_UNRESOLVABLE = /(?:^|[\s"'=|&;(])(~(?:$|[/\s"';|&)])|\$\{?[A-Za-z_]\w*\}?\/[^\s"';|&)]*|\$HOME\b)/

function normWinPath(p: string): string {
  return p.replace(/\//g, '\\').replace(/[\\]+$/, '').toLowerCase()
}

function isUnderWin(p: string, root: string): boolean {
  const np = normWinPath(p)
  const nr = normWinPath(root)
  return np === nr || np.startsWith(nr + '\\')
}

function normPosixPath(p: string): string {
  return p.replace(/\/+$/, '')
}

// POSIX filesystems are case-sensitive — no lowercasing.
function isUnderPosix(p: string, root: string): boolean {
  const np = normPosixPath(p)
  const nr = normPosixPath(root)
  return np === nr || np.startsWith(nr + '/')
}

export function screenShellCommand(command: string, workspaceRoot: string): ShellScreenVerdict {
  const cmd = command ?? ''
  // The workspace root's own form picks the pattern set — a POSIX root means a POSIX machine.
  const posixStyle = /^\//.test(workspaceRoot ?? '')

  // (b) download-execute: fetched content piped into an interpreter, or iex/Invoke-Expression fed web content.
  if (
    /\b(iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget)\b[^\n]*\|\s*&?\s*(iex\b|invoke-expression|sh\b|bash\b|zsh\b|powershell\b|pwsh\b|cmd\b|node\b|python3?\b)/i.test(cmd) ||
    /\b(iex|invoke-expression)\b[^\n]*\b(iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|https?:\/\/)/i.test(cmd)
  ) {
    return { ok: false, class: 'download-execute', reason: 'downloads content and executes it in one step' }
  }

  // (c) system mutation — Windows AND POSIX lists always active (wrong-platform commands never
  // appear in legitimate work, so cross-flagging costs nothing and catches copy-pasted payloads).
  const system: Array<[RegExp, string]> = [
    [/\breg(\.exe)?\s+(add|delete|import|load|unload)\b/i, 'writes the Windows registry'],
    [/\b(set|new|remove)-itemproperty\b[^\n]*\b(hklm|hkcu|hkcr|hku|hkcc|hkey_)/i, 'writes the Windows registry'],
    [/\bregedit\b/i, 'writes the Windows registry'],
    [/\bsc(\.exe)?\s+(config|create|delete|stop|start|failure)\b/i, 'changes Windows services'],
    [/\b(new|set|stop|remove|restart|suspend)-service\b/i, 'changes Windows services'],
    [/\bshutdown(\.exe)?\b/i, 'shuts down or restarts the machine'],
    [/\b(stop|restart)-computer\b/i, 'shuts down or restarts the machine'],
    [/\bnetsh\b[^\n]*\b(firewall|advfirewall|interface|winsock)\b/i, 'changes network/firewall configuration'],
    [/\b(new|set|remove|disable|enable)-netfirewallrule\b/i, 'changes firewall rules'],
    [/\bschtasks\b/i, 'changes scheduled tasks'],
    [/\b(register|set|unregister)-scheduledtask\b/i, 'changes scheduled tasks'],
    [/\bbcdedit\b/i, 'changes boot configuration'],
    [/\bdiskpart\b/i, 'repartitions disks'],
    [/\bformat(\.com)?\s+[a-z]:/i, 'formats a drive'],
    // POSIX system surface
    [/(^|[;|&(]\s*)sudo\s/i, 'elevates privileges (sudo)'],
    [/\bsystemctl\s+(start|stop|enable|disable|mask|restart|daemon-reload)\b/i, 'changes system services'],
    [/\blaunchctl\s+(load|unload|bootstrap|bootout|enable|disable)\b/i, 'changes launch daemons'],
    [/\bcrontab\b/i, 'changes scheduled jobs (crontab)'],
    [/\bmkfs(\.\w+)?\b/i, 'formats a filesystem'],
    [/\b(fdisk|parted)\b/i, 'repartitions disks'],
    [/\bdd\b[^\n]*\bof=\/dev\//i, 'writes raw device blocks'],
    [/\b(iptables|nft|ufw)\b/i, 'changes firewall rules'],
    [/(^|[;|&(]\s*)(reboot|halt|poweroff)\b/i, 'shuts down or restarts the machine']
  ]
  for (const [re, reason] of system) {
    if (re.test(cmd)) return { ok: false, class: 'system-mutation', reason }
  }

  // (d) credential/key material — both platforms.
  if (
    /\.ssh\b|id_rsa|id_ed25519|\.aws[\\/]credentials|\.gnupg\b|\bcmdkey\b|\bvaultcmd\b|login data|web data|dpapi/i.test(cmd) ||
    /\/etc\/(shadow|passwd|sudoers)\b|\.netrc\b|\bsecurity\s+(find|dump)-[\w-]*password/i.test(cmd)
  ) {
    return { ok: false, class: 'credentials', reason: 'touches credential or key material' }
  }

  // (a) outside-workspace mutation — only when the command actually mutates.
  const isUnder = posixStyle ? isUnderPosix : isUnderWin
  const REDIRECT = posixStyle ? POSIX_REDIRECT : WIN_REDIRECT
  const mutates = MUTATING_VERB.test(cmd)
  const redirects = [...cmd.matchAll(REDIRECT)].map((m) => m.groups?.target ?? '')
  if (mutates || redirects.length > 0) {
    // Redirection targets and any absolute path in a mutating command must stay under the workspace.
    for (const target of redirects) {
      if (target && !isUnder(target, workspaceRoot)) {
        return { ok: false, class: 'outside-workspace', reason: `writes to ${target}, outside the workspace` }
      }
    }
    if (mutates) {
      const absMatches = posixStyle
        ? [...cmd.matchAll(POSIX_ABS_PATH)].map((m) => m[1])
        : cmd.match(WIN_ABS_PATH) ?? []
      for (const m of absMatches) {
        if (!isUnder(m, workspaceRoot)) {
          return { ok: false, class: 'outside-workspace', reason: `references ${m}, outside the workspace, in a write/delete command` }
        }
      }
      // `..` from the workspace root escapes it (run_shell always runs with cwd = workspace root).
      if (/(^|[\\/\s"'=])\.\.([\\/]|\s|$)/.test(cmd)) {
        return { ok: false, class: 'outside-workspace', reason: 'uses a ".." path in a write/delete command (escapes the workspace)' }
      }
      // Changing directory to an absolute path outside the root makes the following relative mutations land there.
      const cd = (posixStyle ? POSIX_CD_ABS : WIN_CD_ABS).exec(cmd)?.groups?.target
      if (cd && !isUnder(cd, workspaceRoot)) {
        return { ok: false, class: 'outside-workspace', reason: `changes directory to ${cd} and mutates there` }
      }
      // FAIL CLOSED: a statically unresolvable target (~, $VAR, %VAR%) in a mutating command cannot be
      // verified as in-workspace — treat it as outside rather than silently allowing it.
      const unresolvable = posixStyle ? POSIX_UNRESOLVABLE : WIN_UNRESOLVABLE
      if (unresolvable.test(cmd)) {
        return {
          ok: false,
          class: 'outside-workspace',
          reason: 'uses a home/env-var path in a write/delete command (cannot verify it stays inside the workspace)'
        }
      }
    }
  }

  return { ok: true }
}
