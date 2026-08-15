import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { scoreRun } from './score.mjs'

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.dirname(BENCH_DIR)
const BOARD_URL = (process.env.TICKET_BOARD_URL || 'http://127.0.0.1:8930').replace(/\/+$/, '')

class BenchError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

const isoStamp = (date = new Date()) => date.toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')
const safeStamp = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '-')
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

function parseArgs(argv) {
  const options = { selector: '', runstamp: process.env.BENCH_RUNSTAMP || '', baseURL: process.env.BENCH_BASE_URL || '', settings: '' }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!arg.startsWith('--') && !options.selector) options.selector = arg
    else if (arg === '--runstamp') options.runstamp = argv[++index] ?? ''
    else if (arg.startsWith('--runstamp=')) options.runstamp = arg.slice('--runstamp='.length)
    else if (arg === '--base-url') options.baseURL = argv[++index] ?? ''
    else if (arg.startsWith('--base-url=')) options.baseURL = arg.slice('--base-url='.length)
    else if (arg === '--settings') options.settings = argv[++index] ?? ''
    else if (arg.startsWith('--settings=')) options.settings = arg.slice('--settings='.length)
    else throw new BenchError(`Unknown argument: ${arg}`)
  }
  if (!options.selector) throw new BenchError('Usage: node bench/run.mjs <taskId|all> [--runstamp value] [--base-url url]')
  return options
}

function appDataCandidates() {
  if (process.env.BASENJICODE_USER_DATA) return [process.env.BASENJICODE_USER_DATA]
  if (process.platform === 'win32') {
    const root = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return [path.join(root, 'BasenjiCode'), path.join(root, 'NordCode')]
  }
  if (process.platform === 'darwin') {
    const root = path.join(os.homedir(), 'Library', 'Application Support')
    return [path.join(root, 'BasenjiCode'), path.join(root, 'NordCode')]
  }
  const root = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return [path.join(root, 'BasenjiCode'), path.join(root, 'NordCode')]
}

