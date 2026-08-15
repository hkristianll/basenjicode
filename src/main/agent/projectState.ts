// projectState — a structured, authoritative snapshot of the run that NordCode maintains itself and
// regenerates into the system prompt EVERY turn. Because it's derived from live state (not stored as chat
// messages), trimHistory/compact can shred the conversation and this survives intact. It's the cure for the
// "compaction → model forgets what it built → declares done / starts over / deletes everything" failure: the
// model always sees its goal, the files that already exist, the open todos, and live run handles — as data,
// not as a weak model's lossy prose summary. Pure + testable.

export interface ProjectFile {
  path: string
  action: 'created' | 'edited' | 'moved'
}

export interface BackgroundHandle {
  id: string
  command: string
  url?: string
}

export function renderProjectState(opts: {
  goal?: string
  files?: ProjectFile[]
  todos?: { content: string; status: string }[]
  background?: BackgroundHandle[]
  previewUrl?: string
}): string {
  const parts: string[] = []

  const goal = opts.goal?.trim()
  if (goal) parts.push(`Goal: ${goal.length > 400 ? goal.slice(0, 400) + '…' : goal}`)

  const files = opts.files ?? []
  if (files.length) {
    // Cap the list so a huge project can't bloat the prompt; keep the most recent (last-touched matters most).
    const shown = files.slice(-50)
    const omitted = files.length - shown.length
    const lines = shown.map((f) => `  ${f.path}${f.action !== 'edited' ? ` (${f.action})` : ''}`).join('\n')
    parts.push(
      'Files you have already created/edited this session — they EXIST on disk. Do NOT recreate them from ' +
        'scratch, restart the project, or delete them to "start over":\n' +
        lines +
        (omitted > 0 ? `\n  …and ${omitted} more` : '')
    )
  }

  const open = (opts.todos ?? []).filter((t) => t.status !== 'completed')
  if (open.length) {
    const mark: Record<string, string> = { pending: '[ ]', in_progress: '[~]' }
    parts.push(`Open todos (the task is NOT done while any remain):\n${open.map((t) => `  ${mark[t.status] ?? '[ ]'} ${t.content}`).join('\n')}`)
  }

  const background = opts.background ?? []
  if (background.length) {
    parts.push(
      `Background:\n${background
        .map((task) => `  ${task.id} \`${task.command}\`${task.url ? ` → ${task.url}` : ''}`)
        .join('\n')}`
    )
  }

  const previewUrl = opts.previewUrl?.trim()
  if (previewUrl) parts.push(`Preview: ${previewUrl}`)

  if (!parts.length) return ''
  return `--- Project state (authoritative — maintained by the app, persists across compaction) ---\n${parts.join('\n\n')}\n--- end project state ---`
}
