import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { ImageConfig } from '../../../shared/domain-types'
import { classifyHost } from '../../web-util'

/** Raised on any image-backend failure with a user-actionable message (surfaced as the tool's ERROR). */
export class ImageGenError extends Error {}

export interface GenOpts {
  prompt: string
  negativePrompt?: string
  size?: string
  count: number
  /** Per-call model override (the generate_image `model` arg) — a UNET filename; wins over the Settings model. */
  modelOverride?: string
}

/** Options for a single text-to-video generation (Wan 2.2). */
export interface VideoOpts {
  prompt: string
  negativePrompt?: string
  size?: string
  seconds?: number
  steps?: number
  seed?: number
}

const GEN_TIMEOUT_MS = 300_000 // image generation is slow; allow up to 5 minutes (abortable)

// ---- pure helpers (unit-tested) ----

/** Parse "WxH" into dimensions, clamped to sane bounds; falls back to 1024×1024. */
export function parseSize(size: string | undefined, fallback = 1024): { width: number; height: number } {
  const m = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec((size ?? '').trim())
  const clamp = (n: number): number => Math.min(4096, Math.max(64, n))
  if (!m) return { width: fallback, height: fallback }
  return { width: clamp(Number(m[1])), height: clamp(Number(m[2])) }
}

/** A filesystem-safe slug from the prompt for default filenames. */
export function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'image'
}

export function buildA1111Body(cfg: ImageConfig, o: GenOpts): Record<string, unknown> {
  const { width, height } = parseSize(o.size || cfg.size)
  const body: Record<string, unknown> = {
    prompt: o.prompt,
    negative_prompt: o.negativePrompt ?? '',
    steps: cfg.steps > 0 ? cfg.steps : 28,
    width,
    height,
    batch_size: Math.max(1, Math.min(8, o.count))
  }
  if (cfg.model.trim()) body.override_settings = { sd_model_checkpoint: cfg.model.trim() }
  return body
}

/** A1111 txt2img returns { images: ["<raw base64 png>", ...] } (no data: prefix). */
export function extractA1111Base64(json: unknown): string[] {
  const imgs = (json as { images?: unknown })?.images
  if (!Array.isArray(imgs)) return []
  return imgs.filter((x): x is string => typeof x === 'string' && x.length > 0).map((x) => x.replace(/^data:image\/\w+;base64,/, ''))
}

export function buildOpenAIBody(cfg: ImageConfig, o: GenOpts): Record<string, unknown> {
  // Note: gpt-image-1 rejects response_format, so we never send it and accept b64_json OR url back.
  return {
    model: cfg.model.trim() || 'gpt-image-1',
    prompt: o.prompt,
    n: Math.max(1, Math.min(8, o.count)),
    size: (o.size || cfg.size || '1024x1024').replace(/×/g, 'x')
  }
}

/** OpenAI images response: { data: [{ b64_json } | { url }] }. */
export function extractOpenAIImages(json: unknown): { b64?: string; url?: string }[] {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  const out: { b64?: string; url?: string }[] = []
  for (const d of data) {
    const o = d as { b64_json?: unknown; url?: unknown }
    if (typeof o.b64_json === 'string') out.push({ b64: o.b64_json })
    else if (typeof o.url === 'string') out.push({ url: o.url })
  }
  return out
}

// ---- FLUX.2-klein companion files (fast, but weak at in-image text) ----
const FLUX2_CLIP = 'qwen_3_4b.safetensors'
const FLUX2_VAE = 'flux2-vae.safetensors'
export const FLUX2_DEFAULT_UNET = 'flux-2-klein-4b-fp8.safetensors'

// ---- Qwen-Image companion files (slower, but renders legible in-image text — the default) ----
const QWEN_CLIP = 'qwen_2.5_vl_7b_fp8_scaled.safetensors'
const QWEN_VAE = 'qwen_image_vae.safetensors'
export const QWEN_DEFAULT_UNET = 'qwen_image_2512_fp8_e4m3fn.safetensors'
const QWEN_LIGHTNING_LORA = 'Qwen-Image-Lightning-8steps-V2.0.safetensors'

