import { describe, it, expect } from 'vitest'
import { mcpServerSchema, settingsSchema, DEFAULT_SETTINGS } from './domain-types'

describe('mcpServerSchema', () => {
  it('accepts a valid stdio server', () => {
    const ok = mcpServerSchema.safeParse({
      id: 's1',
      label: 'fs',
      transport: 'stdio',
      enabled: true,
      command: 'npx',
      args: ['-y', 'some-server'],
      env: { TOKEN: 'abc' }
    })
    expect(ok.success).toBe(true)
  })

  it('accepts a valid http server', () => {
    const ok = mcpServerSchema.safeParse({
      id: 's2',
      label: 'board',
      transport: 'http',
      enabled: false,
      url: 'http://127.0.0.1:8930/mcp'
    })
    expect(ok.success).toBe(true)
  })

  it('rejects entries missing id or label', () => {
    expect(mcpServerSchema.safeParse({ label: 'x', transport: 'stdio', enabled: true }).success).toBe(false)
    expect(mcpServerSchema.safeParse({ id: 'a', label: '', transport: 'stdio', enabled: true }).success).toBe(false)
  })

  it('rejects an unknown transport', () => {
    expect(mcpServerSchema.safeParse({ id: 'a', label: 'x', transport: 'ws', enabled: true }).success).toBe(false)
  })
})

describe('settings carry mcpServers', () => {
  it('defaults include the built-in ticket board and still validate', () => {
    expect(DEFAULT_SETTINGS.mcpServers.some((m) => m.id === 'board-builtin')).toBe(true)
    expect(settingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true)
  })

  it('round-trips a settings object carrying an MCP server', () => {
    const s = {
      ...DEFAULT_SETTINGS,
      mcpServers: [{ id: 'b', label: 'board', transport: 'http' as const, enabled: true, url: 'http://127.0.0.1:8930/mcp' }]
    }
    const parsed = settingsSchema.safeParse(s)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.mcpServers[0].label).toBe('board')
  })

  it('rejects settings whose mcpServers contains a malformed entry', () => {
    const s = { ...DEFAULT_SETTINGS, mcpServers: [{ id: 'b' }] }
    expect(settingsSchema.safeParse(s).success).toBe(false)
  })
})
