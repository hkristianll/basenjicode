import type { ZodError } from 'zod'

export const LIMITS = {
  /** Hard cap on any single tool result fed back to the model (~7-8k tokens). */
  MAX_TOOL_OUTPUT_CHARS: 30_000,
  /** Default number of lines returned by read_file when no range is given. */
  MAX_READ_LINES: 2_000,
  SHELL_TIMEOUT_MS: 120_000,
  MAX_FILE_WRITE_BYTES: 5_000_000,
  /** Refuse to slurp a whole file this large into memory (read_file without a line range). */
  MAX_READ_BYTES: 8_000_000,
  /** grep skips files larger than this (matches ripgrep ignoring huge/vendored blobs). */
  MAX_GREP_FILE_BYTES: 2_000_000,
  MAX_LIST_ENTRIES: 500,
  MAX_GREP_MATCHES: 200
}

/** Truncate keeping head + tail, so the model sees both the start and the end. */
export function truncateMiddle(text: string, max = LIMITS.MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = max - head
  const omitted = text.length - max
  return (
    text.slice(0, head) +
    `\n... [${omitted} characters omitted] ...\n` +
    text.slice(text.length - tail)
  )
}

/**
 * True when a tool call's arguments carry no real intent: absent, an empty object, or a "hollow"
 * object whose every value is null/undefined/'' (Qwen often emits `{"path":null,"old_string":null}`
 * under context pressure). Unparseable-but-non-empty args are left for schema validation to report.
 */
export function argsAreEmpty(argsJson: string): boolean {
  const s = (argsJson || '').trim()
  if (s === '' || s === '{}') return true
  try {
    const o = JSON.parse(s) as unknown
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return false
    const vals = Object.values(o as Record<string, unknown>)
    if (vals.length === 0) return true
    return vals.every((v) => v === null || v === undefined || v === '')
  } catch {
    return false
  }
}

/** The `path` argument of a tool call, if present and a string — used to key intent for loop-breaking. */
export function argPath(argsJson: string): string | null {
  try {
    const o = JSON.parse(argsJson) as { path?: unknown }
    return typeof o.path === 'string' ? o.path : null
  } catch {
    return null
  }
}

/** Close any unterminated string / unbalanced braces from a streamed-truncated JSON fragment. */
function closeUnbalanced(s: string): string {
  let inStr = false
  let esc = false
  const stack: string[] = []
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') stack.pop()
  }
  let out = s
  if (inStr) out += '"'
  while (stack.length) out += stack.pop()
  return out
}

/**
 * Escape raw control characters (newline, tab, etc.) that appear *inside* JSON string values. Weak local
 * models / llama.cpp backends emit them literally, which standard `JSON.parse` rejects — Hermes handles
 * this with `json.loads(strict=False)`; JS has no such flag, so we rewrite the bytes inside strings only.
 * Mirrors message_sanitization.py's control-char repair (the #1 local-model fix).
 */
function escapeControlCharsInJsonStrings(s: string): string {
  let out = ''
  let inStr = false
  let esc = false
  for (const ch of s) {
    if (inStr) {
      if (esc) {
        out += ch
        esc = false
        continue
      }
      if (ch === '\\') {
        out += ch
        esc = true
        continue
      }
      if (ch === '"') {
        out += ch
        inStr = false
        continue
      }
      const code = ch.charCodeAt(0)
      if (code < 0x20) {
        out += ch === '\n' ? '\\n' : ch === '\t' ? '\\t' : ch === '\r' ? '\\r' : '\\u' + code.toString(16).padStart(4, '0')
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') inStr = true
    out += ch
  }
  return out
}

/**
 * Drop trailing `}`/`]` that exceed their openers (bounded, like message_sanitization.py's 50-iteration
 * excess-closer trim). Best-effort sibling of {@link closeUnbalanced} — together they cover both
 * over- and under-closed fragments.
 */
function trimExcessClosers(s: string): string {
  let cur = s
  for (let i = 0; i < 50; i++) {
    try {
      JSON.parse(cur)
      return cur
    } catch {
      const opensCurly = (cur.match(/{/g) || []).length
      const closesCurly = (cur.match(/}/g) || []).length
      const opensSquare = (cur.match(/\[/g) || []).length
      const closesSquare = (cur.match(/]/g) || []).length
      if (cur.endsWith('}') && closesCurly > opensCurly) cur = cur.slice(0, -1)
      else if (cur.endsWith(']') && closesSquare > opensSquare) cur = cur.slice(0, -1)
      else break
    }
  }
  return cur
}

/**
 * Best-effort repair of malformed tool-call argument JSON from a weak local model. Ports the 4-pass
 * ladder from Hermes message_sanitization.py:185-279: control-char escape → trailing-comma strip →
 * brace/bracket balance → excess-closer trim. Returns the parsed object, or null if it still can't be
 * made into one — so the caller falls back to an error. (For a never-fails string, see {@link sanitizeToolArgs}.)
 */
export function repairJsonArgs(raw: string): Record<string, unknown> | null {
  const asObj = (c: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(c) as unknown
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  const s = (raw ?? '').trim()
  if (!s) return null
  const noTrailingCommas = s.replace(/,\s*([}\]])/g, '$1')
  const escaped = escapeControlCharsInJsonStrings(s)
  const escapedNoCommas = escapeControlCharsInJsonStrings(noTrailingCommas)
  return (
    asObj(s) ??
    asObj(noTrailingCommas) ??
    asObj(escaped) ??
    asObj(escapedNoCommas) ??
    asObj(closeUnbalanced(s)) ??
    asObj(closeUnbalanced(noTrailingCommas)) ??
    asObj(closeUnbalanced(escapedNoCommas)) ??
    asObj(trimExcessClosers(noTrailingCommas)) ??
    asObj(trimExcessClosers(escapedNoCommas))
  )
}

const NO_SCHEMA_REPAIR = Symbol('no-schema-repair')

function schemaValueAtPath(root: unknown, path: PropertyKey[]): unknown {
  let value = root
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined
    value = (value as Record<PropertyKey, unknown>)[key]
  }
  return value
}