// ---- Z-Image-Turbo (Apache 2.0, fast 6B) — the no-text/fast tier. Reuses the qwen_3_4b encoder. ----
export const ZIMAGE_DEFAULT_UNET = 'z-image-turbo-fp8-e4m3fn.safetensors'
const ZIMAGE_VAE = 'z_image_ae.safetensors'

// ---- Wan 2.2 14B text-to-video (Apache 2.0). MoE: high-noise + low-noise experts; needs the full 24GB. ----
export const WAN_T2V_HIGH = 'wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors'
export const WAN_T2V_LOW = 'wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors'
const WAN_CLIP = 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'
const WAN_VAE = 'wan_2.1_vae.safetensors'

/** Route by model filename: Qwen-Image, Z-Image-Turbo, or (default) FLUX.2-klein — each needs a different graph. */
const isQwenImage = (model: string): boolean => /qwen[_-]?image/i.test(model)
const isZImage = (model: string): boolean => /z[_-]?image/i.test(model)

/**
 * Build the ComfyUI prompt graph for the configured diffusion model. Qwen-Image, Z-Image-Turbo, and
 * FLUX.2-klein each need a different node graph, so dispatch on the model name. Returns the graph +
 * the SaveImage node id to read.
 */
export function buildComfyWorkflow(
  cfg: ImageConfig,
  o: GenOpts,
  unet: string,
  seed: number
): { graph: Record<string, unknown>; outNode: string } {
  if (isQwenImage(unet)) return buildQwenImageWorkflow(cfg, o, unet, seed)
  if (isZImage(unet)) return buildZImageWorkflow(cfg, o, unet, seed)
  return buildFluxKleinWorkflow(cfg, o, unet, seed)
}

/**
 * Z-Image-Turbo text-to-image graph (ComfyUI's official template). A fast 6B Apache-2.0 turbo model —
 * good general quality with basic text — at ~8 steps, cfg 1. Uses CLIPLoader(type=lumina2) over the
 * shared qwen_3_4b encoder, ModelSamplingAuraFlow (shift 3), and the res_multistep sampler.
 */
export function buildZImageWorkflow(
  cfg: ImageConfig,
  o: GenOpts,
  unet: string,
  seed: number
): { graph: Record<string, unknown>; outNode: string } {
  const { width, height } = parseSize(o.size || cfg.size)
  const steps = cfg.steps > 0 ? cfg.steps : 8
  const graph: Record<string, unknown> = {
    '10': { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
    '11': { class_type: 'CLIPLoader', inputs: { clip_name: FLUX2_CLIP, type: 'lumina2', device: 'default' } },
    '12': { class_type: 'VAELoader', inputs: { vae_name: ZIMAGE_VAE } },
    '13': { class_type: 'CLIPTextEncode', inputs: { clip: ['11', 0], text: o.prompt } },
    '14': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['13', 0] } },
    '15': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['10', 0], shift: 3 } },
    '16': {
      class_type: 'EmptySD3LatentImage',
      inputs: { width, height, batch_size: Math.max(1, Math.min(8, o.count)) }
    },
    '17': {
      class_type: 'KSampler',
      inputs: {
        model: ['15', 0],
        positive: ['13', 0],
        negative: ['14', 0],
        latent_image: ['16', 0],
        seed,
        steps,
        cfg: 1,
        sampler_name: 'res_multistep',
        scheduler: 'simple',
        denoise: 1
      }
    },
    '18': { class_type: 'VAEDecode', inputs: { samples: ['17', 0], vae: ['12', 0] } },
    '19': { class_type: 'SaveImage', inputs: { filename_prefix: 'nordcode', images: ['18', 0] } }
  }
  return { graph, outNode: '19' }
}

/**
 * Qwen-Image text-to-image graph (ComfyUI's official template). Qwen renders legible in-image text,
 * so it's the default. It needs CLIPLoader(type=qwen_image), an EmptySD3LatentImage, and a
 * ModelSamplingAuraFlow (shift 3.1) before the sampler. By default (≤12 steps) it runs the distilled
 * 8-step Lightning LoRA at cfg 1 for speed; set steps > 12 in Settings to drop the LoRA and run the
 * full-quality cfg-4 pass. Real negative prompts apply in the cfg-4 path. Returns the graph + outNode.
 */
