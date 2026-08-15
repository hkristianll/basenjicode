import path from 'node:path'

/**
 * Safety guard against an agent recursively deleting its own workspace. A confused model can run
 * `rm -rf <project>` / `Remove-Item -Recurse -Force <project>` in a loop and wipe everything (this happened:
 * a model decided its rewrites were "cached", deleted the project dir each round, and only the circuit-breaker
 * stopped it). Deleting a SUBFOLDER (node_modules, dist, build/tmp) is fine and stays allowed — this only
 * refuses a recursive delete whose target is the workspace root itself, a PARENT of it, a filesystem/home
 * root, or a blanket "everything here" wildcard.
 *
 * Pure + heuristic: returns a refusal reason string when the command is dangerous, or null to allow.
 */
export function dangerousRecursiveDelete(command: string, workspaceRoot: string): string | null {
  const onWin = process.platform === 'win32'
  const root = path.resolve(workspaceRoot)
  const canon = (p: string): string => {
    const r = path.resolve(root, p).replace(/[\\/]+$/, '')
    return onWin ? r.toLowerCase() : r
  }
  const rootC = canon(root)

  // Examine each chained segment separately (`taskkill; Remove-Item ...` etc.).
  for (const seg of command.split(/\n|;|&&|\|\||&/)) {
    const s = seg.trim()
    if (!s || !isRecursiveDelete(s)) continue

    for (const t0 of deleteTargets(s, onWin)) {
      const t = t0.trim()
      if (!t) continue
      // Literal filesystem/home roots and blanket wildcards — catastrophic regardless of the workspace.
      if (/^([/~]|~\/|\*|\.\/?\*?|[a-zA-Z]:[\\/]?)$/.test(t)) {
        return `refusing to recursively delete "${t}": it targets the whole workspace or a filesystem/home root. Delete specific files or subfolders instead.`
      }
      const c = canon(t)
      // The workspace root itself, or an ANCESTOR of it (the workspace lives inside the target).
      if (c === rootC || rootC.startsWith(c + path.sep)) {
        return `refusing to recursively delete "${t}": it is the workspace directory or a parent of it. Delete specific files or subfolders instead.`
      }
      // Resolved to a bare drive/filesystem root.
      if (/^([a-zA-Z]:)?$/.test(c)) {
        return `refusing to recursively delete a drive/filesystem root ("${t}").`
      }
    }
  }
  return null
}

/** True when the segment is a RECURSIVE delete (rm -r / Remove-Item -Recurse / rmdir /s …). */
function isRecursiveDelete(seg: string): boolean {
  const s = seg.toLowerCase()
  if (/\brm\b/.test(s) && (/(^|\s)-[a-z]*r/.test(s) || /--recursive/.test(s))) return true
  if (/\b(remove-item|ri)\b/.test(s) && (/-recurse\b/.test(s) || /(^|\s)-r\b/.test(s))) return true
  if (/\b(rmdir|rd)\b/.test(s) && /\s\/s\b/.test(s)) return true // cmd rmdir /s
  return false
}

/** Candidate target paths in a delete segment: quoted strings + bare non-flag tokens. */
function deleteTargets(seg: string, onWin: boolean): string[] {
  const targets: string[] = []
  for (const m of seg.match(/"([^"]*)"|'([^']*)'/g) ?? []) targets.push(m.slice(1, -1))
  for (const tok of seg.replace(/"[^"]*"|'[^']*'/g, ' ').split(/\s+/)) {
    if (!tok) continue
    if (/^(sudo|rm|remove-item|ri|rmdir|rd|del|erase)$/i.test(tok)) continue // the verb itself
    if (tok.startsWith('-')) continue // a flag (-rf, -Recurse, -Force, …)
    if (onWin && /^\/[a-z?]$/i.test(tok)) continue // a cmd switch like /s /q (POSIX abs paths handled as targets)
    targets.push(tok)
  }
  return targets
}
