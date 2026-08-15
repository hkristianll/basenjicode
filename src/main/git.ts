import { spawn } from 'node:child_process'
import { treeKill } from './shell/powershell'

const GIT_TIMEOUT_MS = 30_000

/** Run a git command in `cwd`, capturing output. Never throws (resolves code -1 if git is missing or
 *  the command hangs). A stuck git (auth/lock prompt) would otherwise freeze the Review panel forever,
 *  so we cap it and disable interactive prompts / optional locks. */
export function runGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let done = false
    let child
    try {
      child = spawn('git', args, {
        cwd,
        windowsHide: true,
        // Never let git block on a credential/terminal prompt or a stale index lock.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
      })
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e instanceof Error ? e.message : 'git not found' })
      return
    }
    const finish = (code: number, extra = ''): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr: stderr + extra })
    }
    const timer = setTimeout(() => {
      if (child.pid) treeKill(child.pid, { sync: true })
      else child.kill()
      finish(-1, `\n[git timed out after ${GIT_TIMEOUT_MS}ms]`)
    }, GIT_TIMEOUT_MS)
    // Stream-level UTF-8 decode so multi-byte paths/output aren't corrupted at chunk boundaries.
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => (stdout += d))
    child.stderr?.on('data', (d: string) => (stderr += d))
    child.on('error', (e) => finish(-1, `\n${e.message}`))
    child.on('close', (code) => finish(code ?? -1))
  })
}