export function buildQwenImageWorkflow(
  cfg: ImageConfig,
  o: GenOpts,
  unet: string,
  seed: number
): { graph: Record<string, unknown>; outNode: string } {
  const { width, height } = parseSize(o.size || cfg.size, 1328)
  const steps = cfg.steps > 0 ? cfg.steps : 8
  // ≤12 steps → the distilled 8-step Lightning LoRA at cfg 1 (fast); higher → base model at cfg 4 (max quality).
  const lightning = steps <= 12
  const graph: Record<string, unknown> = {
    '10': { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
    '11': { class_type: 'CLIPLoader', inputs: { clip_name: QWEN_CLIP, type: 'qwen_image', device: 'default' } },
    '12': { class_type: 'VAELoader', inputs: { vae_name: QWEN_VAE } },
    '13': { class_type: 'CLIPTextEncode', inputs: { clip: ['11', 0], text: o.prompt } },
    '14': { class_type: 'CLIPTextEncode', inputs: { clip: ['11', 0], text: o.negativePrompt ?? '' } },
    '15': { class_type: 'ModelSamplingAuraFlow', inputs: { model: [lightning ? '20' : '10', 0], shift: 3.1 } },
    '16': {
      class_type: 'EmptySD3LatentImage',
      inputs: { width, height, batch_size: Math.max(1, Math.min(8, o.count)) }
    },
    '17': {
      class_type: 'KSampler',
      inputs: {
        model: ['15', 0],
        positive: ['13', 0],
        negative: ['14', 0],
        latent_image: ['16', 0],
        seed,
        steps,
        cfg: lightning ? 1 : 4,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1
      }
    },
    '18': { class_type: 'VAEDecode', inputs: { samples: ['17', 0], vae: ['12', 0] } },
    '19': { class_type: 'SaveImage', inputs: { filename_prefix: 'nordcode', images: ['18', 0] } }
  }
  if (lightning) {
    graph['20'] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['10', 0], lora_name: QWEN_LIGHTNING_LORA, strength_model: 1 }
    }
  }
  return { graph, outNode: '19' }
}

/**
 * A FLUX.2-klein (distilled) text-to-image workflow graph. The distilled klein model is
 * guidance-distilled, so it runs at cfg=1 in ~4 steps and ignores the negative prompt
 * (this mirrors ComfyUI's official klein text-to-image template). Fast, but weak at text.
 * Returns the graph + the SaveImage node id to read.
 */
export function buildFluxKleinWorkflow(
  cfg: ImageConfig,
  o: GenOpts,
  unet: string,
  seed: number
): { graph: Record<string, unknown>; outNode: string } {
  const { width, height } = parseSize(o.size || cfg.size)
  const steps = cfg.steps > 0 ? cfg.steps : 4
  const graph: Record<string, unknown> = {
    '10': { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
    '11': { class_type: 'CLIPLoader', inputs: { clip_name: FLUX2_CLIP, type: 'flux2', device: 'default' } },
    '12': { class_type: 'VAELoader', inputs: { vae_name: FLUX2_VAE } },
    '13': { class_type: 'CLIPTextEncode', inputs: { clip: ['11', 0], text: o.prompt } },
    '14': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['13', 0] } },
    '15': {
      class_type: 'CFGGuider',
      inputs: { model: ['10', 0], positive: ['13', 0], negative: ['14', 0], cfg: 1 }
    },
    '16': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '17': { class_type: 'Flux2Scheduler', inputs: { steps, width, height } },
    '18': {
      class_type: 'EmptyFlux2LatentImage',
      inputs: { width, height, batch_size: Math.max(1, Math.min(8, o.count)) }
    },
    '19': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    '20': {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['19', 0], guider: ['15', 0], sampler: ['16', 0], sigmas: ['17', 0], latent_image: ['18', 0] }
    },
    '21': { class_type: 'VAEDecode', inputs: { samples: ['20', 0], vae: ['12', 0] } },
    '22': { class_type: 'SaveImage', inputs: { filename_prefix: 'nordcode', images: ['21', 0] } }
  }
  return { graph, outNode: '22' }
}