function loadSettings(explicitPath) {
  const candidates = explicitPath
    ? [path.resolve(process.cwd(), explicitPath)]
    : appDataCandidates().map((dir) => path.join(dir, 'settings.json'))
  const file = candidates.find((candidate) => fs.existsSync(candidate))
  if (!file) throw new BenchError(`BasenjiCode/NordCode settings.json was not found. Checked: ${candidates.join(', ')}`)
  let settings
  try {
    settings = readJson(file)
  } catch (error) {
    throw new BenchError(`Could not read settings.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(settings.connections) || settings.connections.length === 0) {
    settings.connections = [
      {
        id: 'legacy-local',
        label: 'LM Studio',
        kind: 'lmstudio',
        baseURL: settings.baseURL || 'http://127.0.0.1:1234/v1',
        apiKey: '',
        model: settings.model || '',
        temperature: null,
        maxTokens: null,
        contextLimitTokens: null
      }
    ]
    settings.activeConnectionId = 'legacy-local'
  }
  return { settings, file }
}

function lmStudioConnection(settings, baseURLOverride) {
  const active = settings.connections.find((connection) => connection.id === settings.activeConnectionId)
  const selected = active?.kind === 'lmstudio' ? active : settings.connections.find((connection) => connection.kind === 'lmstudio')
  if (!selected) throw new BenchError('No LM Studio connection exists in settings.json.')
  return { ...selected, ...(baseURLOverride ? { baseURL: baseURLOverride } : {}) }
}

export async function probeLmStudio(connection, timeoutMs = 3000) {
  const baseURL = String(connection.baseURL || '').replace(/\/+$/, '')
  const endpoint = `${baseURL}/models`
  try {
    const response = await fetch(endpoint, {
      headers: connection.apiKey && !String(connection.apiKey).startsWith('enc:v1:') ? { Authorization: `Bearer ${connection.apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) return { ok: false, message: `LM Studio unreachable at ${baseURL}: HTTP ${response.status}` }
    const json = await response.json().catch(() => ({}))
    const models = Array.isArray(json?.data) ? json.data.map((item) => item?.id).filter(Boolean) : []
    return { ok: true, models }
  } catch (error) {
    return {
      ok: false,
      message: `LM Studio unreachable at ${baseURL}: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

function taskDefinitions() {
  return fs
    .readdirSync(path.join(BENCH_DIR, 'tasks'))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readJson(path.join(BENCH_DIR, 'tasks', name)))
}

function selectTasks(selector) {
  const tasks = taskDefinitions()
  if (selector === 'all') return tasks
  const matches = tasks.filter((task) => task.id === selector || task.id.startsWith(`${selector}-`))
  if (matches.length !== 1) throw new BenchError(matches.length ? `Task selector is ambiguous: ${selector}` : `Unknown task: ${selector}`)
  return matches
}

function copyFixture(task, workspace) {
  const fixture = path.resolve(REPO_ROOT, task.fixture)
  fs.mkdirSync(workspace, { recursive: true })
  for (const entry of fs.readdirSync(fixture)) {
    fs.cpSync(path.join(fixture, entry), path.join(workspace, entry), { recursive: true })
  }
}

function electronShimSource() {
  return `
import path from 'node:path'
import os from 'node:os'
const root = () => process.env.BASENJICODE_BENCH_RUNTIME_ROOT || process.cwd()
export const app = {
  isPackaged: false,
  getAppPath: () => process.env.BASENJICODE_BENCH_REPO_ROOT || process.cwd(),
  getPath: (name) => name === 'logs' ? path.join(root(), 'logs') : name === 'temp' ? os.tmpdir() : root()
}
export const BrowserWindow = { getAllWindows: () => [] }
export const webContents = { fromId: () => undefined }
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (value) => Buffer.from(value).toString('utf8')
}
`
}

async function buildMainRuntime(runtimeRoot) {
  const source = (...parts) => path.resolve(REPO_ROOT, 'src', 'main', ...parts).replace(/\\/g, '/')
  const entry = path.join(runtimeRoot, 'bench-runtime-entry.ts')
  const shim = path.join(runtimeRoot, 'electron-shim.mjs')
  const outDir = path.join(runtimeRoot, 'built-main')
  fs.mkdirSync(runtimeRoot, { recursive: true })
  fs.writeFileSync(shim, electronShimSource())
  fs.writeFileSync(
    entry,
    [
      `export { AgentSession } from ${JSON.stringify(source('agent', 'loop.ts'))}`,
      `export { buildRegistry } from ${JSON.stringify(source('agent', 'tools', 'index.ts'))}`,
      `export { createConnectionClient } from ${JSON.stringify(source('agent', 'lmstudio.ts'))}`,
      `export { BoardRunner } from ${JSON.stringify(source('agent', 'boardRunner.ts'))}`,
      `export { runTicketWithCheck, runReview, writeRejectionFeedback, BOARD_DRIVING_TOOLS } from ${JSON.stringify(source('agent', 'boardInner.ts'))}`
    ].join('\n')
  )
  const { build } = await import('vite')
  await build({
    configFile: false,
    logLevel: 'error',
    resolve: { alias: [{ find: 'electron', replacement: shim }] },
    ssr: { noExternal: true },
    build: {
      ssr: true,
      target: 'node20',
      outDir,
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        input: entry,
        output: { format: 'es', entryFileNames: 'runtime.mjs' }
      }
    }
  })
  return import(`${pathToFileURL(path.join(outDir, 'runtime.mjs')).href}?run=${Date.now()}`)
}

function agentConfig(settings, connection, task, model) {
  const local = connection.kind === 'lmstudio' || connection.kind === 'ollama' || /127\.0\.0\.1|localhost/.test(connection.baseURL)
  return {
    model,
    temperature: connection.temperature ?? settings.temperature ?? 0.2,
    maxTokens: connection.maxTokens ?? settings.maxTokens ?? 16_384,
    maxTurns: task.maxTurns,
    contextLimitTokens: connection.contextLimitTokens ?? settings.contextLimitTokens ?? 80_000,
    images: settings.image,
    voicePersona: false,
    connectionKind: connection.kind,
    connectionLabel: connection.label,
    preferTextToolCalls: connection.preferTextToolCalls ?? (local ? true : undefined),
    reasoningEffort: connection.reasoningEffort ?? (local ? 'off' : undefined),
    autoMemory: false,
    warnDontBail: true,
    compactAtFraction: 0.55,
    shellScreening: settings.shellScreening ?? 'screen',
    headless: true
  }
}

function appendBenchLog(logFile, text) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] INFO BENCH ${text}\n`)
}

function telemetryCollector(events) {
  let toolErrors = 0
  let reasoningChars = 0
  const progressByTurn = new Map()
  return {
    event(event) {
      events.push(event)
      if (event.type === 'tool-result' && !event.ok) toolErrors++
      if (event.type === 'thinking-progress') {
        const previous = progressByTurn.get(event.turnId) ?? 0
        reasoningChars += event.chars >= previous ? event.chars - previous : event.chars
        progressByTurn.set(event.turnId, event.chars)
      }
    },
    result: () => ({ toolErrors, reasoningChars })
  }
}

async function runAgentTask(runtime, task, workspace, settings, connection, model, runstamp) {
  const events = []
  const telemetry = telemetryCollector(events)
  const session = new runtime.AgentSession({
    id: `bench-${task.id}-${runstamp}`,
    workspaceRoot: workspace,
    client: runtime.createConnectionClient({ ...connection, model }),
    registry: runtime.buildRegistry(),
    config: agentConfig(settings, connection, task, model),
    mode: 'auto',
    history: []
  })
  await session.runTurn(task.prompt, randomUUID(), (event) => telemetry.event(event))
  return { events, history: session.getHistory(), ...telemetry.result() }
}

async function boardPost(pathname, body) {
  const response = await fetch(`${BOARD_URL}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new BenchError(data?.error || `Board HTTP ${response.status}`)
  return data
}

async function seedMiniBoard(task, project) {
  let previous
  for (let index = 0; index < task.miniTickets.length; index++) {
    const mini = task.miniTickets[index]
    const ticket = await boardPost('/api/tickets', {
      project,
      title: mini.title,
      body: mini.body,
      check: mini.check,
      priority: index + 1,
      deps: previous ? [previous] : []
    })
    previous = ticket.id
  }
}

async function runBoardTask(runtime, task, workspace, settings, connection, model, runstamp) {
  const project = `bench-${task.id}-${safeStamp(runstamp).toLowerCase()}`
  await seedMiniBoard(task, project)
  const events = []
  const telemetry = telemetryCollector(events)
  const runner = new runtime.BoardRunner()
  const registry = runtime.buildRegistry().without(runtime.BOARD_DRIVING_TOOLS)
  runner.emit = (event) => {
    events.push(event)
    if (event.kind === 'agent-event' && event.event) telemetry.event(event.event)
  }
  runner.runTicket = (ticket, config, hooks, opts) =>
    runtime.runTicketWithCheck(ticket, config, { settings, registry, emit: (event) => runner.emit(event) }, hooks, opts)
  runner.reviewTicket = (ticket, config) =>
    runtime.runReview(ticket, config, { settings, registry, emit: (event) => runner.emit(event) })
  runner.saveRejectionFeedback = runtime.writeRejectionFeedback
  const config = {
    cwd: workspace,
    connectionId: connection.id,
    project,
    mode: 'auto',
    caps: { maxTickets: task.miniTickets.length, maxTokens: 0, maxWallclockSec: 0, maxConsecutiveFailures: 3 },
    terminal: 'auto',
    maxAttemptsPerTicket: 3,
    branchPerRun: false,
    workerModel: model,
    swapModels: false,
    parallelism: 1,
    includeReview: false
  }
  const started = runner.start(config)
  if (!started.ok) throw new BenchError(started.error || 'Loop runner refused the board bench')
  await runner.loopDone
  return { events, status: runner.status(), project, ...telemetry.result() }
}

function runShellCheck(command, cwd, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true })
    let output = ''
    child.stdout?.on('data', (chunk) => (output += chunk))
    child.stderr?.on('data', (chunk) => (output += chunk))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ passed: false, detail: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ passed: code === 0, detail: output.trim().slice(-4000) || `exit ${code}` })
    })
  })
}

function stopProcessTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
}

function startHttpServer(workspace, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const npxArgs = ['--yes', 'http-server', workspace, '-p', '0', '-a', '127.0.0.1', '-c-1']
    const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npx'
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', `npx ${npxArgs.map((arg) => `"${arg.replaceAll('"', '""')}"`).join(' ')}`] : npxArgs
    const child = spawn(command, args, {
      cwd: workspace,
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    let output = ''
    let settled = false
    const inspect = (chunk) => {
      output += String(chunk).replace(/\x1b\[[0-9;]*m/g, '')
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/)
      if (match && !settled) {
        settled = true
        clearTimeout(timer)
        resolve({ child, baseURL: `http://127.0.0.1:${match[1]}` })
      }
    }
    child.stdout?.on('data', inspect)
    child.stderr?.on('data', inspect)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`http-server failed: ${error.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`http-server exited ${code}: ${output.trim().slice(-1000)}`))
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      stopProcessTree(child)
      reject(new Error(`http-server did not report a port: ${output.trim().slice(-1000)}`))
    }, timeoutMs)
  })
}

export async function runCompletionChecks(task, workspace, boardStatus) {
  const results = []
  let server
  try {
    if (task.completionChecks.some((check) => check.type === 'httpOk')) server = await startHttpServer(workspace)
    for (const check of task.completionChecks) {
      if (check.type === 'fileExists') {
        const passed = fs.existsSync(path.resolve(workspace, check.arg))
        results.push({ ...check, passed, detail: passed ? 'exists' : 'missing' })
      } else if (check.type === 'shellExitZero') {
        results.push({ ...check, ...(await runShellCheck(check.arg, workspace)) })
      } else if (check.type === 'httpOk') {
        const url = /^https?:\/\//i.test(check.arg) ? check.arg : new URL(check.arg, server.baseURL).href
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
          results.push({ ...check, passed: response.ok, detail: `HTTP ${response.status}` })
        } catch (error) {
          results.push({ ...check, passed: false, detail: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    if (task.type === 'board') {
      const passed = boardStatus?.done === task.miniTickets.length
      results.push({ type: 'boardDone', arg: `${task.miniTickets.length} mini tickets`, passed, detail: JSON.stringify(boardStatus ?? {}) })
    }
    return results
  } finally {
    if (server) stopProcessTree(server.child)
  }
}

function readTurns(file) {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function appendResults(task, runstamp, score, historyFile) {
  const resultsFile = path.join(BENCH_DIR, 'history', 'RESULTS.md')
  if (!fs.existsSync(resultsFile)) {
    fs.writeFileSync(
      resultsFile,
      '| Run | Task | Turns | Wall s | Tool errors | Breakers | Warn continues | Reasoning chars | High-ctx gap s | Checks |\n' +
        '|---|---|---:|---:|---:|---:|---:|---:|---:|:---:|\n'
    )
  }
  const rel = path.relative(BENCH_DIR, historyFile).replace(/\\/g, '/')
  fs.appendFileSync(
    resultsFile,
    `| [${runstamp}](${rel}) | ${task.id} | ${score.turns} | ${score.wallClockSec} | ${score.toolErrors} | ${score.breakerFires} | ${score.warnContinues} | ${score.reasoningChars} | ${score.avgTurnGapAtHighCtx ?? 'n/a'} | ${score.completionChecksPassed ? 'pass' : 'fail'} |\n`
  )
}

async function runOne(task, context) {
  const taskStamp = safeStamp(context.runstamp)
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `basenjicode-bench-${task.id}-`))
  copyFixture(task, workspace)
  const runtimeRoot = path.join(workspace, '.bench-runtime')
  const logsDir = path.join(runtimeRoot, 'logs')
  const mainLog = path.join(logsDir, 'main.log')
  process.env.BASENJICODE_BENCH_RUNTIME_ROOT = runtimeRoot
  process.env.BASENJICODE_BENCH_REPO_ROOT = REPO_ROOT
  process.env.TICKET_BOARD_URL = BOARD_URL
  process.env.TICKET_BOARD_ASSIGNEE = `bench-${task.id}`
  const runtime = await buildMainRuntime(runtimeRoot)

  appendBenchLog(mainLog, `run-start task=${task.id} runstamp=${taskStamp}`)
  const session = task.type === 'board'
    ? await runBoardTask(runtime, task, workspace, context.settings, context.connection, context.model, taskStamp)
    : await runAgentTask(runtime, task, workspace, context.settings, context.connection, context.model, taskStamp)
  appendBenchLog(mainLog, `run-summary toolErrors=${session.toolErrors ?? 0} reasoningChars=${session.reasoningChars ?? 0}`)
  appendBenchLog(mainLog, `run-end task=${task.id} runstamp=${taskStamp}`)
  fs.writeFileSync(path.join(runtimeRoot, 'session-artifacts.json'), JSON.stringify(session, null, 2))

  const checks = await runCompletionChecks(task, workspace, session.status)
  const turns = readTurns(path.join(logsDir, 'turns.jsonl'))
  const logLines = fs.existsSync(mainLog) ? fs.readFileSync(mainLog, 'utf8').split(/\r?\n/).filter(Boolean) : []
  const score = scoreRun(turns, logLines, checks)
  const historyFile = path.join(BENCH_DIR, 'history', `${task.id}-${taskStamp}.json`)
  const result = {
    taskId: task.id,
    runstamp: taskStamp,
    startedFromSettings: context.settingsFile,
    connection: { id: context.connection.id, label: context.connection.label, model: context.model, baseURL: context.connection.baseURL },
    workspace,
    artifacts: runtimeRoot,
    checks,
    score
  }
  fs.writeFileSync(historyFile, JSON.stringify(result, null, 2) + '\n')
  appendResults(task, taskStamp, score, historyFile)
  console.log(`${task.id}: ${score.completionChecksPassed ? 'PASS' : 'FAIL'} — ${historyFile}`)
  return result
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const tasks = selectTasks(options.selector)
  const { settings, file: settingsFile } = loadSettings(options.settings)
  const connection = lmStudioConnection(settings, options.baseURL)
  const probe = await probeLmStudio(connection)
  if (!probe.ok) throw new BenchError(probe.message, 2)
  const model = connection.model || probe.models?.[0]
  if (!model) throw new BenchError(`LM Studio at ${connection.baseURL} returned no model and none is configured.`, 2)
  const runstamp = options.runstamp || isoStamp()
  let failed = false
  for (const task of tasks) {
    const result = await runOne(task, { settings, settingsFile, connection, model, runstamp })
    if (!result.score.completionChecksPassed) failed = true
  }
  if (failed) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (error instanceof BenchError) {
      console.error(`Bench: ${error.message}`)
      process.exitCode = error.exitCode
    } else {
      console.error(`Bench failed: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  })
}
