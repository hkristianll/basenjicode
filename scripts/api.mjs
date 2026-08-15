// Evaluate a JS expression in the LIVE NordCode renderer over CDP and print the JSON result.
// Handy for reading/poking window.api against the running app (launched via launch-debug.ps1) without the UI.
//
// Usage:
//   node scripts/api.mjs "window.api.settings.get()"
//   node scripts/api.mjs "window.api.settings.set({ loopWorkerConnectionId: 'abc' })"
//   node scripts/api.mjs --port 9333 "window.api.hermes.message({ project:'p', text:'go' })"
//
// The expression is awaited and JSON-serialized. Read/steer only — never closes the app.

import { chromium } from 'playwright-core'

let port = 9222
const exprParts = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') port = parseInt(argv[++i], 10)
  else exprParts.push(argv[i])
}
const expr = exprParts.join(' ')
if (!expr) { console.error('Usage: node scripts/api.mjs "<js expression>"'); process.exit(2) }

const endpoint = `http://127.0.0.1:${port}`
let browser
try {
  browser = await chromium.connectOverCDP(endpoint)
} catch {
  console.error(`Could not reach CDP at ${endpoint}. Launch with: pwsh ./scripts/launch-debug.ps1`)
  process.exit(1)
}
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

try {
  const result = await page.evaluate(`(async () => { return (${expr}) })()`)
  console.log(JSON.stringify(result, null, 2))
} catch (e) {
  console.error('eval error:', e?.message || e)
  process.exitCode = 1
} finally {
  await browser.close()
}