// ---- network ----

async function fetchJson(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  const ctl = new AbortController()
  const onAbort = (): void => ctl.abort()
  if (signal.aborted) ctl.abort()
  else signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctl.abort(), GEN_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal })
    const text = await res.text()
    if (!res.ok) {
      throw new ImageGenError(`backend returned HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`)
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new ImageGenError(`backend returned non-JSON (${text.slice(0, 200)})`)
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

// Hard ceiling on a fetched image/video body. These come from a user-configured backend (lower risk than
// web_fetch), but `res.arrayBuffer()` still materializes the whole response in the MAIN process, so a wrong
// URL or a misbehaving backend could OOM-crash the app. Generous enough for a short clip, far below an OOM.
const MAX_MEDIA_BYTES = 256 * 1024 * 1024

/** Read a media response into a Buffer, aborting if it exceeds the byte budget (early on Content-Length, then
 *  per-chunk so a lying/absent length can't slip past). Mirrors web.ts readCapped. */
async function readCappedMedia(res: Response, maxBytes: number = MAX_MEDIA_BYTES): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ImageGenError(`backend response too large: Content-Length ${declared} exceeds the ${maxBytes}-byte cap.`)
  }
  const reader = res.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new ImageGenError(`backend response exceeded the ${maxBytes}-byte cap (stopped mid-stream).`)
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
  }
  return Buffer.concat(chunks)
}

function unreachable(baseURL: string, e: unknown): ImageGenError {
  const msg = String((e as { message?: string })?.message ?? e)
  const code = (e as { cause?: { code?: string } })?.cause?.code
  if (code === 'ECONNREFUSED' || /ECONNREFUSED|fetch failed/i.test(msg)) {
    return new ImageGenError(`can't reach the image backend at ${baseURL}. Start it (or fix the URL in Settings → Image generation).`)
  }
  return e instanceof ImageGenError ? e : new ImageGenError(msg)
}

const trim = (s: string): string => s.replace(/\/+$/, '')

/**
 * SSRF guard for a follow-up image fetch (a URL the backend returned, or the Comfy /view URL): allow
 * any public host, or a private/loopback host ONLY when it matches the backend the user configured.
 * A cloud backend that tries to redirect us at 127.0.0.1 / 169.254.169.254 / the LAN is refused, while
 * a legitimately-local backend serving its own image stays allowed. (web_fetch already guards its hosts;
 * the image path must not be the soft spot.)
 */
function assertFetchableImageUrl(target: string, backendBaseURL: string): void {
  let t: URL
  try {
    t = new URL(target)
  } catch {
    throw new ImageGenError('the image backend returned an invalid image URL.')
  }
  if (t.protocol !== 'http:' && t.protocol !== 'https:') {
    throw new ImageGenError(`refusing a non-http(s) image URL (${t.protocol}).`)
  }
  if (classifyHost(t.hostname) === 'public') return
  let backendHost = ''
  try {
    backendHost = new URL(backendBaseURL).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    /* ignore */
  }
  if (t.hostname.toLowerCase().replace(/^\[|\]$/g, '') === backendHost) return
  throw new ImageGenError(`refusing to fetch an image from a private/loopback host (${t.hostname}).`)
}

async function generateA1111(cfg: ImageConfig, o: GenOpts, signal: AbortSignal): Promise<Buffer[]> {
  let json: unknown
  try {
    json = await fetchJson(
      `${trim(cfg.baseURL)}/sdapi/v1/txt2img`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildA1111Body(cfg, o)) },
      signal
    )
  } catch (e) {
    throw unreachable(cfg.baseURL, e)
  }
  const b64s = extractA1111Base64(json)
  if (!b64s.length) throw new ImageGenError('the A1111 backend returned no images.')
  return b64s.map((b) => Buffer.from(b, 'base64'))
}

