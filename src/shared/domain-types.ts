import { z } from 'zod'

/**
 * Domain types shared across main / preload / renderer.
 * Decoupled from the OpenAI SDK on purpose: the main process converts these to
 * the SDK's param shapes at the API boundary, so the renderer never imports `openai`.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** Approval behaviour, Claude-Code style. */
export type AgentMode = 'ask' | 'acceptEdits' | 'auto' | 'plan'

export const AGENT_MODES: AgentMode[] = ['ask', 'acceptEdits', 'auto', 'plan']

export type Theme = 'dark' | 'light'

/** Transcript density: 'compact' shows one-line tool summaries; 'verbose' expands full output. */
export type Verbosity = 'compact' | 'verbose'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/** A single item in the agent's working task list (set via the todo_write tool). */
export interface TodoItem {
  content: string
  status: TodoStatus
}

/** A tool call as emitted by the model (arguments kept as the raw JSON string). */
export interface ToolCall {
  id: string
  name: string
  arguments: string
}

/** What a tool call is about to do (or did) — rendered as the card body (diff view, command line, …).
 *  Lives here (not ipc-types) because tool RESULT messages persist it for reload fidelity (W5b);
 *  ipc-types re-exports it for the event/preload surface. */
export interface ToolPreview {
  kind: 'diff' | 'new-file' | 'command' | 'text'
  unified?: string
  text?: string
  path?: string
}

/** Canonical transcript message — the source of truth we persist and send to the model. */
export interface ChatMessage {
  role: Role
  content: string | null
  /** UI-only source text when `content` was expanded before being sent to the model (for example @file mentions). */
  displayContent?: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  /** Image data URLs attached to a user message — sent to a vision model as image parts. */
  images?: string[]
  /** The turn this user message started (set only on turn-START user messages, not steer/nudge injections).
   *  Links the transcript to the per-turn undo snapshots so conversation rewind knows which files to restore.
   *  Never sent to the model (toOpenAIMessages maps explicit fields only). Absent on pre-rewind sessions. */
  turnId?: string
  /** W5b reload fidelity: on TOOL messages, the preview the live card showed (diff/command), persisted so a
   *  reloaded session renders the same card. Never sent to the model. Tool messages also reuse `images`
   *  (capped at persist time) for the same reason. */
  preview?: ToolPreview
}

/** A prompt waiting for the current agent turn to finish. Queue entries are UI/session state only:
 * they are not added to the model transcript until they are actually sent. */
export interface QueuedPrompt {
  id: string
  text: string
  images?: string[]
  createdAt: number
}

/** Per-session composer state. Keeping this beside the session prevents drafts or queued work from
 * leaking across chats while remaining completely outside the model context. */
export interface ComposerSessionState {
  draft: string
  images: string[]
  queue: QueuedPrompt[]
  /** Queue entry currently being edited in the composer; prevents auto-drain from sending stale text. */
  editingQueueId?: string
}

/** Where the generate_image tool sends prompts. local-first by default (Automatic1111/Forge). */
export type ImageProvider = 'a1111' | 'comfyui' | 'openai' | 'gemini'

export interface ImageConfig {
  provider: ImageProvider
  /** Server root: A1111 e.g. http://127.0.0.1:7860, ComfyUI http://127.0.0.1:8188, OpenAI https://api.openai.com/v1 */
  baseURL: string
  /** Bearer key — only needed for cloud/OpenAI-compatible endpoints. */
  apiKey: string
  /** Checkpoint (A1111/ComfyUI) or model id (OpenAI e.g. gpt-image-1; Gemini e.g. imagen-3.0-generate-002 or
   *  gemini-2.5-flash-image). Blank = server default. */
  model: string
  /** Default output size "WxH" (e.g. 1024x1024). */
  size: string
  /** Sampling steps for local Stable Diffusion backends. */
  steps: number
  /** Local ComfyUI launcher script for on-demand auto-start. Blank = never auto-launch (a running
   *  or remote instance still works) — machine-specific, so there is NO baked-in default path. */
  launcherPath?: string
}

/**
 * An LLM backend the agent can talk to. Every kind speaks the OpenAI-compatible
 * `/v1/chat/completions` wire format (LM Studio, Ollama, OpenAI, OpenRouter, Groq, DeepSeek, and
 * Anthropic via its OpenAI-compat layer all do), so one client serves them all — `kind` only gates
 * backend-specific extras (the LM Studio `lms` context-pin + native model probe).
 */
