// Record a polished, deterministic NordCode feature walkthrough from the real Electron app.
// The demo board is an in-memory HTTP service on a private port, so the user's board is untouched.

import { _electron as electron } from 'playwright-core'
import http from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = path.join(root, 'out', 'main', 'index.js')
const args = process.argv.slice(2)
const valueAfter = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : fallback
}
const output = path.resolve(root, valueAfter('--out', 'artifacts/nordcode-feature-tour.mp4'))
const framesDir = path.resolve(root, valueAfter('--frames', '_recording/nordcode-feature-tour'))
const keepFrames = args.includes('--keep-frames')
const boardPort = Number(valueAfter('--port', '18947'))
const width = 1440
const height = 810
const project = 'Launchpad'

const tickets = []
const sseClients = new Set()
const counts = () => {
  const c = { total: tickets.length, ready: 0, blocked: 0, todo: 0, in_progress: 0, review: 0, done: 0, cancelled: 0 }
  for (const ticket of tickets) {
    c[ticket.status] = (c[ticket.status] ?? 0) + 1
    if (ticket.blocked) c.blocked += 1
    if (ticket.ready) c.ready += 1
  }
  return c
}
const notifyBoard = () => {
  for (const response of sseClients) response.write('event: change\ndata: {}\n\n')
}
const json = (response, body, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}
const demoBoard = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${boardPort}`)
  if (request.method === 'GET' && url.pathname === '/api/projects') return json(response, tickets.length ? [project] : [])
  if (request.method === 'GET' && url.pathname === '/api/tickets') {
    const requestedProject = (url.searchParams.get('project') || '').toLowerCase()
    return json(response, requestedProject && requestedProject !== project.toLowerCase() ? [] : tickets)
  }
  if (request.method === 'GET' && url.pathname === '/api/summary') return json(response, counts())
  if (request.method === 'GET' && url.pathname === '/api/spec') return json(response, { project, content: '', title: project })
  if (request.method === 'GET' && url.pathname === '/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    response.write(': connected\n\n')
    sseClients.add(response)
    request.on('close', () => sseClients.delete(response))
    return
  }
  if (request.method === 'POST' && /\/comment$/.test(url.pathname)) return json(response, { ok: true })
  if (request.method === 'POST' && /\/status$/.test(url.pathname)) return json(response, { ok: true })
  if (request.method === 'POST' && /\/dependency$/.test(url.pathname)) return json(response, { ok: true })
  if (url.pathname === '/mcp') return json(response, { error: 'Demo board does not expose MCP tools.' }, 404)
  return json(response, { error: 'not found' }, 404)
})

const listen = () => new Promise((resolve, reject) => {
  demoBoard.once('error', reject)
  demoBoard.listen(boardPort, '127.0.0.1', resolve)
})
const closeServer = () => new Promise((resolve) => demoBoard.close(resolve))

function seedPlannerBoard() {
  const base = { project, priority: 1, assignee: null, check: null }
  tickets.push(
    { ...base, id: 101, title: 'Define product architecture', status: 'done', body: '**Department: architecture**\nMap services, data flow, and delivery risks.', deps: [], blocked_by: [], blocked: false, ready: false, check: 'npm run typecheck' },
    { ...base, id: 102, title: 'Design the core experience', status: 'done', body: '**Department: design**\nCreate the navigation, dashboard, and empty states.', deps: [101], blocked_by: [], blocked: false, ready: false },
    { ...base, id: 103, title: 'Build the secure API', status: 'in_progress', body: '**Department: implementation**\nImplement authenticated endpoints and validation.', deps: [101], blocked_by: [], blocked: false, ready: false, check: 'npm test -- api' },
    { ...base, id: 104, title: 'Implement the analytics dashboard', status: 'todo', body: '**Department: implementation**\nConnect charts, filters, and responsive states.', deps: [102, 103], blocked_by: [103], blocked: true, ready: false, check: 'npm test -- dashboard' },
    { ...base, id: 105, title: 'Add the automated test suite', status: 'todo', body: '**Department: testing**\nCover critical user journeys and API contracts.', deps: [103], blocked_by: [103], blocked: true, ready: false, check: 'npm test' },
    { ...base, id: 106, title: 'Run accessibility and UX review', status: 'review', body: '**Department: review**\nValidate keyboard flow, contrast, and error recovery.', deps: [102], blocked_by: [], blocked: false, ready: false },
    { ...base, id: 107, title: 'Publish launch documentation', status: 'todo', body: '**Department: docs**\nWrite setup, operations, and release notes.', deps: [104, 105, 106], blocked_by: [104, 105, 106], blocked: true, ready: false, check: 'npm run docs:check' }
  )
  notifyBoard()
}

let electronApp
let capture = true
const profileDir = mkdtempSync(path.join(tmpdir(), 'nordcode-recording-'))
const frameRecords = []
let startedAt = 0

async function installVideoChrome(page) {
  await page.evaluate(() => {
    const style = document.createElement('style')
    style.id = 'nc-video-style'
    style.textContent = `
      #nc-video-intro { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center;
        background: radial-gradient(circle at 52% 35%, #312018 0, #121215 43%, #09090b 100%); color: #f6f3ef;
        font-family: Inter, Segoe UI, sans-serif; transition: opacity .5s ease; }
      #nc-video-intro .inner { text-align: center; transform: translateY(-10px); }
      #nc-video-intro .mark { width: 70px; height: 70px; margin: 0 auto 24px; display: grid; place-items: center;
        border-radius: 18px; border: 1px solid #87502e; background: linear-gradient(145deg,#3b241b,#18171a);
        box-shadow: 0 18px 60px #0008, inset 0 0 30px #d86f2630; color: #f08b43; font-size: 36px; }
      #nc-video-intro h1 { margin: 0; font-size: 44px; letter-spacing: -.04em; }
      #nc-video-intro p { margin: 13px 0 0; font-size: 19px; color: #b9b4b0; }
      #nc-video-caption { position: fixed; z-index: 2147483646; left: 50%; bottom: 28px; transform: translate(-50%,18px);
        max-width: 850px; padding: 13px 21px; border: 1px solid #ffffff18; border-radius: 13px;
        background: #0e0e12e8; box-shadow: 0 15px 45px #0009; backdrop-filter: blur(18px); color: #f5f2ef;
        font: 600 17px/1.35 Inter, Segoe UI, sans-serif; text-align: center; opacity: 0; transition: .28s ease; pointer-events: none; }
      #nc-video-caption.show { opacity: 1; transform: translate(-50%,0); }
      #nc-video-outro { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center;
        background: #0b0b0edb; backdrop-filter: blur(14px); opacity: 0; transition: opacity .5s ease; color: white;
        font-family: Inter, Segoe UI, sans-serif; text-align: center; pointer-events: none; }
      #nc-video-outro.show { opacity: 1; } #nc-video-outro h2 { font-size: 39px; margin: 0 0 12px; }
      #nc-video-outro p { color: #c2bbb6; font-size: 19px; margin: 0; } #nc-video-outro b { color: #ef8840; }
    `
    document.head.appendChild(style)
    const intro = document.createElement('div')
    intro.id = 'nc-video-intro'
    intro.innerHTML = '<div class="inner"><div class="mark">⌁</div><h1>Meet NordCode</h1><p>Your local coding workbench — from idea to verified delivery.</p></div>'
    document.body.appendChild(intro)
    const caption = document.createElement('div')
    caption.id = 'nc-video-caption'
    document.body.appendChild(caption)
    const outro = document.createElement('div')
    outro.id = 'nc-video-outro'
    outro.innerHTML = '<div><h2>Plan locally. Build with confidence.</h2><p><b>NordCode</b> keeps the whole workflow visible.</p></div>'
    document.body.appendChild(outro)
  })
}

async function caption(page, text) {
  await page.evaluate((value) => {
    const el = document.getElementById('nc-video-caption')
    if (!el) return
    el.textContent = value
    el.classList.toggle('show', Boolean(value))
  }, text)
}

const hold = (page, ms) => page.waitForTimeout(ms)

async function scenario(page) {
  await hold(page, 2500)
  await page.evaluate(() => { const el = document.getElementById('nc-video-intro'); if (el) el.style.opacity = '0' })
  await hold(page, 600)
  await page.evaluate(() => document.getElementById('nc-video-intro')?.remove())

  await caption(page, 'A private, local-first coding workspace with every tool in one place.')
  await hold(page, 2600)

  await page.getByRole('button', { name: 'Plan', exact: true }).click()
  await caption(page, 'Plan mode is read-only: NordCode can inspect and reason before anything changes.')
  await hold(page, 3300)

  await page.keyboard.press('Control+K')
  await caption(page, 'A command palette keeps navigation, modes, and common actions one shortcut away.')
  await hold(page, 2500)
  await page.keyboard.press('Escape')
  await caption(page, '')
  await hold(page, 600)

  await page.getByRole('tab', { name: 'Planner', exact: true }).click()
  await page.getByRole('button', { name: 'New mission', exact: true }).click()
  await page.getByRole('dialog', { name: 'New mission' }).getByPlaceholder('run project name...').fill(project)
  await page.keyboard.press('Enter')
  await hold(page, 900)
  await caption(page, 'Planner starts with an outcome, then coordinates the work across specialist teams.')
  await hold(page, 1900)

  const plannerInput = page.getByPlaceholder('Message Planner...')
  await plannerInput.pressSequentially('Build a launch-ready analytics dashboard with auth, charts, tests, and docs.', { delay: 28 })
  await hold(page, 900)
  await caption(page, 'One goal becomes a dependency-aware plan—architecture, implementation, testing, review, and docs.')
  seedPlannerBoard()
  await hold(page, 1700)
  await page.locator('.hermes-chat-head').click()
  await hold(page, 1200)

  const showDone = page.getByRole('button', { name: /show 2 done/i })
  if (await showDone.isVisible()) await showDone.click()
  await caption(page, 'Dependencies stay visible, so independent work can run in parallel without losing the critical path.')
  await hold(page, 3600)

  await page.getByRole('button', { name: /Implement the analytics dashboard/i }).click()
  await caption(page, 'Open any task to inspect status, checks, progress, review state, and steer the team.')
  await hold(page, 3400)
  await page.getByRole('button', { name: 'Close detail', exact: true }).click()
  await hold(page, 500)

  await page.getByRole('tab', { name: 'Mission', exact: true }).click()
  await caption(page, 'Mission Control turns the plan into an observable run—with queue, activity, budgets, and safeguards.')
  await hold(page, 3200)
  const runSettings = page.getByRole('button', { name: 'Run settings', exact: true })
  if (await runSettings.isVisible()) {
    await runSettings.click()
    await hold(page, 2600)
    await page.keyboard.press('Escape')
  }

  await page.getByRole('tab', { name: 'Planner', exact: true }).click()
  await hold(page, 800)
  await caption(page, 'From first idea to reviewed delivery, NordCode keeps the plan—and the reasoning—close to the work.')
  await hold(page, 2900)
  await caption(page, '')
  await page.evaluate(() => document.getElementById('nc-video-outro')?.classList.add('show'))
  await hold(page, 2800)
  capture = false
}

async function captureLoop(page) {
  startedAt = Date.now()
  let index = 0
  while (capture) {
    const file = `frame-${String(index).padStart(5, '0')}.jpg`
    await page.screenshot({ path: path.join(framesDir, file), type: 'jpeg', quality: 82 })
    frameRecords.push({ file, t: Date.now() - startedAt })
    index += 1
    await page.waitForTimeout(35)
  }
}

try {
  rmSync(framesDir, { recursive: true, force: true })
  mkdirSync(framesDir, { recursive: true })
  mkdirSync(path.dirname(output), { recursive: true })
  writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({ theme: 'dark', lastCwd: root, transcriptDensity: 'compact' }, null, 2))
  await listen()

  electronApp = await electron.launch({
    args: [mainEntry, `--user-data-dir=${profileDir}`],
    cwd: root,
    env: { ...process.env, TICKET_BOARD_URL: `http://127.0.0.1:${boardPort}` }
  })
  const page = await electronApp.firstWindow()
  await electronApp.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setContentSize(size.width, size.height)
    win?.show()
    win?.focus()
  }, { width, height })
  await page.waitForSelector('.topbar', { state: 'visible', timeout: 20000 })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await installVideoChrome(page)
  await Promise.all([captureLoop(page), scenario(page)])

  const manifest = { width, height, durationMs: Date.now() - startedAt, frames: frameRecords }
  const manifestPath = path.join(framesDir, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  console.log(JSON.stringify({ manifest: manifestPath, output, frames: frameRecords.length, durationMs: manifest.durationMs }))
} finally {
  capture = false
  if (electronApp) await electronApp.close().catch(() => {})
  await closeServer().catch(() => {})
  rmSync(profileDir, { recursive: true, force: true })
  if (!keepFrames) console.log('Frames retained until encoding completes.')
}
