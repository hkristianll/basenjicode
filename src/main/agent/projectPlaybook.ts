import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const PROJECT_PLAYBOOK_FILE = 'basenjicode.playbook.json'

interface ProjectPlaybookConfig {
  definitionOfDone?: unknown
}

const SCRIPT_LIMIT = 12
const DOD_LIMIT = 20
const ITEM_CAP = 500

function packageManager(cwd: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return 'bun'
  return 'npm'
}

function scriptCommand(manager: ReturnType<typeof packageManager>, name: string): string {
  if (manager === 'yarn') return `yarn ${name}`
  return `${manager} run ${name}`
}

/** Read package.json directly: this is intentionally discovery, not another project-indexing subsystem. */
function verificationScripts(cwd: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { scripts?: unknown }
    if (!parsed.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) return []
    const names = Object.keys(parsed.scripts as Record<string, unknown>)
      .filter((name) => /^(?:test|lint|typecheck|check|build|e2e)(?::|$)/i.test(name))
      .slice(0, SCRIPT_LIMIT)
    const manager = packageManager(cwd)
    return names.map((name) => scriptCommand(manager, name))
  } catch {
    return []
  }
}

function definitionOfDone(cwd: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, PROJECT_PLAYBOOK_FILE), 'utf8')) as ProjectPlaybookConfig
    if (!Array.isArray(parsed.definitionOfDone)) return []
    return parsed.definitionOfDone
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .slice(0, DOD_LIMIT)
      .map((item) => item.trim().slice(0, ITEM_CAP))
  } catch {
    return []
  }
}

/**
 * Compact project conventions injected into every fresh board-worker seed.
 * Returns null for projects with neither detectable checks nor an explicit definition of done.
 */
export function readProjectPlaybook(cwd: string): string | null {
  const scripts = verificationScripts(cwd)
  const done = definitionOfDone(cwd)
  if (scripts.length === 0 && done.length === 0) return null

  const sections: string[] = []
  if (scripts.length) sections.push(`Available verification scripts (run the ones relevant to this ticket):\n${scripts.map((item) => `- ${item}`).join('\n')}`)
  if (done.length) sections.push(`Project definition of done:\n${done.map((item) => `- ${item}`).join('\n')}`)
  return `${sections.join('\n\n')}\n\nThe ticket's own verification check is still mandatory and is the final acceptance gate.`
}
