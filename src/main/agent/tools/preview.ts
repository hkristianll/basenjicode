import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import type { ToolDef } from '../registry'
import type { ToolPreview } from '../../../shared/ipc-types'
import { previewService, type ConsoleLine } from '../../preview'
import { isBlockedHostForPreview } from '../../web-util'

const NO_PREVIEW =
  'No live preview is open. Start the dev server with run_background, then call preview_open with its URL ' +
  '(e.g. http://localhost:5173) before using this tool.'

/** Tools that take no arguments share one empty schema. */
const emptySchema = z.object({})

function fmtConsole(lines: ConsoleLine[]): string {
  if (!lines.length) return '(no console output captured)'
  return lines
    .map((l) => {
      const tag = l.level.toUpperCase().padEnd(7)
      return `${tag} ${l.message}`
    })
    .join('\n')
}

const openSchema = z.object({
  url: z
    .string()
    .min(1)
    .describe('URL of the local dev server to load, e.g. http://localhost:5173. Defaults to http:// if no scheme.')
})

const openPreview: ToolDef<typeof openSchema> = {
  name: 'preview_open',
  description:
    'Open the Preview panel and load a URL (your local dev server) in it. Use this to start verifying a web change. ' +
    'Returns the resolved URL, page title, and any load error. Run the dev server with run_background first.',
  schema: openSchema,
  mutating: false,
  preview(args): ToolPreview {
    return { kind: 'text', text: `Open preview → ${args.url}` }
  },
  async handler(args) {
    const url = /^https?:\/\//i.test(args.url) ? args.url : `http://${args.url}`
    // The preview <webview> can run JS and be read back via preview_eval/snapshot — so loading an
    // arbitrary URL is an SSRF/exfil vector. Allow loopback (the point of the panel: local dev
    // servers) but refuse LAN-private/link-local hosts and non-http(s) schemes.
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return `ERROR: invalid URL: ${args.url}`
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'ERROR: only http(s) URLs can be previewed.'
    if (isBlockedHostForPreview(u.hostname)) {
      return `ERROR: refusing to preview a private/LAN host (${u.hostname}). Previews are for your local dev server (localhost).`
    }
    const { info, registered, loadError } = await previewService.open(url)
    if (!registered) {
      return `Asked the UI to open the preview at ${url}, but it did not report back in time. The Preview panel may be opening — try preview_console or preview_snapshot in a moment.`
    }
    const lines = [`Preview loaded: ${info.url}`, `Title: ${info.title || '(none)'}`]
    if (loadError) lines.push(`Load error: ${loadError}`)
    return lines.join('\n')
  }
}

const reloadPreview: ToolDef<typeof emptySchema> = {
  name: 'preview_reload',
  description: 'Reload the current page in the Preview panel (e.g. after editing source when there is no hot-reload).',
  schema: emptySchema,
  mutating: false,
  async handler() {
    if (!previewService.hasGuest()) return NO_PREVIEW
    const { info, loadError } = await previewService.reload()
    return loadError ? `Reloaded ${info.url} with a load error: ${loadError}` : `Reloaded ${info.url} (title: ${info.title || '(none)'}).`
  }
}

const consoleSchema = z.object({
  level: z
    .enum(['debug', 'log', 'info', 'warning', 'error'])
    .optional()
    .describe('Only return messages at this level or higher (error > warning > info/log > debug).'),
  clear: z.boolean().optional().describe('Clear the captured console buffer after reading.')
})

const previewConsole: ToolDef<typeof consoleSchema> = {
  name: 'preview_console',
  description:
    'Read console messages (logs, warnings, errors) captured from the previewed page. The first thing to check ' +
    'after loading or reloading — runtime errors and failed requests show up here.',
  schema: consoleSchema,
  mutating: false,
  async handler(args) {
    if (!previewService.hasGuest()) return NO_PREVIEW
    const lines = previewService.consoleLines({ clear: args.clear, level: args.level })
    const errs = lines.filter((l) => l.level === 'error').length
    const header = `${lines.length} message(s)${args.level ? ` at level ≥ ${args.level}` : ''}${errs ? `, ${errs} error(s)` : ''}:`
    return `${header}\n${fmtConsole(lines)}`
  }
}

const snapshotPreview: ToolDef<typeof emptySchema> = {
  name: 'preview_snapshot',
  description:
    'Capture a compact text snapshot of the previewed page: URL, title, headings, links, buttons, inputs, and visible ' +
    'text. Use this to confirm the rendered content/structure without a screenshot.',
  schema: emptySchema,
  mutating: false,
  async handler() {
    if (!previewService.hasGuest()) return NO_PREVIEW
    const json = await previewService.snapshot()
    try {
      const o = JSON.parse(json) as Record<string, unknown>
      const part = (label: string, v: unknown): string => {
        if (Array.isArray(v)) return v.length ? `${label}:\n  - ${v.join('\n  - ')}` : ''
        return v ? `${label}: ${String(v)}` : ''
      }
      return [
        part('URL', o.url),
        part('Title', o.title),
        part('Headings', o.headings),
        part('Buttons', o.buttons),
        part('Links', o.links),
        part('Inputs', o.inputs),
        o.text ? `Visible text:\n${String(o.text)}` : ''
      ]
        .filter(Boolean)
        .join('\n\n')
    } catch {
      return json
    }
  }
}

const evalSchema = z.object({
  code: z
    .string()
    .min(1)
    .describe('JavaScript run as an async function body in the page. Use `return` to return a JSON-serializable value.')
})

const evalPreview: ToolDef<typeof evalSchema> = {
  name: 'preview_eval',
  description:
    'Evaluate JavaScript in the previewed page and return the result. Runs as an async function body — use `return` ' +
    "to get a value back (e.g. return document.querySelector('h1')?.textContent). For asserting specific DOM state or " +
    'reading computed values during verification.',
  schema: evalSchema,
  mutating: false,
  preview(args): ToolPreview {
    return { kind: 'text', text: args.code }
  },
  async handler(args) {
    if (!previewService.hasGuest()) return NO_PREVIEW
    return await previewService.evaluate(args.code)
  }
}

const screenshotPreview: ToolDef<typeof emptySchema> = {
  name: 'preview_screenshot',
  description:
    'Capture a PNG of the previewed page AND attach it for YOU to see — use this to VISUALLY REVIEW how the app ' +
    'actually looks (layout, art, colors, depth, polish), e.g. to judge a UI or game against its intended design and ' +
    'route concrete look-gaps. Needs a vision-capable model to see the image; returns the saved path + dimensions too.',
  schema: emptySchema,
  mutating: false,
  async handler(_args, ctx) {
    if (!previewService.hasGuest()) return NO_PREVIEW
    const { path, width, height } = await previewService.screenshot()
    // Feed the image back to the model (toModel) so a vision worker can actually SEE the rendered result and judge it.
    try {
      const b64 = (await readFile(path)).toString('base64')
      ctx.attachImages?.([`data:image/png;base64,${b64}`], { toModel: true })
    } catch {
      /* if the read fails, the path below still lets the user open it */
    }
    return `Captured a ${width}×${height} screenshot (${path}) and attached it above for your visual review.`
  }
}

export const previewTools: ToolDef[] = [
  openPreview as ToolDef,
  reloadPreview as ToolDef,
  previewConsole as ToolDef,
  snapshotPreview as ToolDef,
  evalPreview as ToolDef,
  screenshotPreview as ToolDef
]
