// Smoke-test a rendered demo video in Electron's Chromium media pipeline and capture key frames.

import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const input = path.resolve(root, process.argv[2] || 'artifacts/nordcode-feature-tour.mp4')
const outDir = path.resolve(root, process.argv[3] || '_recording/verification')
const profile = mkdtempSync(path.join(tmpdir(), 'nordcode-video-verify-'))
mkdirSync(outDir, { recursive: true })
let app

try {
  app = await electron.launch({ args: [path.join(root, 'out/main/index.js'), `--user-data-dir=${profile}`], cwd: root })
  const page = await app.firstWindow()
  const metadata = await page.evaluate(async (src) => {
    document.body.innerHTML = ''
    document.body.style.cssText = 'margin:0;background:#000;display:grid;place-items:center;overflow:hidden'
    const video = document.createElement('video')
    video.src = src
    video.muted = true
    video.style.cssText = 'width:100vw;height:100vh;object-fit:contain'
    document.body.appendChild(video)
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve
      video.onerror = () => reject(new Error(video.error?.message || 'Video failed to load'))
    })
    await video.play()
    await new Promise((resolve) => setTimeout(resolve, 400))
    video.pause()
    return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, advancedTo: video.currentTime }
  }, pathToFileURL(input).href)

  for (const second of [2, 21, 34, 41]) {
    await page.evaluate(async (time) => {
      const video = document.querySelector('video')
      await new Promise((resolve) => {
        video.addEventListener('seeked', resolve, { once: true })
        video.currentTime = Math.min(time, video.duration - 0.1)
      })
    }, second)
    await page.screenshot({ path: path.join(outDir, `second-${second}.jpg`), type: 'jpeg', quality: 88 })
  }
  console.log(JSON.stringify({ input, ...metadata, screenshots: outDir }))
} finally {
  if (app) await app.close().catch(() => {})
  rmSync(profile, { recursive: true, force: true })
}
