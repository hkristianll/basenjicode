import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import type { MCPServerConfig, MCPServerStatus } from '../../../shared/domain-types'
import type { ToolPreview } from '../../../shared/ipc-types'
import type { ToolDef } from '../registry'
import { log } from '../../logger'
import { sanitizeLabel, sanitizeToolName, flattenToolResult, type McpCallResult } from './translate'

interface Live {
  config: MCPServerConfig
  client?: Client
  tools: ToolDef[]
  error?: string
  /** Consecutive failed (re)connect attempts — indexes into the backoff ladder. Reset on success/sync. */
  reconnectAttempts: number
  /** Pending auto-reconnect timer; presence means one is already scheduled (never double-schedule). */
  reconnectTimer?: unknown
}

/** MCP tool arguments are already shaped by the upstream server's own inputSchema, so our ToolDef just
 *  needs a permissive zod schema: the loop's safeParse then forwards the args untouched to callTool. */
const passthrough = z.record(z.string(), z.unknown())

type RawMcpTool = { name: string; description?: string; inputSchema?: unknown }

/** W1b backoff ladder: quick retries for a blip, then a steady 5-minute heartbeat for a server that is
 *  down for a while — it comes back automatically without a settings-save, and never storms. */
export function reconnectDelayMs(attempt: number): number {
  return [1_000, 5_000, 30_000][attempt] ?? 300_000
}

/** Transport-shaped failure on an MCP call/connection — the retryable class worth auto-reconnecting.
 *  (The SDK reports a closed transport as "Not connected"; the rest are socket/fetch shapes.) */
export function isMcpTransportError(e: unknown): boolean {
  const s = e instanceof Error ? `${e.name} ${e.message}` : String(e ?? '')
  return /not connected|connection (closed|reset|refused|error)|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|socket hang ?up|fetch failed|premature close|terminated|network error/i.test(s)
}

/** Injectable timer surface (DI like boardAutostart) so tests can drive the backoff without real time. */
export interface TimerImpl {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/**
 * Connects to the configured external MCP servers, discovers their tools, and exposes each as a native
 * NordCode ToolDef. One manager owns all server connections; ipc.ts re-syncs it whenever settings change
 * and disposes it on quit. A server that fails to connect is recorded (for the UI) but never throws —
 * NordCode stays fully usable with a down server.
 *
 * W1b: a transport that drops MID-SESSION (or a connect that fails) now auto-reconnects on a bounded
 * backoff (1s/5s/30s → every 5 min) instead of staying dead until the next settings save. A successful
 * auto-reconnect fires `onToolsChanged` so ipc.ts re-syncs the tool registry.
 */
export class MCPManager {
  private live = new Map<string, Live>()
  /** Fired after an auto-reconnect restores a server (its tool set may have changed) — ipc.ts points this
   *  at syncMcpTools so the registry picks the tools back up. Not fired for sync()-driven connects (the
   *  caller IS the registry refresh in that case). */
  onToolsChanged?: () => void

  constructor(private timers: TimerImpl = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }) {}

  /** Reconcile live connections with the desired config: connect new/changed enabled servers, drop the rest. */
  async sync(configs: MCPServerConfig[]): Promise<void> {
    const wanted = new Map(configs.filter((c) => c.enabled).map((c) => [c.id, c]))
    // Drop anything removed, disabled, whose config changed, OR that previously errored (so a down
    // server is retried on the next sync) — all of these reconnect fresh below.
    for (const [id, l] of [...this.live]) {
      const w = wanted.get(id)
      if (!w || l.error || JSON.stringify(w) !== JSON.stringify(l.config)) await this.disconnect(id)
    }
    for (const [id, cfg] of wanted) {
      if (!this.live.has(id)) await this.connect(cfg)
    }
  }

  private async connect(cfg: MCPServerConfig, opts: { attempts?: number; isReconnect?: boolean } = {}): Promise<void> {
    await this.disconnect(cfg.id) // never overwrite (and leak) an existing client for this id
    const attempts = opts.attempts ?? 0
    try {
      const client = new Client({ name: 'nordcode', version: '0.1.0' })
      await client.connect(this.makeTransport(cfg)) // performs the MCP initialize handshake
      const tools = await this.discover(cfg, client)
      this.live.set(cfg.id, { config: cfg, client, tools, reconnectAttempts: 0 })
      // A transport that dies later (server restarted, socket cut) schedules its own recovery.
      client.onclose = () => this.handleDrop(cfg.id, 'connection closed')
      client.onerror = (e) => this.handleDrop(cfg.id, e instanceof Error ? e.message : String(e))
      log('INFO', `MCP: connected '${cfg.label}' (${cfg.transport}) — ${tools.length} tool(s)${opts.isReconnect ? ' [auto-reconnect]' : ''}`)
      if (opts.isReconnect) this.onToolsChanged?.()
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      this.live.set(cfg.id, { config: cfg, tools: [], error, reconnectAttempts: attempts })
      log('ERROR', `MCP: '${cfg.label}' failed to connect — ${error}`)
      this.scheduleReconnect(cfg.id)
    }
  }

  /** A live server's transport dropped: mark it errored (Settings UI) and start the backoff. The tools stay
   *  registered — a call against them fails fast with a retryable error (see the callTool wrap) rather than
   *  vanishing mid-turn, and the reconnect brings them back for real. */
  private handleDrop(id: string, reason: string): void {
    const l = this.live.get(id)
    if (!l || l.error) return // already handling it (onclose and onerror often both fire)
    l.error = `connection dropped — ${reason}; reconnecting`
    l.reconnectAttempts = 0
    log('ERROR', `MCP: '${l.config.label}' transport dropped (${reason}) — auto-reconnecting`)
    this.scheduleReconnect(id)
  }