async function generateOpenAI(cfg: ImageConfig, o: GenOpts, signal: AbortSignal): Promise<Buffer[]> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cfg.apiKey.trim()) headers.authorization = `Bearer ${cfg.apiKey.trim()}`
  let json: unknown
  try {
    json = await fetchJson(
      `${trim(cfg.baseURL)}/images/generations`,
      { method: 'POST', headers, body: JSON.stringify(buildOpenAIBody(cfg, o)) },
      signal
    )
  } catch (e) {
    throw unreachable(cfg.baseURL, e)
  }
  const items = extractOpenAIImages(json)
  if (!items.length) throw new ImageGenError('the image endpoint returned no images.')
  const out: Buffer[] = []
  for (const it of items) {
    if (it.b64) out.push(Buffer.from(it.b64, 'base64'))
    else if (it.url) {
      assertFetchableImageUrl(it.url, cfg.baseURL)
      const r = await fetch(it.url, { signal })
      out.push(await readCappedMedia(r))
    }
  }
  return out
}

/** Pick the diffusion model for this call: per-call override > Settings model > Z-Image-Turbo default. */
function chooseUnet(cfg: ImageConfig, o: GenOpts): string {
  return (o.modelOverride && o.modelOverride.trim()) || cfg.model.trim() || ZIMAGE_DEFAULT_UNET
}

/** Validate the diffusion model exists on the target instance — a clear error beats a cryptic ComfyUI failure. */
async function assertUnetAvailable(base: string, want: string, signal: AbortSignal): Promise<void> {
  const info = (await fetchJson(`${base}/object_info/UNETLoader`, {}, signal)) as Record<
    string,
    { input?: { required?: { unet_name?: unknown[] } } }
  >
  const names = info?.UNETLoader?.input?.required?.unet_name?.[0]
  const list = Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : []
  if (list.length && !list.includes(want)) {
    throw new ImageGenError(
      `ComfyUI has no diffusion model "${want}" in models/diffusion_models. Available: ${list.join(', ') || 'none'}. Set one in Settings → Image generation → Model.`
    )
  }
}

// On-demand ComfyUI: a generation request brings the backend up if it isn't running, rather than failing.
// Only auto-launches a LOCAL instance via the CONFIGURED launcher (cfg.launcherPath — no hardcoded
// machine path); a remote/missing/unconfigured one is left alone and the request surfaces a clear error.

async function ensureComfyRunning(base: string, launcher: string, signal: AbortSignal): Promise<void> {
  const ping = async (): Promise<boolean> => {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 2500)
    try {
      const r = await fetch(`${base}/system_stats`, { signal: ctl.signal })
      return r.ok
    } catch {
      return false
    } finally {
      clearTimeout(t)
    }
  }
  if (await ping()) return
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(base)
  if (!isLocal || !launcher || !existsSync(launcher)) return // leave it — the request surfaces a clear unreachable error
  try {
    // Platform-appropriate launch: cmd for .bat on Windows, sh for scripts elsewhere.
    const exe = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
    const args = process.platform === 'win32' ? ['/c', launcher] : ['-c', launcher]
    spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } catch {
    return
  }
  const deadline = Date.now() + 90_000 // ComfyUI cold start; a fresh 5090 instance can take a little longer
  while (Date.now() < deadline) {
    if (signal.aborted) return
    await new Promise((r) => setTimeout(r, 2000))
    if (await ping()) return
  }
}

