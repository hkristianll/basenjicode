// Static "unwired module" detector. Given a project's source files, find modules that are DEFINED but never
// reachable (via local imports) from any entry point. A built-but-orphaned module renders/does nothing — the #1
// cause of a "done" board that produces a broken app (e.g. a MapRenderer fully built + unit-tested, but the scene
// never imports it). Pure + headless (no runtime, no browser), so it unit-tests offline. The critic uses it to
// refuse to finish while a module is unwired.

export interface SourceFile {
  /** Project-relative path, forward slashes. */
  path: string
  content: string
}

const CODE_EXT = /\.(?:[jt]sx?|mjs|cjs)$/i
const ENTRY_RE = /(?:^|\/)(?:main|index|app|game)\.[jt]sx?$/i // conventional app entry points
const TEST_RE = /(?:\.(?:test|spec)\.[jt]sx?$)|(?:(?:^|\/)__tests__\/)/i
const CONFIG_RE = /(?:\.config\.[jt]s$)|(?:(?:^|\/)(?:vite|vitest|webpack|rollup|jest|tailwind|postcss|babel|eslint)[.\w-]*\.[jt]s$)|(?:\.d\.ts$)/i

const isCode = (p: string): boolean => CODE_EXT.test(p)
const isTest = (p: string): boolean => TEST_RE.test(p)
const isConfig = (p: string): boolean => CONFIG_RE.test(p)
const isEntry = (p: string): boolean => ENTRY_RE.test(p) && !isTest(p)

/** Import / re-export / dynamic-import / require specifiers in a file (handles `import x from`, `import './x'`,
 *  `export … from`, `import('./x')`, `require('./x')`). */
export function importSpecifiers(content: string): string[] {
  const out: string[] = []
  const re = /(?:import\b[^'"]*?\bfrom\s*|export\b[^'"]*?\bfrom\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content))) out.push(m[1])
  return out
}

/** Resolve a relative `./` `../` join into a normalized project path. */
function joinRel(fromDir: string, spec: string): string {
  const stack: string[] = []
  for (const part of (fromDir ? fromDir.split('/') : []).concat(spec.split('/'))) {
    if (part === '' || part === '.') continue
    else if (part === '..') stack.pop()
    else stack.push(part)
  }
  return stack.join('/')
}

/** Resolve a relative import specifier to a file path in the project (tries extensions + index barrels). */
function resolveLocal(fromPath: string, spec: string, paths: Set<string>): string | null {
  if (!spec.startsWith('.')) return null // bare / aliased import → not a local module
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : ''
  const base = joinRel(dir, spec)
  for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx']) {
    if (paths.has(base + ext)) return base + ext
  }
  return null
}

/**
 * Modules DEFINED but unreachable from any entry point (built-but-orphaned). Reachability follows local imports
 * from the entries; a file reachable ONLY from a test is still an orphan (imported by its test, never by the app —
 * exactly the "MapRenderer never wired into the scene" failure). Test / config / `.d.ts` files are never reported
 * as orphans themselves. Returns [] when no entry is detectable (can't judge) — conservative by design.
 */
export function findUnwiredModules(files: SourceFile[]): string[] {
  const code = files.filter((f) => isCode(f.path))
  const paths = new Set(code.map((f) => f.path))
  const byPath = new Map(code.map((f) => [f.path, f] as const))
  const entries = code.map((f) => f.path).filter(isEntry)
  if (!entries.length) return []

  const reachable = new Set<string>()
  const stack = [...entries]
  while (stack.length) {
    const p = stack.pop()!
    if (reachable.has(p)) continue
    reachable.add(p)
    const f = byPath.get(p)
    if (!f) continue
    for (const spec of importSpecifiers(f.content)) {
      const r = resolveLocal(p, spec, paths)
      if (r && !reachable.has(r)) stack.push(r)
    }
  }

  return code
    .map((f) => f.path)
    .filter((p) => !reachable.has(p) && !isTest(p) && !isConfig(p) && !isEntry(p))
    .sort()
}
