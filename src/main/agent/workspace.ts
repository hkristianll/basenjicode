import path from 'node:path'
import fs from 'node:fs'

export class SandboxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxError'
  }
}

/**
 * A user-selected project root. The FILE tools resolve model-supplied paths through `resolve()`,
 * which rejects anything escaping the root — including via `..` traversal, absolute paths, or
 * symlink/junction redirection. The SHELL tools (run_shell/run_background) do NOT resolve through
 * here: they only get `cwd = root`, and the command text can reference any path — that gap is
 * covered by the shell-screening tier in SafetyController (shellScreen.ts), not by this sandbox.
 */
export class Workspace {
  readonly root: string

  constructor(root: string) {
    const resolved = path.resolve(root)
    // Real-path the root too (not just the per-call targets): a symlinked/junctioned root — common on
    // Windows for OneDrive-redirected or dev-drive folders — would otherwise leave `this.root` as the
    // link path while nearestRealPath() returns paths under the link target, false-positiving legit
    // in-root writes as escapes. Fall back to the resolved path when the root doesn't exist yet.
    let real = resolved
    try {
      real = fs.realpathSync.native(resolved)
    } catch {
      /* not created yet — keep the resolved path */
    }
    this.root = real
  }

  resolve(p: string): string {
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(this.root, p)
    this.assertInside(abs, p)
    return abs
  }

  private assertInside(abs: string, original: string): void {
    if (this.escapes(abs)) {
      throw new SandboxError(`path "${original}" is outside the workspace`)
    }
    // Symlink/junction defense: real-path the nearest existing ancestor and re-check.
    const real = this.nearestRealPath(abs)
    if (real && this.escapes(real)) {
      throw new SandboxError(`path "${original}" resolves outside the workspace`)
    }
  }

  private escapes(abs: string): boolean {
    const rel = path.relative(this.root, abs)
    return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)
  }

  private nearestRealPath(abs: string): string | null {
    let cur = abs
    const tail: string[] = []
    while (!fs.existsSync(cur)) {
      const parent = path.dirname(cur)
      if (parent === cur) return null
      tail.unshift(path.basename(cur))
      cur = parent
    }
    try {
      const real = fs.realpathSync.native(cur)
      return tail.length ? path.join(real, ...tail) : real
    } catch {
      return null
    }
  }
}
