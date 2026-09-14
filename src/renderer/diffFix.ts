const SELECTED_DIFF_CAP = 12_000

/** Build the deliberately narrow review action: enough context to fix the selection, no workbench protocol. */
export function buildFixOnlyThisPrompt(path: string, selectedDiff: string): string {
  const selection = selectedDiff.trim().slice(0, SELECTED_DIFF_CAP)
  return [
    `Fix only the selected diff in ${path}.`,
    'Keep the edit narrowly scoped to these lines. Do not revert, rewrite, format, or otherwise change unrelated work. Read the current file for context if needed, then run the checks relevant to this fix.',
    '',
    '--- Selected diff ---',
    selection,
    '--- End selected diff ---'
  ].join('\n')
}
