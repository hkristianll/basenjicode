import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { settingsSchema, connectionSchema, mcpServerSchema, DEFAULT_SETTINGS, DEFAULT_BOARD_MCP, type Settings, type Connection, type MCPServerConfig } from '../../shared/domain-types'
import { encryptSecret, decryptSecret } from './secrets'
import { log } from '../logger'

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

/** Atomic JSON write (temp file + fsync + rename) so neither a crash nor power loss can leave a
 *  half-written or zero-length file: the fsync forces the bytes to disk BEFORE the atomic rename. */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

/**
 * Merge persisted JSON over the defaults and validate. Deep-merges the nested objects, not just the
 * top level: a settings.json written before a new sub-field existed (e.g. voice.wakeWord) would
 * otherwise replace the whole `voice`/`image` object and fail validation, silently resetting EVERY
 * setting to defaults. Filling missing sub-fields from the defaults keeps the user's other choices
 * intact across schema additions. Returns null when the result still fails validation.
 */
export function mergeWithDefaults(raw: Record<string, unknown>): Settings | null {
  const merged = {
    ...DEFAULT_SETTINGS,
    ...raw,
    image: { ...DEFAULT_SETTINGS.image, ...(raw.image as object | undefined) },
    voice: { ...DEFAULT_SETTINGS.voice, ...(raw.voice as object | undefined) }
  } as Settings

  // Multi-backend migration: a settings.json written before `connections` existed has none. Seed one
  // from the legacy flat baseURL/model so the user's existing LM Studio setup carries over as the
  // active connection. (Arrays are NOT deep-merged — the top-level spread already took raw.connections
  // when present; here we only backfill the absent case.)
  if (raw.connections === undefined) {
    merged.connections = [
      {
        id: 'local-lmstudio',
        label: 'LM Studio (local)',
        kind: 'lmstudio',
        baseURL: (typeof raw.baseURL === 'string' && raw.baseURL) || DEFAULT_SETTINGS.baseURL,
        apiKey: '',
        model: typeof raw.model === 'string' ? raw.model : '',
        temperature: null,
        maxTokens: null,
        contextLimitTokens: null
      }
    ]
    merged.activeConnectionId = 'local-lmstudio'
  }
  // Drop any individually-invalid connection (hand-edited/corrupted, or an old element missing a
  // future field) rather than letting one bad entry fail the whole-object parse and silently reset
  // EVERY setting to defaults. normalizeConnections then re-seeds defaults only if none survived.
  if (Array.isArray(merged.connections)) {
    merged.connections = merged.connections.filter((c) => connectionSchema.safeParse(c).success) as Connection[]
  }
  // Same per-entry filtering for MCP servers: drop a corrupted/hand-edited entry instead of failing the
  // whole-object parse (which would silently reset EVERY setting to defaults).
  if (Array.isArray(merged.mcpServers)) {
    merged.mcpServers = merged.mcpServers.filter((m) => mcpServerSchema.safeParse(m).success) as MCPServerConfig[]
  } else {
    merged.mcpServers = []
  }
  // Auto-add the built-in ticket board so NordCode connects with no setup. Keyed by id, so a board the
  // user DISABLED (enabled:false) is left as-is and not re-enabled — only a missing one is re-seeded.
  if (!merged.mcpServers.some((m) => m.id === DEFAULT_BOARD_MCP.id)) {
    merged.mcpServers = [{ ...DEFAULT_BOARD_MCP }, ...merged.mcpServers]
  }
  normalizeConnections(merged)

  const parsed = settingsSchema.safeParse(merged)
  return parsed.success ? parsed.data : null
}

/** Map every at-rest secret (connection + image API keys) through `fn`. Returns a new Settings; the input is
 *  not mutated. Used to encrypt on the way to disk and decrypt on the way back, so plaintext keys live only in
 *  memory. */
function mapSecrets(s: Settings, fn: (v: string) => string): Settings {
  return {
    ...s,
    connections: s.connections.map((c) => ({ ...c, apiKey: fn(c.apiKey) })),
    image: { ...s.image, apiKey: fn(s.image.apiKey) }
  }
}

/** Guarantee at least one connection and a valid active id (mutates in place). */
export function normalizeConnections(s: Settings): Settings {
  if (!Array.isArray(s.connections) || s.connections.length === 0) {
    s.connections = DEFAULT_SETTINGS.connections.map((c) => ({ ...c }) as Connection)
  }
  if (!s.connections.some((c) => c.id === s.activeConnectionId)) {
    s.activeConnectionId = s.connections[0].id
  }
  return s
}

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>
    const merged = mergeWithDefaults(raw)
    // Decrypt secrets after merge/validation so the rest of the app sees plaintext keys; an at-rest value is
    // `enc:v1:…` ciphertext, a legacy/unencryptable one is plaintext and passes through untouched.
    if (merged) {
      // One-shot legacy adoption: pre-public builds hardcoded this machine's ComfyUI launcher; the
      // path now lives in Settings (blank by default). Detect-and-adopt keeps that install working
      // while no personal path ever ACTS on anyone else's machine (existsSync-gated).
      const legacyComfy = 'D:\\Software\\ComfyUI\\run_nordcode_comfy.bat'
      if (process.platform === 'win32' && !merged.image.launcherPath && fs.existsSync(legacyComfy)) {
        merged.image.launcherPath = legacyComfy
      }
      return mapSecrets(merged, decryptSecret)
    }
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULT_SETTINGS }
}

export function saveSettings(settings: Settings): void {
  // Encrypt secrets immediately before they touch disk (idempotent — an already-encrypted value is left alone).
  writeJsonAtomic(settingsPath(), mapSecrets(settings, encryptSecret))
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const current = loadSettings()
  const merged = normalizeConnections({ ...current, ...patch })
  // Reject a patch that produces invalid settings (e.g. a malformed baseURL) rather than persisting it.
  const parsed = settingsSchema.safeParse(merged)
  if (!parsed.success) {
    // Log so a silently-ignored save is diagnosable (the UI pre-validates, but other callers may not).
    log('ERROR', `updateSettings: invalid patch rejected — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  }
  const next = parsed.success ? parsed.data : current
  saveSettings(next)
  return next
}
