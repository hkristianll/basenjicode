// NordCode E2E — folder-unify regression test (Playwright `_electron`, no model needed).
//
// Why this exists: this session hit a bug where a NEW project's work landed inside a PREVIOUS project's
// folder, because the work folder was derived from a STALE "Hermes projects root" instead of the single
// working folder the UI shows. The fix unified them — projectWorkFolder derives <workingFolder>/<project>
// from the live `lastCwd`. Screenshots (shot.mjs/peek.mjs) can't prove WHERE work lands; this can.
//
// It launches the real built app in an ISOLATED user-data profile, sets the working folder (lastCwd) to a
// controlled temp dir AND a DIFFERENT stale hermesProjectsRoot, then triggers the work-folder derivation via
// a light IPC (hermes.teamMemory → brookeCwd → mkdir — no decompose, no model). The assertion: the project
// folder is created under lastCwd, and NOT under the stale root. Deterministic + fast.
//
// Usage:
//   node scripts/e2e-folder.mjs              # build, then run
//   node scripts/e2e-folder.mjs --skip-build # reuse existing out/ (fast)
//   node scripts/e2e-folder.mjs --keep-profile
// Exits 0 on PASS, 1 on FAIL — so it can gate CI / a pre-commit check.

import { _electron as electron } from 'playwright-core'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = path.join(root, 'out', 'main', 'index.js')

const argv = process.argv.slice(2)
const skipBuild = argv.includes('--skip-build')
const keepProfile = argv.includes('--keep-profile')

if (!skipBuild) {
  console.log('› building (electron-vite build)…')
  execSync('npm run build', { cwd: root, stdio: 'inherit', shell: true })
} else if (!existsSync(mainEntry)) {
  console.error('No build at out/main/index.js and --skip-build given. Run without --skip-build first.')
  process.exit(1)
}

// Isolated profile (clean settings) + two distinct work roots.
const profileDir = mkdtempSync(path.join(tmpdir(), 'nce2e-profile-'))
const workDir = mkdtempSync(path.join(tmpdir(), 'nce2e-work-')) // the UNIFIED working folder (lastCwd)
const staleDir = mkdtempSync(path.join(tmpdir(), 'nce2e-stale-')) // a DIFFERENT, stale hermesProjectsRoot
// Mixed case + space → also exercises canonicalize/projectFolder (lowercases, collapses spaces).
const PROJECT = 'E2E Folder Test'
const expectedFolderName = 'e2e folder test' // canonicalizeProject(PROJECT) → projectFolder

let electronApp
const failures = []
try {
  electronApp = await electron.launch({ args: [mainEntry, `--user-data-dir=${profileDir}`], cwd: root })
  const page = await electronApp.firstWindow()
  await page.waitForFunction(() => !!(window.api && window.api.settings && window.api.hermes), null, { timeout: 20000 })

  // (1) Unified working folder = workDir, AND a different stale projects root. The fix must use lastCwd.
  await page.evaluate(async (p) => {
    await window.api.settings.set({ lastCwd: p.workDir, hermesProjectsRoot: p.staleDir })
  }, { workDir, staleDir })

  // (2) Trigger the work-folder derivation (brookeCwd → projectWorkFolder → mkdir) via a light IPC — no model.
  await page.evaluate(async (project) => {
    await window.api.hermes.teamMemory({ project, dept: 'implementation' })
  }, PROJECT)

  // (3) Assert the project folder is under the UNIFIED working folder, NOT the stale root.
  const inWork = existsSync(path.join(workDir, expectedFolderName))
  const inStale = existsSync(path.join(staleDir, expectedFolderName))
  if (!inWork) failures.push(`work folder NOT created at the working folder: ${path.join(workDir, expectedFolderName)}`)
  if (inStale) failures.push(`work folder WRONGLY created under the stale projects root: ${path.join(staleDir, expectedFolderName)}`)
} catch (e) {
  failures.push(`error: ${e?.message || e}`)
} finally {
  if (electronApp) await electronApp.close().catch(() => {})
  if (!keepProfile) {
    for (const d of [profileDir, workDir, staleDir]) rmSync(d, { recursive: true, force: true })
  }
}

if (failures.length === 0) {
  console.log('\n✓ PASS — a new project resolves to <workingFolder>/<project> (lastCwd), ignoring the stale projects root.')
  process.exit(0)
}
console.log('\n✗ FAIL — folder-unify E2E:')
for (const f of failures) console.log('  • ' + f)
process.exit(1)
