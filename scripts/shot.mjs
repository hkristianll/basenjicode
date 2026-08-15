// NordCode screenshot harness — launches the real Electron app via Playwright, switches between the
// Chat / Raid / Hermes views (and optionally Settings), and writes a PNG per view to _shots/.
//
// Why this exists: an Electron renderer is a Chromium page that browser-attached tools can't reach.
// Playwright's _electron launches the actual app (real main process, real preload/IPC, loads the built
// out/renderer/index.html) so the screenshots are faithful to what ships — not an approximation served
// off the Vite dev URL.
//
// Usage:
//   node scripts/shot.mjs                      # build, then shoot chat + raid + hermes (dark)
//   node scripts/shot.mjs raid --theme light   # one view, light theme
//   node scripts/shot.mjs all                  # chat raid hermes settings
//   node scripts/shot.mjs chat --skip-build    # reuse existing out/ (fast iteration)
//   node scripts/shot.mjs --width 1440 --height 900
//
// Options:
//   --out <dir>     output directory (default: _shots)
//   --theme <t>     light | dark   (default: dark)
//   --skip-build    reuse the existing out/ instead of running electron-vite build
//   --width <n>     window content width  (default: 1280, min 900)
//   --height <n>    window content height (default: 860,  min 540)
//   --keep-profile  keep the temp user-data dir (for debugging)
//
// The script prints the absolute path of every PNG it writes, plus any renderer console errors.

import { _electron as electron } from 'playwright-core'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- arg parsing -----------------------------------------------------------
const argv = process.argv.slice(2)
const opts = { out: '_shots', theme: 'dark', build: true, width: 1280, height: 860, keepProfile: false }
const views = []
const VIEW_TABS = {
  chat: 'Chat',
  runs: 'Mission',
  run: 'Mission',
  raid: 'Mission',
  loop: 'Mission',
  planner: 'Planner',
  hermes: 'Planner',
  needs: null,
  preview: null,
  settings: null
}

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--out') opts.out = argv[++i]
  else if (a === '--theme') opts.theme = argv[++i]
  else if (a === '--skip-build') opts.build = false
  else if (a === '--width') opts.width = Math.max(900, parseInt(argv[++i], 10))
  else if (a === '--height') opts.height = Math.max(540, parseInt(argv[++i], 10))
  else if (a === '--keep-profile') opts.keepProfile = true
  else if (a === 'all') views.push('chat', 'runs', 'planner', 'needs', 'preview', 'settings')
  else if (a in VIEW_TABS) views.push(canonicalView(a))
  else {
    console.error(`Unknown view/option: ${a}`)
    process.exit(2)
  }
}
if (views.length === 0) views.push('chat', 'runs', 'planner')
const uniqueViews = [...new Set(views)]

function canonicalView(view) {
  if (view === 'raid' || view === 'loop' || view === 'run') return 'runs'
  if (view === 'hermes') return 'planner'
  return view
}

// ---- build -----------------------------------------------------------------
const mainEntry = path.join(root, 'out', 'main', 'index.js')
if (opts.build) {
  console.log('› building (electron-vite build)…')
  execSync('npm run build', { cwd: root, stdio: 'inherit', shell: true })
} else if (!existsSync(mainEntry)) {
  console.error('No build found at out/main/index.js and --skip-build was given. Run without --skip-build first.')
  process.exit(1)
}

const outDir = path.isAbsolute(opts.out) ? opts.out : path.join(root, opts.out)
mkdirSync(outDir, { recursive: true })
const profileDir = mkdtempSync(path.join(tmpdir(), 'ncshot-'))

// ---- launch ----------------------------------------------------------------
const consoleErrors = []
let electronApp
const written = []
try {
  electronApp = await electron.launch({
    args: [mainEntry, `--user-data-dir=${profileDir}`],
    cwd: root
  })

  const page = await electronApp.firstWindow()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

  // Force the (show:false) window visible and to a deterministic content size, then wait for React.
  await electronApp.evaluate(({ BrowserWindow }, { w, h }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    win.setContentSize(w, h)
    win.show()
    win.focus()
  }, { w: opts.width, h: opts.height })

  await page.waitForSelector('.topbar', { state: 'visible', timeout: 20000 })
  // Force theme for a deterministic capture (CSS keys off documentElement.dataset.theme).
  await page.evaluate((t) => { document.documentElement.dataset.theme = t }, opts.theme)
  await page.waitForTimeout(300)

  const selectWorkspaceTab = async (label) => {
    const tab = page.getByRole('tab', { name: label, exact: true })
    if (!(await tab.isVisible())) {
      await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
      await tab.waitFor({ state: 'visible' })
    }
    await tab.click()
    if (opts.width <= 1050) {
      const collapse = page.getByRole('button', { name: 'Collapse sidebar', exact: true })
      if (await collapse.isVisible()) await collapse.click()
    }
  }

  const openPanel = async (label) => {
    const direct = page.getByRole('button', { name: label, exact: true })
    if (await direct.isVisible()) {
      await direct.click()
      return
    }
    await page.getByRole('button', { name: 'Open workspace panels', exact: true }).click()
    await page.getByRole('menuitem', { name: label, exact: true }).click()
  }

  for (const view of uniqueViews) {
    if (view === 'settings') {
      await page.keyboard.press('Control+K')
      await page.getByText('Open settings', { exact: true }).click()
      await page.waitForSelector('.modal, [role="dialog"]', { state: 'visible', timeout: 5000 }).catch(() => {})
    } else if (view === 'needs') {
      await openPanel('Needs Me')
      await page.waitForSelector('.needs-panel', { state: 'visible', timeout: 5000 })
    } else if (view === 'preview') {
      await openPanel('Preview')
      await page.waitForSelector('.preview-panel', { state: 'visible', timeout: 5000 })
      await page.waitForSelector('.preview-stage.ready, .preview-stage.error', { state: 'visible', timeout: 8000 }).catch(() => {})
    } else {
      const tabName = VIEW_TABS[view]
      await selectWorkspaceTab(tabName)
    }
    await page.waitForTimeout(450) // let the view transition + fonts settle
    const file = path.join(outDir, `${view}-${opts.theme}.png`)
    await page.screenshot({ path: file })
    written.push(file)
    if (view === 'settings') {
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(150)
    } else if (view === 'needs' || view === 'preview') {
      await page.getByRole('button', { name: 'Close panel', exact: true }).click().catch(() => {})
      await page.waitForTimeout(150)
    }
  }
} finally {
  if (electronApp) await electronApp.close().catch(() => {})
  if (!opts.keepProfile) rmSync(profileDir, { recursive: true, force: true })
}

// ---- report ----------------------------------------------------------------
console.log('\nWrote:')
for (const f of written) console.log('  ' + f)
if (consoleErrors.length) {
  console.log('\nRenderer console errors:')
  for (const e of consoleErrors) console.log('  ✗ ' + e)
} else {
  console.log('\nNo renderer console errors.')
}
