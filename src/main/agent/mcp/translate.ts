// Pure MCP <-> NordCode translation helpers. No electron / SDK imports on purpose, so they are
// straightforwardly unit-testable (see translate.test.ts).

/** A tool name prefixes every tool from a server (`board__add_ticket`), so it must be identifier-ish. */
export function sanitizeLabel(label: string): string {
  return (
    label
      .trim()
      .replace(/[^a-zA-Z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'mcp'
  )
}

/** Model-facing function names must match ^[a-zA-Z0-9_-]{1,64}$ (OpenAI/Anthropic-compat contract).
 *  Upstream MCP servers are free to expose tool names with spaces/dots/slashes/unicode, so the part we
 *  ADVERTISE must be sanitized — the original name is still used verbatim for the callTool round-trip. */
export function sanitizeToolName(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^[_-]+|[_-]+$/g, '') || 'tool'
  )
}

const MAX_TOOL_NAME = 64

/** Namespaced, contract-safe tool name exposed to the model (`label__tool`, clamped to 64 chars). */
export function toolName(label: string, name: string): string {
  return `${sanitizeLabel(label)}__${sanitizeToolName(name)}`.slice(0, MAX_TOOL_NAME)
}

export interface McpContentBlock {
  type?: string
  text?: string
}
export interface McpCallResult {
  content?: McpContentBlock[]
  isError?: boolean
}

/** Flatten an MCP tool result's content blocks into the single string a NordCode ToolDef handler returns.
 *  Non-text blocks are noted by kind; an error result is prefixed so the loop treats it as a tool error. */
export function flattenToolResult(res: McpCallResult): string {
  const text = (res.content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`)).join('\n')
  return res.isError ? `ERROR: ${text || 'tool reported an error'}` : text || '(no output)'
}
