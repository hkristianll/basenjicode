import { describe, it, expect } from 'vitest'
import { mergeWithDefaults, normalizeConnections } from './settings'
import { DEFAULT_SETTINGS, activeConnection, type Settings } from '../../shared/domain-types'

describe('mergeWithDefaults — settings migration', () => {
  it('preserves a user’s nested choices when a new sub-field is added', () => {
    // A settings.json written before voice.wakeWord existed: the voice object lacks it.
    const old = {
      ...DEFAULT_SETTINGS,
      model: 'qwen3-coder',
      voice: { enabled: true, sidecarURL: 'http://127.0.0.1:8123', voice: 'bm_lewis', autoSend: false, speakReplies: true }
    } as unknown as Record<string, unknown>
    const merged = mergeWithDefaults(old)
    expect(merged).not.toBeNull()
    // The previously-enabled voice + the chosen voice id must survive, NOT reset to defaults.
    expect(merged?.voice.enabled).toBe(true)
    expect(merged?.voice.voice).toBe('bm_lewis')
    expect(merged?.voice.autoSend).toBe(false)
    // The new field is filled from the default.
    expect(merged?.voice.wakeWord).toBe(false)
    expect(merged?.model).toBe('qwen3-coder')
  })

  it('fills a missing nested object entirely from defaults', () => {
    const merged = mergeWithDefaults({ model: 'm' })
    expect(merged?.voice).toEqual(DEFAULT_SETTINGS.voice)
    expect(merged?.image).toEqual(DEFAULT_SETTINGS.image)
  })

  it('returns null on an unfixable invalid value (bad baseURL)', () => {
    expect(mergeWithDefaults({ baseURL: 'not-a-url' })).toBeNull()
  })
})

describe('multi-backend connections migration', () => {
  it('seeds a connection from legacy flat baseURL/model when none exist', () => {
    // A settings.json written before `connections` existed: flat fields only, no connections key.
    const old = { baseURL: 'http://127.0.0.1:4321/v1', model: 'qwen3-coder' } as Record<string, unknown>
    const merged = mergeWithDefaults(old)
    expect(merged).not.toBeNull()
    expect(merged!.connections).toHaveLength(1)
    const c = merged!.connections[0]
    expect(c.kind).toBe('lmstudio')
    expect(c.baseURL).toBe('http://127.0.0.1:4321/v1')
    expect(c.model).toBe('qwen3-coder')
    expect(merged!.activeConnectionId).toBe(c.id)
    // The active connection resolves back to the migrated one.
    expect(activeConnection(merged!).model).toBe('qwen3-coder')
  })

  it('keeps an explicit connections array as-is (no clobber)', () => {
    const raw = {
      ...DEFAULT_SETTINGS,
      connections: [
        { id: 'a', label: 'Local', kind: 'lmstudio', baseURL: 'http://127.0.0.1:1234/v1', apiKey: '', model: 'm1', temperature: null, maxTokens: null, contextLimitTokens: null },
        { id: 'b', label: 'Claude', kind: 'anthropic', baseURL: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-x', model: 'claude-opus-4-8', temperature: null, maxTokens: null, contextLimitTokens: null }
      ],
      activeConnectionId: 'b'
    } as unknown as Record<string, unknown>
    const merged = mergeWithDefaults(raw)
    expect(merged!.connections).toHaveLength(2)
    expect(merged!.activeConnectionId).toBe('b')
    expect(activeConnection(merged!).kind).toBe('anthropic')
    expect(activeConnection(merged!).apiKey).toBe('sk-ant-x')
  })

  it('drops one malformed connection without resetting every other setting to defaults', () => {
    const raw = {
      ...DEFAULT_SETTINGS,
      theme: 'light',
      model: 'keepme',
      connections: [
        { id: 'good', label: 'Local', kind: 'lmstudio', baseURL: 'http://127.0.0.1:1234/v1', apiKey: '', model: 'm1', temperature: null, maxTokens: null, contextLimitTokens: null },
        // bad: baseURL has no scheme → fails connectionSchema. Must NOT nuke the whole settings object.
        { id: 'bad', label: 'Broken', kind: 'openai', baseURL: 'localhost:9999', apiKey: '', model: '', temperature: null, maxTokens: null, contextLimitTokens: null }
      ],
      activeConnectionId: 'good'
    } as unknown as Record<string, unknown>
    const merged = mergeWithDefaults(raw)
    expect(merged).not.toBeNull()
    // The bad connection is dropped; the good one + unrelated settings survive (no total reset).
    expect(merged!.connections.map((c) => c.id)).toEqual(['good'])
    expect(merged!.theme).toBe('light')
    expect(merged!.model).toBe('keepme')
    expect(merged!.activeConnectionId).toBe('good')
  })

  it('repairs a dangling activeConnectionId to the first connection', () => {
    const s = {
      ...DEFAULT_SETTINGS,
      connections: [{ ...DEFAULT_SETTINGS.connections[0], id: 'only' }],
      activeConnectionId: 'gone'
    } as Settings
    normalizeConnections(s)
    expect(s.activeConnectionId).toBe('only')
  })

  it('backfills a default connection when the array is empty', () => {
    const s = { ...DEFAULT_SETTINGS, connections: [], activeConnectionId: 'x' } as Settings
    normalizeConnections(s)
    expect(s.connections.length).toBeGreaterThan(0)
    expect(s.connections.some((c) => c.id === s.activeConnectionId)).toBe(true)
  })
})

describe('mergeWithDefaults — built-in ticket board auto-add', () => {
  it('adds the board to a config with no mcpServers field', () => {
    const s = mergeWithDefaults({ model: 'm' })
    expect(s).not.toBeNull()
    const board = s!.mcpServers.find((m) => m.id === 'board-builtin')
    expect(board?.enabled).toBe(true)
    expect(board?.url).toContain('8930')
  })

  it('adds the board to a config with an empty mcpServers array', () => {
    const s = mergeWithDefaults({ mcpServers: [] })
    expect(s!.mcpServers.some((m) => m.id === 'board-builtin')).toBe(true)
  })

  it('does NOT duplicate or re-enable a board the user disabled', () => {
    const s = mergeWithDefaults({
      mcpServers: [{ id: 'board-builtin', label: 'board', transport: 'http', enabled: false, url: 'http://127.0.0.1:8930/mcp' }]
    })
    const boards = s!.mcpServers.filter((m) => m.id === 'board-builtin')
    expect(boards).toHaveLength(1)
    expect(boards[0].enabled).toBe(false)
  })

  it('keeps user-added servers alongside the built-in board', () => {
    const s = mergeWithDefaults({
      mcpServers: [{ id: 'x', label: 'fs', transport: 'stdio', enabled: true, command: 'npx' }]
    })
    expect(s!.mcpServers.some((m) => m.id === 'board-builtin')).toBe(true)
    expect(s!.mcpServers.some((m) => m.id === 'x')).toBe(true)
  })
})