export type ConnectionKind = 'lmstudio' | 'ollama' | 'openai' | 'anthropic' | 'openai-compat' | 'gemini'

export const CONNECTION_KINDS: ConnectionKind[] = ['lmstudio', 'ollama', 'openai', 'anthropic', 'openai-compat', 'gemini']

export interface Connection {
  /** Stable id (referenced by Settings.activeConnectionId and per-sub-agent routing). */
  id: string
  /** Human label shown in the picker. */
  label: string
  kind: ConnectionKind
  /** OpenAI-compatible server root, e.g. http://127.0.0.1:1234/v1, https://api.openai.com/v1. */
  baseURL: string
  /** Bearer key for cloud endpoints; blank for local servers (a placeholder is sent so the SDK is happy). */
  apiKey: string
  /** Model id sent on every request. Blank = the server's loaded/default model. */
  model: string
  /** Per-connection sampling overrides; null = inherit the global Settings value. */
  temperature: number | null
  maxTokens: number | null
  contextLimitTokens: number | null
  /** Emit tool calls as `<tool_call>{…}</tool_call>` text instead of native function-calls. Bypasses LM
   *  Studio's native tool-call-argument truncation on models weak at large native calls. Default off. */
  preferTextToolCalls?: boolean
  /** Reasoning/thinking control for chatty thinking models. 'off' suppresses chain-of-thought so it can't
   *  starve the tool call (Qwen `/no_think`); remote reasoning models map it to `reasoning_effort`. Unset =
   *  the model's default. */
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high'
}

/** How NordCode reaches an external MCP server. */
export type MCPTransport = 'stdio' | 'http'

/**
 * An external Model Context Protocol server whose tools NordCode exposes to the model.
 * `stdio` spawns a local process and speaks JSON-RPC over its stdin/stdout; `http` connects
 * to a Streamable-HTTP endpoint (local or remote). Tools are namespaced `label__toolName`.
 */
export interface MCPServerConfig {
  /** Stable id. */
  id: string
  /** Short label; also the tool-name prefix, so keep it identifier-ish (e.g. "board"). */
  label: string
  transport: MCPTransport
  /** Off = configured but not connected (no tools registered). */
  enabled: boolean
  /** stdio: executable to run (e.g. "npx"). */
  command?: string
  /** stdio: arguments. */
  args?: string[]
  /** stdio: extra environment for the child process. */
  env?: Record<string, string>
  /** http: the Streamable-HTTP endpoint, e.g. http://127.0.0.1:8930/mcp. */
  url?: string
}

/** The local ticket board, auto-added so NordCode connects to it with no setup (like the other
 *  conventional localhost services). Present in every config unless the user disables it. */
export const DEFAULT_BOARD_MCP: MCPServerConfig = {
  id: 'board-builtin',
  label: 'board',
  transport: 'http',
  enabled: true,
  url: 'http://127.0.0.1:8930/mcp'
}

/** Live connection state of an MCP server, surfaced in Settings. */
export interface MCPServerStatus {
  id: string
  label: string
  status: 'connected' | 'error'
  toolCount: number
  error?: string
}

/** Local voice sidecar (faster-whisper STT + Kokoro TTS) — JARVIS-style speech in/out. */
export interface VoiceConfig {
  /** Master switch. Off by default so no one gets a surprise mic prompt. */
  enabled: boolean
  /** The voice sidecar's HTTP root (mirrors the LM Studio / ComfyUI localhost pattern). */
  sidecarURL: string
  /** Kokoro voice id, e.g. bm_george (British male), am_michael, af_heart. */
  voice: string
  /** After a push-to-talk transcription, send it immediately instead of just filling the composer. */
  autoSend: boolean
  /** Speak the agent's replies aloud as they stream. */
  speakReplies: boolean
  /** Hands-free: the sidecar listens for "Hey Jarvis" and captures the command. Mic stays always-on. */
  wakeWord: boolean
}

