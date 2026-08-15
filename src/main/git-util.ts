/** Pure parsers for git's NUL-delimited (`-z`) porcelain output — electron-free so they can be unit-tested.
 *
 * Why `-z`: the default LF format C-quotes any path with non-ASCII/spaces (e.g. `"caf\303\251.txt"`) and
 * renders a rename as `old -> new` on one line. Slicing `line.slice(3)` then yields a quoted blob or an
 * `old -> new` string, and the per-file diff lookup misses. The `-z` format emits raw, unquoted bytes and
 * splits rename source/target into separate NUL fields, so both problems disappear. */

export interface GitStatusFile {
  path: string
  status: string
  staged: boolean
  added?: number
  deleted?: number
}

/** Parse `git status --porcelain=v1 -z`. Entries are NUL-separated; a rename/copy consumes an extra
 *  NUL field (the original path) which we skip — the path shown is the destination. */
export function parsePorcelainZ(out: string): { code: string; path: string }[] {
  const toks = out.split('\0')
  const files: { code: string; path: string }[] = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.length < 3) continue // skip the trailing empty token (and any stray short field)
    const code = t.slice(0, 2)
    const p = t.slice(3)
    if (code[0] === 'R' || code[0] === 'C') i++ // rename/copy: the next token is the source path — skip it
    files.push({ code, path: p })
  }
  return files
}

/** Parse `git diff --numstat -z HEAD` into added/deleted counts keyed by path. A rename emits an empty
 *  path field followed by two NUL fields (old, new); we key the counts on the new path. */
export function parseNumstatZ(out: string): Map<string, { added: number; deleted: number }> {
  const toks = out.split('\0')
  const counts = new Map<string, { added: number; deleted: number }>()
  let i = 0
  while (i < toks.length) {
    const t = toks[i]
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(t)
    if (!m) {
      i++
      continue
    }
    const added = m[1] === '-' ? 0 : parseInt(m[1], 10)
    const deleted = m[2] === '-' ? 0 : parseInt(m[2], 10)
    if (m[3] === '') {
      // rename/copy: toks[i+1] = old path, toks[i+2] = new path
      const newPath = toks[i + 2]
      if (newPath) counts.set(newPath, { added, deleted })
      i += 3
      continue
    }
    counts.set(m[3], { added, deleted })
    i++
  }
  return counts
}

/** Combine a `-z` status + numstat into the Review panel's file list. */
export function buildGitFiles(statusZ: string, numstatZ: string): GitStatusFile[] {
  const counts = parseNumstatZ(numstatZ)
  return parsePorcelainZ(statusZ).map(({ code, path }) => {
    const c = counts.get(path)
    return {
      path,
      status: code.trim() || '??',
      staged: code[0] !== ' ' && code[0] !== '?',
      added: c?.added,
      deleted: c?.deleted
    }
  })
}