async function generateComfy(cfg: ImageConfig, o: GenOpts, signal: AbortSignal): Promise<Buffer[]> {
  const unet = chooseUnet(cfg, o)
  const base = trim(cfg.baseURL)
  await ensureComfyRunning(base, cfg.launcherPath?.trim() ?? '', signal)
  let queued: { prompt_id?: string }
  try {
    await assertUnetAvailable(base, unet, signal)
    // Vary the seed by prompt length + count so repeated calls differ (no Math.random in scope).
    const seed = (o.prompt.length * 2654435761 + o.count * 40503) % 2147483647
    const { graph } = buildComfyWorkflow(cfg, o, unet, seed)
    queued = (await fetchJson(
      `${base}/prompt`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph }) },
      signal
    )) as { prompt_id?: string }
  } catch (e) {
    throw unreachable(base, e)
  }
  const id = queued.prompt_id
  if (!id) throw new ImageGenError('ComfyUI did not accept the workflow.')

  // Poll history until the run finishes (abortable; bounded by the same overall timeout).
  const deadline = Date.now() + GEN_TIMEOUT_MS
  let outputs: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }> | undefined
  while (Date.now() < deadline) {
    if (signal.aborted) throw new ImageGenError('cancelled.')
    await new Promise((r) => setTimeout(r, 1200))
    const hist = (await fetchJson(`${base}/history/${id}`, {}, signal).catch(() => ({}))) as Record<
      string,
      { outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }> }
    >
    const entry = hist?.[id]
    if (entry?.outputs) {
      outputs = entry.outputs
      break
    }
  }
  if (!outputs) throw new ImageGenError('ComfyUI generation timed out.')
  const files = Object.values(outputs).flatMap((n) => n.images ?? [])
  if (!files.length) throw new ImageGenError('ComfyUI produced no images.')
  const out: Buffer[] = []
  for (const f of files) {
    const url = `${base}/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder)}&type=${encodeURIComponent(f.type)}`
    assertFetchableImageUrl(url, cfg.baseURL)
    const r = await fetch(url, { signal })
    out.push(await readCappedMedia(r))
  }
  return out
}

/** Map a "WxH" size to the closest Imagen aspect-ratio token (Imagen takes a ratio, not exact pixels). */
export function geminiAspectRatio(size: string | undefined): string {
  const { width, height } = parseSize(size, 1024)
  if (width === height) return '1:1'
  return width > height ? (width / height >= 1.6 ? '16:9' : '4:3') : (height / width >= 1.6 ? '9:16' : '3:4')
}

/** Pull base64 image payloads from a Gemini response — Imagen `:predict` (predictions[].bytesBase64Encoded) OR
 *  `:generateContent` (candidates[].content.parts[].inlineData.data, snake_case tolerated). Pure → unit-tested. */
export function extractGeminiImages(json: unknown): string[] {
  const j = json as {
    predictions?: { bytesBase64Encoded?: string }[]
    candidates?: { content?: { parts?: { inlineData?: { data?: string }; inline_data?: { data?: string } }[] } }[]
  }
  const out: string[] = []
  for (const p of j?.predictions ?? []) if (p.bytesBase64Encoded) out.push(p.bytesBase64Encoded)
  for (const c of j?.candidates ?? [])
    for (const part of c.content?.parts ?? []) {
      const d = part.inlineData?.data ?? part.inline_data?.data
      if (d) out.push(d)
    }
  return out
}

/** A Google API error message, if the response is an error envelope (else ''). */
function geminiErrorMessage(json: unknown): string {
  const m = (json as { error?: { message?: string } })?.error?.message
  return typeof m === 'string' ? m : ''
}

/**
 * Google Gemini image generation (native API, NOT the OpenAI-compat chat endpoint). Dispatches by model id:
 *  - `imagen-*` → the Imagen `:predict` endpoint (dedicated text→image; `sampleCount` images per call).
 *  - otherwise (e.g. `gemini-2.5-flash-image`) → `:generateContent` with an IMAGE response modality (one image per
 *    call, so we loop for `count`). Auth via the `x-goog-api-key` header (the Gemini API key).
 */