export interface Settings {
  /** @deprecated legacy single-endpoint fields — kept for migration; the active Connection is the source of truth. */
  baseURL: string
  /** @deprecated see baseURL. */
  model: string
  /** Configured LLM backends. The agent uses `activeConnectionId`; sub-agents can route to any of these. */
  connections: Connection[]
  /** Which connection the main chat talks to. */
  activeConnectionId: string
  /** Global sampling defaults; a Connection's non-null override wins. */
  temperature: number
  maxTokens: number | null
  maxTurns: number
  /** Per-ticket tool-round budget for a Mission/board WORKER turn (the board clamps its sessions to this so
   *  cost stays bounded and tickets stay focused). Telemetry showed the old fixed 14 was starving real
   *  multi-file tickets — the same local model averages ~21 tool-rounds to finish one in chat, so 14 killed
   *  90% of board turns at the cap. Raise it (e.g. 40) for bigger tickets; the run's token/wall-clock caps
   *  still bound total cost. Unset = the board default (28). Effective budget is min(maxTurns, this). */
  loopMaxTurnsPerTicket?: number
  contextLimitTokens: number
  /** Default approval mode applied to new sessions. */
  mode: AgentMode
  theme: Theme
  /** Transcript density (compact tool summaries vs full output). */
  verbosity: Verbosity
  /** Show the basenji nook above the composer. Default on; false hides the mascot and frees the composer space. */
  mascotEnabled?: boolean
  /** W3a: screen dangerous shell commands in AUTO mode (outside-workspace writes, download-execute, system
   *  mutation, credential paths). Default 'screen' (undefined = screen); 'off' restores verbatim full-auto. */
  shellScreening?: 'off' | 'screen'
  /** W4a self-update: folder holding a freshly packaged build (…\dist\win-unpacked). The Update section
   *  compares its app.asar against the installed one and offers "Install pending build and restart".
   *  Defaults to this machine's NordCode repo output — NordCode is a personal app; adjust if the repo moves. */
  updateSourceDir?: string
  /** Tier-1 memory: auto-capture durable facts at compaction + a lesson on a capability failure. Default on
   *  (undefined is treated as on); set false to disable all automatic memory writes. */
  autoMemory?: boolean
  /** Image-generation backend for the generate_image tool. */
  image: ImageConfig
  /** Voice (speech-to-text + text-to-speech) via the local sidecar. */
  voice: VoiceConfig
  /** External MCP servers whose tools are exposed to the model. */
  mcpServers: MCPServerConfig[]
  lastCwd: string | null
  lastSessionId: string | null
  /** Loop drain defaults: worker + reviewer each a connection ("where") + a specific model ("what"), and the
   *  VRAM swap toggle. The model fields override the connection's default model so two models can share a backend. */
  loopWorkerConnectionId?: string
  loopWorkerModel?: string
  loopReviewerConnectionId?: string
  loopReviewerModel?: string
  loopSwapModels?: boolean
  /** Hermes "planner" connection + model (Q1): the (optionally stronger) model that runs decompose / replan /
   *  critic — the highest-leverage reasoning steps. Empty → planning runs on the worker connection. */
  hermesPlannerConnectionId?: string
  hermesPlannerModel?: string
  /** Hermes "designer" connection + model: the model that runs DESIGN-role tickets (UI/visual/art work), split out
   *  so a coder model can do implementation while a separate model owns the look. Empty → design runs on the worker
   *  (coder) connection, preserving prior behaviour. */
  hermesDesignerConnectionId?: string
  hermesDesignerModel?: string
  /** Max impl/coder tickets to drain CONCURRENTLY (each in its own git worktree, merged back). 1 = the sequential
   *  drain (default; unchanged behaviour). >1 opts into parallel coding — only INDEPENDENT ready tickets run together;
   *  design/review/integration stay sequential. Best on a model that batches well (an MoE A3B). */
  loopParallelism?: number
  /** Keep the DRAIN models (coder + reviewer + designer) resident in VRAM TOGETHER, so the code↔review cycle never
   *  swaps. Only enable when they genuinely fit together on the GPU (the big planner is still freed during the drain).
   *  Default off (swap as before). When on, eliminates the code↔review reload/co-residence dance entirely. */
  keepReviewerResident?: boolean
  /** Manager-owned (lazy) orchestration: when on, runHermes uses the spec-first, split-on-failure path
   *  (SPEC-manager-owned-orchestration.md) instead of eager decomposition. Default off (eager). Built behind this
   *  flag so the new path matures without regressing the existing one. */
  hermesLazyOrchestration?: boolean
  /** Hermes "projects root": the base folder under which each project gets its own work folder
   *  (<root>/<project>), created automatically. Empty → Hermes falls back to a manually-picked folder. */
  hermesProjectsRoot?: string
  /** Path to the standalone ticket-board project (`node src/server.js` at :8930). When set, NordCode spawns
   *  the board on launch if it isn't already running — the board powers the Hermes / Raid / board views. */
  ticketBoardPath?: string
  /** Per-raid working-folder overrides, keyed by the (canonical) board project name → absolute folder. Lets the
   *  rail group raids by the real project repo they operate in (many raids → one repo), instead of every raid
   *  getting its own `<projectsRoot>/<name>` folder. Unmapped raids fall back to that derived folder. */
  raidFolders?: Record<string, string>
}

