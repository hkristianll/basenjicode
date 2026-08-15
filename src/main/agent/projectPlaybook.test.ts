import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROJECT_PLAYBOOK_FILE, readProjectPlaybook } from './projectPlaybook'

const dirs: string[] = []

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'basenjicode-playbook-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('readProjectPlaybook', () => {
  it('discovers verification scripts from package.json', () => {
    const dir = workspace()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', typecheck: 'tsc', test: 'vitest', 'test:e2e': 'playwright test' } }))

    const playbook = readProjectPlaybook(dir)
    expect(playbook).toContain('npm run typecheck')
    expect(playbook).toContain('npm run test')
    expect(playbook).toContain('npm run test:e2e')
    expect(playbook).not.toContain('npm run dev')
  })

  it('uses the lockfile package manager', () => {
    const dir = workspace()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }))
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '')

    expect(readProjectPlaybook(dir)).toContain('pnpm run lint')
  })

  it('injects the explicit reusable definition of done', () => {
    const dir = workspace()
    writeFileSync(join(dir, PROJECT_PLAYBOOK_FILE), JSON.stringify({ definitionOfDone: ['No new TypeScript errors', 'Update user-facing docs'] }))

    const playbook = readProjectPlaybook(dir)
    expect(playbook).toContain('Project definition of done')
    expect(playbook).toContain('- No new TypeScript errors')
    expect(playbook).toContain('- Update user-facing docs')
  })

  it('degrades cleanly for missing or malformed files', () => {
    const empty = workspace()
    expect(readProjectPlaybook(empty)).toBeNull()

    const malformed = workspace()
    writeFileSync(join(malformed, 'package.json'), '{')
    writeFileSync(join(malformed, PROJECT_PLAYBOOK_FILE), '{')
    expect(readProjectPlaybook(malformed)).toBeNull()
  })
})