async function generateGemini(cfg: ImageConfig, o: GenOpts, signal: AbortSignal): Promise<Buffer[]> {
  const key = cfg.apiKey.trim()
  if (!key) throw new ImageGenError('Gemini image generation needs an API key — set it in Settings → Image generation.')
  const model = (o.modelOverride || cfg.model || 'imagen-3.0-generate-002').trim()
  const root = trim(cfg.baseURL) // e.g. https://generativelanguage.googleapis.com/v1beta
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-goog-api-key': key }
  const count = Math.max(1, Math.min(o.count || 1, 4))
  const call = async (body: unknown, verb: 'predict' | 'generateContent'): Promise<unknown> => {
    try {
      return await fetchJson(`${root}/models/${encodeURIComponent(model)}:${verb}`, { method: 'POST', headers, body: JSON.stringify(body) }, signal)
    } catch (e) {
      throw unreachable(cfg.baseURL, e)
    }
  }
  if (/^imagen/i.test(model)) {
    const json = await call({ instances: [{ prompt: o.prompt }], parameters: { sampleCount: count, aspectRatio: geminiAspectRatio(o.size || cfg.size) } }, 'predict')
    const imgs = extractGeminiImages(json)
    if (!imgs.length) throw new ImageGenError(geminiErrorMessage(json) || 'Imagen returned no images (it needs a billing-enabled Gemini API key).')
    return imgs.map((b) => Buffer.from(b, 'base64'))
  }
  // gemini-*-image returns one image per generateContent call → loop for count.
  const out: Buffer[] = []
  for (let i = 0; i < count; i++) {
    const json = await call({ contents: [{ parts: [{ text: o.prompt }] }], generationConfig: { responseModalities: ['IMAGE'] } }, 'generateContent')
    const imgs = extractGeminiImages(json)
    if (!imgs.length) throw new ImageGenError(geminiErrorMessage(json) || 'Gemini returned no image for this prompt.')
    out.push(Buffer.from(imgs[0], 'base64'))
  }
  return out
}

/** Generate one or more PNG images via the configured backend. Throws ImageGenError on any failure. */
export async function generateImages(cfg: ImageConfig, o: GenOpts, signal: AbortSignal): Promise<Buffer[]> {
  if (!cfg.baseURL.trim()) throw new ImageGenError('no image backend configured — set one in Settings → Image generation.')
  switch (cfg.provider) {
    case 'a1111':
      return generateA1111(cfg, o, signal)
    case 'comfyui':
      return generateComfy(cfg, o, signal)
    case 'openai':
      return generateOpenAI(cfg, o, signal)
    case 'gemini':
      return generateGemini(cfg, o, signal)
    default:
      throw new ImageGenError(`unknown image provider: ${cfg.provider}`)
  }
}

const VIDEO_TIMEOUT_MS = 1_200_000 // video is far slower than images — allow up to 20 minutes (abortable)

/**
 * Wan 2.2 14B text-to-video graph (ComfyUI native). A Mixture-of-Experts: the high-noise expert denoises
 * the first half of the steps, then the low-noise expert finishes — two KSamplerAdvanced stages sharing
 * one latent. umT5 encoder (CLIPLoader type=wan), wan_2.1 VAE, ModelSamplingSD3 shift, then CreateVideo →
 * SaveVideo (mp4/h264). Runs at 16fps; frame count is snapped to 4n+1 (the VAE's temporal stride).
 */
export function buildWanVideoWorkflow(o: VideoOpts, seed: number): { graph: Record<string, unknown>; outNode: string } {
  const sz = parseSize(o.size || '832x480', 480)
  const width = Math.round(sz.width / 16) * 16
  const height = Math.round(sz.height / 16) * 16
  const fps = 16
  const seconds = o.seconds && o.seconds > 0 ? o.seconds : 5
  const frames = Math.max(5, Math.round((seconds * fps) / 4) * 4 + 1)
  const steps = o.steps && o.steps > 0 ? o.steps : 20
  const switchStep = Math.round(steps / 2)
  const negative =
    o.negativePrompt ?? 'blurry, low quality, distorted, deformed, watermark, text, jpeg artifacts, static, overexposed'
  const shift = 8
  const cfg = 5
  const graph: Record<string, unknown> = {
    '10': { class_type: 'UNETLoader', inputs: { unet_name: WAN_T2V_HIGH, weight_dtype: 'default' } },
    '11': { class_type: 'UNETLoader', inputs: { unet_name: WAN_T2V_LOW, weight_dtype: 'default' } },
    '12': { class_type: 'CLIPLoader', inputs: { clip_name: WAN_CLIP, type: 'wan', device: 'default' } },
    '13': { class_type: 'VAELoader', inputs: { vae_name: WAN_VAE } },
    '14': { class_type: 'CLIPTextEncode', inputs: { clip: ['12', 0], text: o.prompt } },
    '15': { class_type: 'CLIPTextEncode', inputs: { clip: ['12', 0], text: negative } },
    '16': { class_type: 'ModelSamplingSD3', inputs: { model: ['10', 0], shift } },
    '17': { class_type: 'ModelSamplingSD3', inputs: { model: ['11', 0], shift } },
    '18': { class_type: 'EmptyHunyuanLatentVideo', inputs: { width, height, length: frames, batch_size: 1 } },
    '19': {
      class_type: 'KSamplerAdvanced',
      inputs: {
        model: ['16', 0], add_noise: 'enable', noise_seed: seed, steps, cfg,
        sampler_name: 'euler', scheduler: 'simple', positive: ['14', 0], negative: ['15', 0],
        latent_image: ['18', 0], start_at_step: 0, end_at_step: switchStep, return_with_leftover_noise: 'enable'
      }
    },
    '20': {
      class_type: 'KSamplerAdvanced',
      inputs: {
        model: ['17', 0], add_noise: 'disable', noise_seed: seed, steps, cfg,
        sampler_name: 'euler', scheduler: 'simple', positive: ['14', 0], negative: ['15', 0],
        latent_image: ['19', 0], start_at_step: switchStep, end_at_step: 10000, return_with_leftover_noise: 'disable'
      }
    },
    '21': { class_type: 'VAEDecode', inputs: { samples: ['20', 0], vae: ['13', 0] } },
    '22': { class_type: 'CreateVideo', inputs: { images: ['21', 0], fps } },
    '23': {
      class_type: 'SaveVideo',
      inputs: { video: ['22', 0], filename_prefix: 'nordcode_vid', format: 'mp4', codec: 'h264' }
    }
  }
  return { graph, outNode: '23' }
}

