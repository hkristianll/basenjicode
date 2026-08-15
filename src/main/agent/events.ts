import type { AgentEvent } from '../../shared/ipc-types'

/**
 * Sink the agent loop writes streaming events to. The IPC layer adapts this to
 * `webContents.send`, keeping the loop itself transport-agnostic.
 */
export type Emit = (event: AgentEvent) => void
