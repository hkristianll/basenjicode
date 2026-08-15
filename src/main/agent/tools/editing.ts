/** Shared string-edit logic for edit_file and multi_edit (pure, unit-tested). */

export interface EditOp {
  old_string: string
  new_string: string
  /** Replace every occurrence instead of requiring a unique match. */
  replace_all?: boolean
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

/** Apply one edit to `content`. Returns the new content, or an error message describing why it didn't apply. */
export function applyEdit(content: string, e: EditOp): { updated: string } | { error: string } {
  if (e.old_string === '') return { error: 'old_string is empty.' }
  if (e.old_string === e.new_string) return { error: 'old_string and new_string are identical (no-op).' }
  const n = countOccurrences(content, e.old_string)
  if (n === 0) return { error: 'old_string not found — copy the exact text including whitespace.' }
  if (n > 1 && !e.replace_all) {
    return { error: `old_string matched ${n} times; add surrounding context to make it unique, or set replace_all:true.` }
  }
  return { updated: content.split(e.old_string).join(e.new_string) }
}

/** Apply a sequence of edits. Stops at the first failure and reports which one (1-based). */
export function applyEdits(content: string, edits: EditOp[]): { updated: string; applied: number } | { error: string } {
  let cur = content
  for (let i = 0; i < edits.length; i++) {
    const res = applyEdit(cur, edits[i])
    if ('error' in res) return { error: `edit ${i + 1}/${edits.length}: ${res.error}` }
    cur = res.updated
  }
  return { updated: cur, applied: edits.length }
}
