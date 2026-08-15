// Type declaration for the verbatim-copied MCP face (mcp.js). Returns the SDK's McpServer; we only need
// `.connect(transport)` here, so it's typed minimally to avoid coupling to the SDK's internal types.
import type { BoardStore } from './db'

export interface BoardMcpServer {
  connect(transport: unknown): Promise<void>
}

export function buildMcpServer(store: BoardStore): BoardMcpServer
