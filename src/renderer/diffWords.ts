import { diffWordsWithSpace } from 'diff'

/** A run of text within a changed line, flagged as changed (highlight) or unchanged (base tint). */
export type Seg = { text: string; changed: boolean }

export type DiffRow = {
  cls: 'meta' | 'hunk' | 'add' | 'del' | 'ctx'
  gutter: string
  sign: string
  content: string
}

/** Parse a unified diff into rows with a line-number gutter (old numbers for deletions, new for additions)
 *  and the +/-/space sign split out from the content, so the content can be word-diffed cleanly. */
export function parseDiffRows(unified: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  for (const l of unified.split('\n')) {
    if (
      l.startsWith('+++') ||
      l.startsWith('---') ||
      l.startsWith('Index:') ||
      l.startsWith('diff ') ||
      l.startsWith('index ') ||
      l.startsWith('====')
    ) {
      rows.push({ cls: 'meta', gutter: '', sign: '', content: l })
    } else if (l.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
      if (m) {
        oldLine = parseInt(m[1], 10)
        newLine = parseInt(m[2], 10)
      }
      rows.push({ cls: 'hunk', gutter: '', sign: '', content: l })
    } else if (l.startsWith('+')) {
      rows.push({ cls: 'add', gutter: String(newLine++), sign: '+', content: l.slice(1) })
    } else if (l.startsWith('-')) {
      rows.push({ cls: 'del', gutter: String(oldLine++), sign: '-', content: l.slice(1) })
    } else {
      rows.push({ cls: 'ctx', gutter: String(newLine), sign: ' ', content: l.startsWith(' ') ? l.slice(1) : l })
      oldLine++
      newLine++
    }
  }
  return rows
}

/** Word-level diff of two lines: each side split into changed / unchanged segments so a one-character edit
 *  highlights only the span that actually changed instead of painting the whole line. */
export function wordDiff(oldStr: string, newStr: string): { del: Seg[]; add: Seg[] } {
  const parts = diffWordsWithSpace(oldStr, newStr)
  const del: Seg[] = []
  const add: Seg[] = []
  for (const p of parts) {
    if (p.added) add.push({ text: p.value, changed: true })
    else if (p.removed) del.push({ text: p.value, changed: true })
    else {
      del.push({ text: p.value, changed: false })
      add.push({ text: p.value, changed: false })
    }
  }
  return { del, add }
}

/** For each maximal "deleted run immediately followed by an added run" (i.e. a modification), word-diff the
 *  paired old/new lines and return per-row-index segment lists. Pure additions/deletions are left untouched. */
export function pairWordDiffs(rows: DiffRow[]): Map<number, Seg[]> {
  const map = new Map<number, Seg[]>()
  let i = 0
  while (i < rows.length) {
    if (rows[i].cls === 'del') {
      let j = i
      while (j < rows.length && rows[j].cls === 'del') j++
      let k = j
      while (k < rows.length && rows[k].cls === 'add') k++
      const pairs = Math.min(j - i, k - j)
      for (let p = 0; p < pairs; p++) {
        const { del, add } = wordDiff(rows[i + p].content, rows[j + p].content)
        map.set(i + p, del)
        map.set(j + p, add)
      }
      i = k
    } else {
      i++
    }
  }
  return map
}
