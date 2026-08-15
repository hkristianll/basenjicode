// Attach to a running NordCode (launched with --remote-debugging-port via scripts/launch-debug.ps1)
// over Chrome DevTools Protocol and screenshot the LIVE renderer — your actual session and state.
// Read-only: it captures and disconnects, never closing or steering the app.
//
// Usage:
//   npm run peek                 # → _shots/peek.png
//   npm run peek -- --port 9333
//   npm run peek -- --out bug.png
//   npm run peek -- --wait 1500  # listen this long for console errors before capturing

import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let port = 9222
let out = path.join(root, '_shots', 'peek.png')
let waitMs = 600
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--port') port = parseInt(argv[++i], 10)
  else if (a === '--wait') waitMs = parseInt(argv[++i], 10)
  else if (a === '--out') {
    const v = argv[++i]
    out = path.isAbsolute(v) ? v : path.join(root, v)
  } else {
    console.error(`Unknown option: ${a}`)
    process.exit(2)
  }
}
mkdirSync(path.dirname(out), { recursive: true })

const endpoint = `http://127.0.0.1:${port}`
let browser
try {
  browser = await chromium.connectOverCDP(endpoint)
} catch {
  console.error(`Could not reach NordCode's CDP endpoint at ${endpoint}.`)
  console.error('Launch the app with remote debugging first:')
  console.error('  pwsh ./scripts/launch-debug.ps1        (installed build)')
  console.error('  pwsh ./scripts/launch-debug.ps1 -Dev   (electron-vite dev)')
  process.exit(1)
}

// Pick the main renderer page — skip the DevTools target, blank tabs, and the Preview panel <webview>
// guest. Score by: exact title, then index.html in the URL, then a file:// page.
const pages = browser.contexts().flatMap((c) => c.pages())
let best = null
let bestScore = -1
for (const p of pages) {
  const url = p.url()
  if (url.startsWith('devtools://') || url === 'about:blank') continue
  let title = ''
  try { title = await p.title() } catch { /* page may be navigating */ }
  const s = title === 'NordCode' ? 3 : url.includes('index.html') ? 2 : url.startsWith('file://') ? 1 : 0
  if (s > bestScore) { bestScore = s; best = p }
}

if (!best) {
  console.error('Connected to the CDP endpoint but found no NordCode renderer page. Open targets:')
  for (const p of pages) console.error('  - ' + (p.url() || '(blank)'))
  await browser.close()
  process.exit(1)
}

const errors = []
best.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
best.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
await best.waitForTimeout(waitMs) // sample window: catch errors firing right now
await best.screenshot({ path: out })
await browser.close() // disconnect only — the app keeps running

console.log('Wrote: ' + out)
console.log('Page:  ' + best.url())
if (errors.length) {
  console.log('\nRenderer console errors:')
  for (const e of errors) console.log('  ✗ ' + e)
} else {
  console.log('\nNo renderer console errors in the sample window.')
}
