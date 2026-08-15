/**
 * Status prefixes the agent loop stamps on a tool result to mark it failed / denied / cancelled.
 * Shared so the main process (the loop's stuck-guard) and the renderer (the store's success styling)
 * classify a result identically — renaming or adding a prefix here updates both at once instead of
 * silently desyncing the two string-literal copies that used to live in loop.ts and store.ts.
 */
export const TOOL_ERROR_PREFIXES = ['ERROR: ', 'DENIED: ', 'CANCELLED: '] as const

/** True when a tool result string is one of our failure sentinels. */
export function isToolError(result: string): boolean {
  return TOOL_ERROR_PREFIXES.some((p) => result.startsWith(p))
}