/** Generate a single video (mp4 bytes) via ComfyUI + Wan 2.2. Throws ImageGenError on failure. */
export async function generateVideo(cfg: ImageConfig, o: VideoOpts, signal: AbortSignal): Promise<Buffer> {
  if (!cfg.baseURL.trim()) throw new ImageGenError('no image backend configured — set one in Settings → Image generation.')
  if (cfg.provider !== 'comfyui') throw new ImageGenError('video generation requires the ComfyUI backend.')
  const base = trim(cfg.baseURL)
  await ensureComfyRunning(base, cfg.launcherPath?.trim() ?? '', signal) // video (Wan) stays on the 3090, unloading the LLM
  const seed = o.seed && o.seed > 0 ? o.seed : (o.prompt.length * 2654435761) % 2147483647
  const { graph } = buildWanVideoWorkflow(o, seed)
  let queued: { prompt_id?: string }
  try {
    queued = (await fetchJson(
      `${base}/prompt`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph }) },
      signal
    )) as { prompt_id?: string }
  } catch (e) {
    throw unreachable(cfg.baseURL, e)
  }
  const id = queued.prompt_id
  if (!id) throw new ImageGenError('ComfyUI did not accept the video workflow.')

  type VFile = { filename: string; subfolder: string; type: string }
  const deadline = Date.now() + VIDEO_TIMEOUT_MS
  let outputs: Record<string, { images?: VFile[]; gifs?: VFile[] }> | undefined
  while (Date.now() < deadline) {
    if (signal.aborted) throw new ImageGenError('cancelled.')
    await new Promise((r) => setTimeout(r, 2000))
    const hist = (await fetchJson(`${base}/history/${id}`, {}, signal).catch(() => ({}))) as Record<
      string,
      { outputs?: Record<string, { images?: VFile[]; gifs?: VFile[] }> }
    >
    const entry = hist?.[id]
    if (entry?.outputs) {
      outputs = entry.outputs
      break
    }
  }
  if (!outputs) throw new ImageGenError('ComfyUI video generation timed out.')
  const files = Object.values(outputs).flatMap((n) => [...(n.images ?? []), ...(n.gifs ?? [])])
  const vid = files.find((f) => /\.(mp4|webm|mkv)$/i.test(f.filename))
  if (!vid) throw new ImageGenError('ComfyUI produced no video file.')
  const url = `${base}/view?filename=${encodeURIComponent(vid.filename)}&subfolder=${encodeURIComponent(vid.subfolder)}&type=${encodeURIComponent(vid.type)}`
  assertFetchableImageUrl(url, cfg.baseURL)
  const r = await fetch(url, { signal })
  return readCappedMedia(r)
}