function copyWithSchemaValue(root: unknown, path: PropertyKey[], value: unknown): unknown {
  if (path.length === 0) return value
  if (root === null || typeof root !== 'object') return root
  const [key, ...rest] = path
  const source = root as Record<PropertyKey, unknown>
  const copy = Array.isArray(root) ? [...root] : { ...source }
  Object.defineProperty(copy, key, {
    value: copyWithSchemaValue(source[key], rest, value),
    writable: true,
    enumerable: true,
    configurable: true
  })
  return copy
}

function repairStringForExpectedType(value: string, expected: string): unknown | typeof NO_SCHEMA_REPAIR {
  if (expected === 'number') {
    if (!value.trim()) return NO_SCHEMA_REPAIR
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : NO_SCHEMA_REPAIR
  }
  if (expected === 'boolean') {
    if (value === 'true' || value === 'True') return true
    if (value === 'false' || value === 'False') return false
    return NO_SCHEMA_REPAIR
  }
  if (expected !== 'array' && expected !== 'object') return NO_SCHEMA_REPAIR
  try {
    const parsed = JSON.parse(value) as unknown
    if (expected === 'array') return Array.isArray(parsed) ? parsed : NO_SCHEMA_REPAIR
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : NO_SCHEMA_REPAIR
  } catch {
    return NO_SCHEMA_REPAIR
  }
}

/**
 * Repair only string-valued paths that Zod identified as the wrong primitive/container type.
 * The input is never mutated, and valid string fields are invisible to this pass because they
 * produce no invalid_type issue. The caller owns the single validation retry.
 */
export function repairArgsToSchema(args: unknown, error: ZodError): unknown {
  let repaired = args
  for (const issue of error.issues) {
    if (issue.code !== 'invalid_type') continue
    const current = schemaValueAtPath(repaired, issue.path)
    if (typeof current !== 'string') continue
    const value = repairStringForExpectedType(current, issue.expected)
    if (value !== NO_SCHEMA_REPAIR) repaired = copyWithSchemaValue(repaired, issue.path, value)
  }
  return repaired
}

/**
 * Always-valid-JSON sanitiser for a tool call's `arguments` string, mirroring Hermes
 * `_repair_tool_call_arguments` (message_sanitization.py:185): returns wire-valid JSON, falling back to
 * `"{}"` so a malformed args string never poisons execution or the re-sent transcript. Empty / whitespace
 * / Python-`None` → `"{}"`. NOTE: callers must NOT run this on a length-truncated tool batch — closing a
 * truncated arg yields a plausible-but-wrong object (the loop refuses those upstream instead).
 */
export function sanitizeToolArgs(raw: string | null | undefined): string {
  const s = (raw ?? '').trim()
  if (!s || s === 'None' || s === 'null') return '{}'
  try {
    JSON.parse(s)
    return s
  } catch {
    const repaired = repairJsonArgs(s)
    return repaired ? JSON.stringify(repaired) : '{}'
  }
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** A tiny glob matcher for file names: supports `*` and `?`, anchored, case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  const stripped = glob.replace(/^\*\*\//, '')
  const esc = stripped
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${esc}$`, 'i')
}

/**
 * Glob matcher for whole POSIX paths, anchored and case-insensitive. Supports:
 *  - `**` — any number of path segments (e.g. `src/**\/*.ts`, or a leading `**\/*.test.ts`)
 *  - `*`  — any run of characters within a single segment (does not cross `/`)
 *  - `?`  — a single non-`/` character
 */
export function pathGlobToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, '/')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` collapses to "zero or more leading segments"; bare `**` is "anything".
        if (g[i + 2] === '/') {
          re += '(?:[^/]*/)*'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp(`^${re}$`, 'i')
}