  private scheduleReconnect(id: string): void {
    const l = this.live.get(id)
    if (!l || l.reconnectTimer) return // one pending attempt per server, never a storm
    const delay = reconnectDelayMs(l.reconnectAttempts)
    l.reconnectTimer = this.timers.set(() => {
      const cur = this.live.get(id)
      if (!cur || cur !== l) return // sync()/dispose() replaced or removed this entry meanwhile
      cur.reconnectTimer = undefined
      void this.connect(cur.config, { attempts: cur.reconnectAttempts + 1, isReconnect: true })
    }, delay)
  }

  private makeTransport(cfg: MCPServerConfig): Transport {
    if (cfg.transport === 'stdio') {
      if (!cfg.command) throw new Error('stdio server needs a command')
      return new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) }
      })
    }
    if (!cfg.url) throw new Error('http server needs a url')
    const u = new URL(cfg.url) // throws on a malformed url
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('http server url must be http(s)')
    return new StreamableHTTPClientTransport(u)
  }

  private async discover(cfg: MCPServerConfig, client: Client): Promise<ToolDef[]> {
    const res = (await client.listTools()) as { tools: RawMcpTool[] }
    const prefix = sanitizeLabel(cfg.label)
    return res.tools.map((t) => this.wrap(cfg.id, prefix, client, t))
  }

  /** Translate one MCP tool into a NordCode ToolDef: its JSON-Schema is advertised verbatim, and the
   *  handler round-trips through callTool, flattening the content blocks to a string. */
  private wrap(serverId: string, prefix: string, client: Client, t: RawMcpTool): ToolDef {
    // Advertise the upstream JSON-Schema verbatim, minus $schema (NordCode's own tools strip it; an MCP
    // server may send a 2020-12 schema with one).
    const params: Record<string, unknown> = { ...((t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }) }
    delete params.$schema
    // The model-facing name must be contract-safe (the upstream t.name may have spaces/dots/etc.); the
    // handler still calls the server with the ORIGINAL t.name below.
    const exposed = `${prefix}__${sanitizeToolName(t.name)}`.slice(0, 64)
    const manager = this
    return {
      name: exposed,
      description: `[MCP:${prefix}] ${t.description ?? t.name}`,
      schema: passthrough,
      paramsJsonSchema: params,
      // External tools are untrusted, so they are flagged mutating → approval-gated in the ask and
      // acceptEdits modes (see ticket #6). NOTE: `auto` mode auto-approves every mutating tool, MCP
      // ones included, so this gate does NOT hold there — auto is a deliberate, documented full-auto
      // opt-in (SafetyController.authorize), and board/Hermes per-ticket workers always run auto.
      mutating: true,
      category: 'shell',
      preview(args): ToolPreview {
        const a = JSON.stringify(args ?? {})
        return { kind: 'command', text: `MCP ${prefix} · ${t.name} ${a.length > 300 ? a.slice(0, 300) + '…' : a}` }
      },
      async handler(args): Promise<string> {
        // Presence-check required args before hitting the server: the model-facing schema advertises a
        // `required` list, but our zod schema is permissive (passthrough), so a weak model can omit a
        // required property uncaught. Defensive — a non-array `required` means no requirements.
        const required = Array.isArray(params.required) ? (params.required as string[]) : []
        const provided = (args ?? {}) as Record<string, unknown>
        for (const key of required) {
          if (provided[key] === undefined || provided[key] === null) {
            return `ERROR: tool "${exposed}" called without required argument "${key}".`
          }
        }
        try {
          const res = (await client.callTool({
            name: t.name,
            arguments: provided
          })) as McpCallResult
          return flattenToolResult(res)
        } catch (e) {
          // W1b: a transport-shaped failure means the server dropped — kick the auto-reconnect and give
          // the model a clear, retryable verdict instead of an opaque throw (or a hang).
          if (isMcpTransportError(e)) {
            manager.handleDrop(serverId, e instanceof Error ? e.message : String(e))
            return `ERROR: MCP server '${prefix}' connection dropped — it is reconnecting; retry this call shortly.`
          }
          throw e
        }
      }
    }
  }

  private async disconnect(id: string): Promise<void> {
    const l = this.live.get(id)
    if (!l) return
    this.live.delete(id)
    if (l.reconnectTimer) this.timers.clear(l.reconnectTimer) // a removed server must not reconnect later
    try {
      if (l.client) {
        // Detach the drop handlers first: close() fires onclose, which would otherwise re-add the entry's
        // error state / schedule a reconnect for a server we are deliberately removing.
        l.client.onclose = undefined
        l.client.onerror = undefined
        await l.client.close()
      }
    } catch {
      /* a server already gone is fine */
    }
  }

  /** All tools discovered across every connected server. */
  tools(): ToolDef[] {
    return [...this.live.values()].flatMap((l) => l.tools)
  }

  /** Per-server connection status for the settings UI. */
  statuses(): MCPServerStatus[] {
    return [...this.live.values()].map((l) => ({
      id: l.config.id,
      label: l.config.label,
      status: l.error ? 'error' : 'connected',
      toolCount: l.tools.length,
      error: l.error
    }))
  }

  async dispose(): Promise<void> {
    for (const id of [...this.live.keys()]) await this.disconnect(id)
  }
}
