/**
 * Weak local models routinely emit edit/file tool arguments in the wrong SHAPE — even when the JSON
 * is valid: a different key for the path (`file`, `file_path`, `filename`), edit keys (`old`/`new`,
 * `search`/`replace`), a `multi_edit` whose `edits` array is missing or replaced by one inline edit,
 * or the whole payload nested under `arguments`. Strict zod then rejects it ("path: expected string,
 * received undefined") and the turn is wasted. These helpers coerce the common variants back to the
 * canonical shape BEFORE validation (wired via `z.preprocess` on each tool's schema), so a one-off
 * mis-shaped call just works. The model still sees the correct JSON schema (preprocess is invisible to
 * `toJSONSchema`), so this only RECOVERS mistakes — it never advertises the aliases.
 */

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

const PATH_KEYS = ['path', 'file', 'file_path', 'filePath', 'filepath', 'filename', 'fileName', 'target', 'dest', 'destination']
const CONTENT_KEYS = ['content', 'text', 'body', 'data', 'file_content', 'fileContent', 'contents', 'source']
const OLD_KEYS = ['old_string', 'old', 'oldString', 'old_str', 'oldText', 'old_text', 'search', 'find', 'from', 'original']
const NEW_KEYS = ['new_string', 'new', 'newString', 'new_str', 'newText', 'new_text', 'replace', 'replacement', 'to', 'updated']
const ALL_KEYS = ['replace_all', 'replaceAll', 'all', 'global']
const EDITS_KEYS = ['edits', 'changes', 'replacements', 'operations', 'edit']

function pick(o: Obj, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined) return o[k]
  return undefined
}

/** Some models wrap the real args under arguments/input/params. Unwrap one level if it looks right. */
function unwrap(raw: unknown): unknown {
  if (!isObj(raw)) return raw
  for (const k of ['arguments', 'input', 'params', 'args']) {
    const inner = raw[k]
    if (isObj(inner) && (pick(inner, PATH_KEYS) !== undefined || pick(inner, EDITS_KEYS) !== undefined || pick(inner, OLD_KEYS) !== undefined)) {
      return inner
    }
  }
  return raw
}

/** Fill `canonical` from the first present alias, only if the canonical key isn't already set. */
function fill(o: Obj, canonical: string, keys: string[]): Obj {
  if (o[canonical] !== undefined) return o
  const v = pick(o, keys)
  return v !== undefined ? { ...o, [canonical]: v } : o
}

function aliasEdit(e: unknown): unknown {
  if (!isObj(e)) return e
  return fill(fill(fill(e, 'old_string', OLD_KEYS), 'new_string', NEW_KEYS), 'replace_all', ALL_KEYS)
}

export function aliasPathArgs(raw: unknown): unknown {
  const r = unwrap(raw)
  return isObj(r) ? fill(r, 'path', PATH_KEYS) : raw
}

export function aliasWriteArgs(raw: unknown): unknown {
  const r = unwrap(raw)
  if (!isObj(r)) return raw
  return fill(fill(r, 'path', PATH_KEYS), 'content', CONTENT_KEYS)
}

export function aliasEditArgs(raw: unknown): unknown {
  const r = unwrap(raw)
  if (!isObj(r)) return raw
  return aliasEdit(fill(r, 'path', PATH_KEYS))
}

export function aliasMultiEditArgs(raw: unknown): unknown {
  const r = unwrap(raw)
  if (!isObj(r)) return raw
  const withPath = fill(r, 'path', PATH_KEYS)
  let edits = pick(withPath, EDITS_KEYS)
  if (Array.isArray(edits)) {
    edits = edits.map(aliasEdit)
  } else if (isObj(edits)) {
    edits = [aliasEdit(edits)] // a single edit passed as an object instead of an array
  } else if (pick(withPath, OLD_KEYS) !== undefined || pick(withPath, NEW_KEYS) !== undefined) {
    edits = [aliasEdit(withPath)] // multi_edit called with a single-edit shape (path + old/new at top level)
  }
  return { ...withPath, edits }
}
