// Drive the LIVE NordCode (launched with --remote-debugging-port via launch-debug.ps1) over CDP:
// set a working folder, create a Hermes project, hand Brooke a goal, and screenshot — all without
// touching the mouse (no flaky computer-use). Pairs with `npm run peek` + the board API to OBSERVE
// the run as it drains. Read-only on disconnect: it steers but never closes the app.
//
// Usage:
//   node scripts/drive.mjs --project drive-test --goal "Build a tiny Python CLI…" --folder C:\path\to\work
//   node scripts/drive.mjs            # sensible defaults (small CLI task)

import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let port = 9222
let project = 'drive-test'
let goal = 'Build a tiny Python CLI that greets a name passed as an argument. Include one pytest test. Keep it minimal — no extra features.'
let folder = ''
let out = path.join(root, '_shots', 'drive.png')
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--port') port = parseInt(argv[++i], 10)
  else if (a === '--project') project = argv[++i]
  else if (a === '--goal') goal = argv[++i]
  else if (a === '--folder') folder = argv[++i]
  else if (a === '--out') { const v = argv[++i]; out = path.isAbsolute(v) ? v : path.join(root, v) }
  else { console.error(`Unknown option: ${a}`); process.exit(2) }
}
mkdirSync(path.dirname(out), { recursive: true })

const endpoint = `http://127.0.0.1:${port}`
let browser
try {
  browser = await chromium.connectOverCDP(endpoint)
} catch {
  console.error(`Could not reach CDP at ${endpoint}. Launch with: pwsh ./scripts/launch-debug.ps1`)
  process.exit(1)
}

// Find the renderer page (peek's scoring: real NordCode window, not DevTools / blank / the Preview webview).
const pages = browser.contexts().flatMap((c) => c.pages())
let page = null
let bestScore = -1
for (const p of pages) {
  const url = p.url()
  if (url.startsWith('devtools://') || url === 'about:blank') continue
  let title = ''
  try { title = await p.title() } catch { /* navigating */ }
  const s = title === 'NordCode' ? 3 : url.includes('index.html') ? 2 : url.startsWith('file://') ? 1 : 0
  if (s > bestScore) { bestScore = s; page = p }
}
if (!page) { console.error('No NordCode renderer page found over CDP.'); await browser.close(); process.exit(1) }

const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

try {
  // 1) Optionally pin the working folder (so the project lands in a known place) — via the same IPC the UI uses.
  if (folder) {
    mkdirSync(folder, { recursive: true })
    await page.evaluate(async (f) => { await window.api.settings.set({ lastCwd: f }) }, folder)
    console.log('set working folder →', folder)
  }

  // 2) Hermes view.
  await page.getByRole('tab', { name: 'Hermes', exact: true }).click()
  await page.waitForTimeout(400)

  // 3) New raid → name → Create.
  await page.getByRole('button', { name: /new raid/i }).click()
  await page.getByPlaceholder(/project name/i).fill(project)
  await page.getByRole('button', { name: /^create$/i }).click()
  await page.waitForTimeout(800)
  console.log('created raid →', project)

  // 4) Hand Brooke the goal.
  await page.getByPlaceholder(/message brooke/i).fill(goal)
  await page.getByRole('button', { name: /^send$/i }).click()
  console.log('sent goal to Brooke')
  await page.waitForTimeout(2000)

  await page.screenshot({ path: out })
  console.log('screenshot →', out)
} catch (e) {
  // On a selector miss, dump the visible buttons/placeholders so the selectors can be fixed, + a screenshot.
  console.error('drive error:', e?.message || e)
  const btns = await page.getByRole('button').allInnerTexts().catch(() => [])
  console.error('buttons on page:', JSON.stringify(btns.slice(0, 30)))
  await page.screenshot({ path: out }).catch(() => {})
  console.error('(screenshot of the failure state →', out, ')')
} finally {
  await browser.close() // disconnect only — the app keeps running
}
if (errors.length) { console.log('\nRenderer console errors:'); for (const e of errors) console.log('  ✗ ' + e) }
