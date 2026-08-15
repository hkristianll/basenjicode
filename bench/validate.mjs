import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CHECK_TYPES = new Set(['fileExists', 'shellExitZero', 'httpOk'])
const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.dirname(BENCH_DIR)

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Pure shape validation. Returns human-readable errors and never reads the filesystem. */
export function validateTask(task) {
  const errors = []
  if (!isRecord(task)) return ['task must be a JSON object']

  if (typeof task.id !== 'string' || !task.id.trim()) errors.push('id must be a non-empty string')
  if (typeof task.title !== 'string' || !task.title.trim()) errors.push('title must be a non-empty string')
  if (typeof task.fixture !== 'string' || !task.fixture.trim()) errors.push('fixture must be a non-empty path string')
  if (!Number.isInteger(task.maxTurns) || task.maxTurns <= 0) errors.push('maxTurns must be a positive integer')
  if (typeof task.notes !== 'string' || !task.notes.trim()) errors.push('notes must be a non-empty string')

  if (task.type === 'board') {
    if (task.prompt !== null) errors.push('board task prompt must be null')
    if (!Array.isArray(task.miniTickets) || task.miniTickets.length !== 3) {
      errors.push('board task miniTickets must contain exactly 3 tickets')
    } else {
      task.miniTickets.forEach((ticket, index) => {
        if (!isRecord(ticket)) {
          errors.push(`miniTickets[${index}] must be an object`)
          return
        }
        for (const field of ['title', 'body', 'check']) {
          if (typeof ticket[field] !== 'string' || !ticket[field].trim()) {
            errors.push(`miniTickets[${index}].${field} must be a non-empty string`)
          }
        }
      })
    }
  } else {
    if (task.type !== undefined) errors.push('type must be "board" when present')
    if (typeof task.prompt !== 'string' || !task.prompt.trim()) errors.push('prompt must be a non-empty string')
  }

  if (!Array.isArray(task.completionChecks)) {
    errors.push('completionChecks must be an array')
  } else {
    task.completionChecks.forEach((check, index) => {
      if (!isRecord(check)) {
        errors.push(`completionChecks[${index}] must be an object`)
        return
      }
      if (!CHECK_TYPES.has(check.type)) errors.push(`completionChecks[${index}].type is invalid`)
      if (typeof check.arg !== 'string' || !check.arg.trim()) {
        errors.push(`completionChecks[${index}].arg must be a non-empty string`)
      }
    })
  }

  return errors
}

function taskFiles(args) {
  if (args.length) return args.map((arg) => path.resolve(process.cwd(), arg))
  const dir = path.join(BENCH_DIR, 'tasks')
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(dir, name))
}

export function validateFiles(files) {
  const results = []
  const ids = new Map()
  for (const file of files) {
    let task
    try {
      task = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      results.push(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    for (const error of validateTask(task)) results.push(`${file}: ${error}`)
    if (typeof task.id === 'string') {
      if (ids.has(task.id)) results.push(`${file}: duplicate id ${task.id} (also in ${ids.get(task.id)})`)
      else ids.set(task.id, file)
    }
    if (typeof task.fixture === 'string') {
      const fixture = path.resolve(REPO_ROOT, task.fixture)
      if (!fs.existsSync(fixture) || !fs.statSync(fixture).isDirectory()) {
        results.push(`${file}: fixture directory does not exist: ${task.fixture}`)
      }
    }
  }
  return results
}

function main() {
  const files = taskFiles(process.argv.slice(2))
  const errors = validateFiles(files)
  if (errors.length) {
    for (const error of errors) console.error(error)
    process.exitCode = 1
    return
  }
  console.log(`Validated ${files.length} bench task definition${files.length === 1 ? '' : 's'}.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
