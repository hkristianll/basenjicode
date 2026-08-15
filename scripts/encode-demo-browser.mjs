// Encode a timestamped screenshot manifest with Chromium's native MediaRecorder.
// This avoids requiring a system ffmpeg install and produces MP4 when Chromium supports it,
// otherwise a broadly playable WebM.

import { _electron as electron } from 'playwright-core'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = path.join(root, 'out', 'main', 'index.js')
const argv = process.argv.slice(2)
if (argv.length < 2) {
  console.error('Usage: node scripts/encode-demo-browser.mjs <manifest.json> <output-without-extension>')
  process.exit(2)
}
const manifestPath = path.resolve(root, argv[0])
const outputBase = path.resolve(root, argv[1]).replace(/\.(mp4|webm)$/i, '')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const frameUrls = manifest.frames.map((frame) => ({ ...frame, url: pathToFileURL(path.join(path.dirname(manifestPath), frame.file)).href }))
const profileDir = mkdtempSync(path.join(tmpdir(), 'nordcode-video-encode-'))
const chunks = []
let app

try {
  app = await electron.launch({ args: [mainEntry, `--user-data-dir=${profileDir}`], cwd: root })
  const page = await app.firstWindow()
  await page.exposeFunction('__nordcodeVideoChunk', (base64) => chunks.push(Buffer.from(base64, 'base64')))

  const result = await page.evaluate(async ({ frames, durationMs, width, height }) => {
    const mime = [
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm'
    ].find((type) => MediaRecorder.isTypeSupported(type))
    if (!mime) throw new Error('This Chromium build exposes no supported MediaRecorder video format.')

    document.body.innerHTML = ''
    document.body.style.cssText = 'margin:0;overflow:hidden;background:#09090b;display:grid;place-items:center'
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.style.cssText = 'width:100vw;height:100vh;object-fit:contain'
    document.body.appendChild(canvas)
    const ctx = canvas.getContext('2d', { alpha: false })
    const stream = canvas.captureStream(24)
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 })
    const pendingChunks = []
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return
      pendingChunks.push((async () => {
        const bytes = new Uint8Array(await event.data.arrayBuffer())
        let binary = ''
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
        await window.__nordcodeVideoChunk(btoa(binary))
      })())
    }
    const stopped = new Promise((resolve) => recorder.addEventListener('stop', resolve, { once: true }))

    const load = (url) => new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = reject
      image.src = url
    })

    let sourceIndex = 0
    let image = await load(frames[0].url)
    ctx.drawImage(image, 0, 0, width, height)
    recorder.start(1000)
    const start = performance.now()
    const outputFrames = Math.ceil(durationMs / 1000 * 24)
    for (let outputIndex = 0; outputIndex < outputFrames; outputIndex += 1) {
      const targetMs = outputIndex * 1000 / 24
      while (sourceIndex + 1 < frames.length && frames[sourceIndex + 1].t <= targetMs) sourceIndex += 1
      const nextUrl = frames[sourceIndex].url
      if (image.src !== nextUrl) image = await load(nextUrl)
      ctx.drawImage(image, 0, 0, width, height)
      const wait = start + (outputIndex + 1) * 1000 / 24 - performance.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    }
    recorder.stop()
    await stopped
    await Promise.all(pendingChunks)
    return { mime, outputFrames }
  }, { frames: frameUrls, durationMs: manifest.durationMs, width: manifest.width, height: manifest.height })

  const extension = result.mime.startsWith('video/mp4') ? '.mp4' : '.webm'
  const output = outputBase + extension
  writeFileSync(output, Buffer.concat(chunks))
  console.log(JSON.stringify({ output, mime: result.mime, frames: result.outputFrames, bytes: chunks.reduce((n, c) => n + c.length, 0) }))
} finally {
  if (app) await app.close().catch(() => {})
  rmSync(profileDir, { recursive: true, force: true })
}