export interface SessionMeta {
  id: string
  title: string
  cwd: string
  createdAt: number
  updatedAt: number
}

export interface AllowList {
  tools: string[]
  exact: string[]
  shellPrefixes: string[]
}

export interface Session extends SessionMeta {
  mode: AgentMode
  messages: ChatMessage[]
  /** Draft + queued prompts are persisted, but never sent to the model until promoted to a user turn. */
  composer?: ComposerSessionState
  /** Per-session "always allow" decisions, so approvals survive a restart. */
  allowList?: AllowList
  /** Learned chars/4 → real-token scale, persisted so context trimming stays calibrated across restarts. */
  tokenScale?: number
}

// ---- zod schemas (main-process validation of persisted JSON) ----

export const toolCallSchema: z.ZodType<ToolCall> = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string()
})

export const chatMessageSchema: z.ZodType<ChatMessage> = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().nullable(),
  displayContent: z.string().optional(),
  toolCalls: z.array(toolCallSchema).optional(),
  toolCallId: z.string().optional(),
  images: z.array(z.string()).optional()
})

export const queuedPromptSchema: z.ZodType<QueuedPrompt> = z.object({
  id: z.string(),
  text: z.string(),
  images: z.array(z.string()).optional(),
  createdAt: z.number()
})

export const composerSessionStateSchema: z.ZodType<ComposerSessionState> = z.object({
  draft: z.string(),
  images: z.array(z.string()),
  queue: z.array(queuedPromptSchema),
  editingQueueId: z.string().optional()
})

export const agentModeSchema = z.enum(['ask', 'acceptEdits', 'auto', 'plan'])

const httpUrl = (label: string) =>
  z.string().refine((s) => {
    try {
      const u = new URL(s)
      return u.protocol === 'http:' || u.protocol === 'https:'
    } catch {
      return false
    }
  }, `${label} must be a valid http(s) URL`)

export const connectionSchema: z.ZodType<Connection> = z.object({
  id: z.string().min(1),
  label: z.string(),
  kind: z.enum(['lmstudio', 'ollama', 'openai', 'anthropic', 'openai-compat', 'gemini']),
  baseURL: httpUrl('Connection baseURL'),
  apiKey: z.string(),
  model: z.string(),
  temperature: z.number().nullable(),
  maxTokens: z.number().nullable(),
  contextLimitTokens: z.number().nullable(),
  preferTextToolCalls: z.boolean().optional(),
  reasoningEffort: z.enum(['off', 'low', 'medium', 'high']).optional()
})

export const mcpServerSchema: z.ZodType<MCPServerConfig> = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  transport: z.enum(['stdio', 'http']),
  enabled: z.boolean(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional()
})

export const settingsSchema: z.ZodType<Settings> = z.object({
  baseURL: httpUrl('baseURL'),
  model: z.string(),
  connections: z.array(connectionSchema),
  activeConnectionId: z.string(),
  temperature: z.number(),
  maxTokens: z.number().nullable(),
  maxTurns: z.number(),
  loopMaxTurnsPerTicket: z.number().optional(),
  contextLimitTokens: z.number(),
  mode: agentModeSchema,
  theme: z.enum(['dark', 'light']),
  verbosity: z.enum(['compact', 'verbose']),
  mascotEnabled: z.boolean().optional(),
  shellScreening: z.enum(['off', 'screen']).optional(),
  updateSourceDir: z.string().optional(),
  autoMemory: z.boolean().optional(),
  image: z.object({
    provider: z.enum(['a1111', 'comfyui', 'openai', 'gemini']),
    baseURL: z.string(),
    apiKey: z.string(),
    model: z.string(),
    size: z.string(),
    steps: z.number(),
    launcherPath: z.string().optional()
  }),
  voice: z.object({
    enabled: z.boolean(),
    sidecarURL: z.string(),
    voice: z.string(),
    autoSend: z.boolean(),
    speakReplies: z.boolean(),
    wakeWord: z.boolean()
  }),
  mcpServers: z.array(mcpServerSchema),
  lastCwd: z.string().nullable(),
  lastSessionId: z.string().nullable(),
  loopWorkerConnectionId: z.string().optional(),
  loopWorkerModel: z.string().optional(),
  loopReviewerConnectionId: z.string().optional(),
  loopReviewerModel: z.string().optional(),
  loopSwapModels: z.boolean().optional(),
  hermesPlannerConnectionId: z.string().optional(),
  hermesPlannerModel: z.string().optional(),
  hermesDesignerConnectionId: z.string().optional(),
  hermesDesignerModel: z.string().optional(),
  loopParallelism: z.number().int().min(1).max(8).optional(),
  keepReviewerResident: z.boolean().optional(),
  hermesLazyOrchestration: z.boolean().optional(),
  hermesProjectsRoot: z.string().optional(),
  ticketBoardPath: z.string().optional(),
  raidFolders: z.record(z.string(), z.string()).optional()
})

