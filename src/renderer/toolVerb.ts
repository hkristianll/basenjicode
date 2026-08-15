/** Map an internal tool id + its args to a human past-tense verb + a short target, so activity reads as
 *  narrative ("Edited Composer.tsx", "Ran npm test") rather than a machine log of raw tool ids.
 *  Shared by the Loop activity timeline and (Tier 1 #4) the chat transcript. */
const VERB: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Wrote',
  edit_file: 'Edited',
  multi_edit: 'Edited',
  apply_patch: 'Patched',
  run_shell: 'Ran',
  run_background: 'Ran',
  grep: 'Searched',
  glob: 'Found',
  list_dir: 'Listed',
  web_fetch: 'Fetched',
  web_search: 'Searched web',
  generate_image: 'Generated image',
  generate_video: 'Generated video',
  task: 'Delegated',
  todo_write: 'Updated plan'
}

export function verbOf(name: string): string {
  return VERB[name] ?? name.replace(/_/g, ' ')
}

/** Best-effort single most-meaningful argument (a path / command / pattern / url) from a tool's args blob. */
export function argTarget(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const a = args as Record<string, unknown>
  const v =
    a.path ?? a.file ?? a.file_path ?? a.filename ?? a.command ?? a.cmd ?? a.pattern ?? a.query ?? a.url ?? a.prompt
  return typeof v === 'string' ? v : ''
}

/** Shorten a target for display: basename for path-like strings, else a soft length cap. */
export function shortArg(s: string, max = 52): string {
  const t = s.trim()
  if (/[\\/]/.test(t) && !t.includes(' ')) {
    const parts = t.split(/[\\/]/).filter(Boolean)
    return parts[parts.length - 1] ?? t
  }
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}