export const sessionSchema: z.ZodType<Session> = z.object({
  id: z.string(),
  title: z.string(),
  cwd: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  mode: agentModeSchema,
  messages: z.array(chatMessageSchema),
  composer: composerSessionStateSchema.optional(),
  allowList: z
    .object({
      tools: z.array(z.string()),
      exact: z.array(z.string()),
      shellPrefixes: z.array(z.string())
    })
    .optional(),
  tokenScale: z.number().optional()
})

/** Default backend URL by kind — used to seed a freshly-added connection in the UI. */
export const DEFAULT_BASE_URL: Record<ConnectionKind, string> = {
  lmstudio: 'http://127.0.0.1:1234/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  'openai-compat': 'http://127.0.0.1:1234/v1',
  // Gemini's OpenAI-compatible chat endpoint — createConnectionClient (a generic OpenAI-compat client) speaks it
  // directly with the Gemini API key as the bearer token. Image gen uses the NATIVE API (see image/generate.ts).
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai'
}

/** The connection the agent currently talks to (falls back to the first, then a synthesized legacy one). */
export function activeConnection(s: Settings): Connection {
  const byId = s.connections.find((c) => c.id === s.activeConnectionId)
  if (byId) return byId
  if (s.connections[0]) return s.connections[0]
  return {
    id: 'local-lmstudio',
    label: 'LM Studio (local)',
    kind: 'lmstudio',
    baseURL: s.baseURL || DEFAULT_BASE_URL.lmstudio,
    apiKey: '',
    model: s.model,
    temperature: null,
    maxTokens: null,
    contextLimitTokens: null
  }
}

export const DEFAULT_SETTINGS: Settings = {
  baseURL: 'http://127.0.0.1:1234/v1',
  model: '',
  connections: [
    {
      id: 'local-lmstudio',
      label: 'LM Studio (local)',
      kind: 'lmstudio',
      baseURL: 'http://127.0.0.1:1234/v1',
      apiKey: '',
      model: '',
      temperature: null,
      maxTokens: null,
      contextLimitTokens: null
    }
  ],
  activeConnectionId: 'local-lmstudio',
  temperature: 0.15,
  // A finite default so the finish_reason='length' refuse-and-continue path in the loop actually
  // engages (an uncapped model can emit a length-truncated tool-call batch and corrupt an edit).
  // null stays a valid explicit opt-out ("uncapped") for users who set it deliberately.
  maxTokens: 4096,
  maxTurns: 50,
  loopMaxTurnsPerTicket: 28,
  contextLimitTokens: 32768,
  mode: 'ask',
  theme: 'dark',
  verbosity: 'compact',
  mascotEnabled: true,
  shellScreening: 'screen',
  // Blank = self-update disabled until the user points it at a build output dir (Settings → Update).
  // Machine-specific, so no baked-in default; existing installs keep their stored value.
  updateSourceDir: '',
  autoMemory: true,
  image: {
    provider: 'comfyui',
    baseURL: 'http://127.0.0.1:8188',
    apiKey: '',
    model: '',
    size: '',
    steps: 0,
    // No baked-in launcher path (machine-specific). The main process adopts a detected legacy
    // install once at load (store/settings.ts) so this machine keeps working; strangers configure
    // their own in Settings or simply run ComfyUI themselves.
    launcherPath: ''
  },
  voice: {
    enabled: false,
    sidecarURL: 'http://127.0.0.1:8123',
    voice: 'bm_george',
    autoSend: true,
    speakReplies: true,
    wakeWord: false
  },
  mcpServers: [{ ...DEFAULT_BOARD_MCP }],
  lastCwd: null,
  lastSessionId: null,
  raidFolders: {}
}
