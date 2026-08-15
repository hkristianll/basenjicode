import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ToolDef } from '../registry'
import type { ToolPreview } from '../../../shared/ipc-types'
import { generateImages, ImageGenError, slugify, ZIMAGE_DEFAULT_UNET, QWEN_DEFAULT_UNET, FLUX2_DEFAULT_UNET } from '../image/generate'
import { writeBytesAtomic } from '../fsutil'

const schema = z.object({
  prompt: z.string().min(1).describe('What to generate, described in detail (subject, style, composition, lighting).'),
  path: z
    .string()
    .optional()
    .describe('Output file path (relative to the workspace), e.g. assets/logo.png. Defaults to a slug of the prompt.'),
  negative_prompt: z.string().optional().describe('What to avoid (local Stable Diffusion backends only).'),
  size: z.string().optional().describe('WxH, e.g. 1024x1024, 1024x1536. Defaults to the configured size.'),
  count: z.number().int().min(1).max(4).optional().describe('How many images to generate (default 1).'),
  model: z
    .enum(['zimage', 'qwen', 'klein'])
    .optional()
    .describe(
      "Which image model to use for THIS image (overrides the Settings default). 'zimage' = fast Z-Image-Turbo " +
        "(default — great general images + short text); 'qwen' = Qwen-Image (slower; best for legible or dense in-image " +
        "text, or when the user explicitly asks for Qwen); 'klein' = tiny fast FLUX.2-klein. Omit to use the Settings default."
    )
})

/** Resolve a non-colliding .png path inside the workspace (append -2, -3… if taken). */
async function freePath(workspace: { resolve: (p: string) => string }, rel: string): Promise<string> {
  let abs = workspace.resolve(rel)
  if (!/\.png$/i.test(abs)) abs += '.png'
  const dir = path.dirname(abs)
  const base = path.basename(abs).replace(/\.png$/i, '')
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? path.join(dir, `${base}.png`) : path.join(dir, `${base}-${i + 1}.png`)
    const exists = await fs.stat(candidate).then(() => true).catch(() => false)
    if (!exists) return candidate
  }
}

export const generateImageTool: ToolDef<typeof schema> = {
  name: 'generate_image',
  description:
    'Generate an image from a text prompt and save it into the workspace as a PNG (for app assets, logos, hero images, ' +
    'mockups, etc.). Uses the image backend configured in Settings (local Stable Diffusion or an OpenAI-compatible ' +
    'endpoint). Requires user approval. The generated image is shown to the user inline automatically — ' +
    'you do not need to and cannot otherwise display it. Use the `model` arg to pick Z-Image (fast, default), ' +
    'Qwen (best for in-image text), or klein per image — no Settings change needed. Returns the saved path(s).',
  schema,
  mutating: true,
  category: 'edit',
  // Image generation is slow — override the default 30s tool timeout.
  timeoutMs: 300_000,
  preview(args): ToolPreview {
    const n = args.count && args.count > 1 ? ` ×${args.count}` : ''
    return { kind: 'text', text: `Generate image${n}: "${args.prompt}"${args.size ? ` (${args.size})` : ''}` }
  },
  async handler(args, ctx) {
    const cfg = ctx.images
    if (!cfg || !cfg.baseURL.trim()) {
      return 'ERROR: no image backend configured. Open Settings → Image generation and set a provider + base URL.'
    }
    let buffers: Buffer[]
    try {
      const MODELS: Record<string, string> = { zimage: ZIMAGE_DEFAULT_UNET, qwen: QWEN_DEFAULT_UNET, klein: FLUX2_DEFAULT_UNET }
      buffers = await generateImages(
        cfg,
        {
          prompt: args.prompt,
          negativePrompt: args.negative_prompt,
          size: args.size,
          count: args.count ?? 1,
          modelOverride: args.model ? MODELS[args.model] : undefined
        },
        ctx.signal
      )
    } catch (e) {
      if (ctx.signal.aborted) return 'CANCELLED: image generation stopped.'
      if (e instanceof ImageGenError) return `ERROR: image generation failed — ${e.message}`
      return `ERROR: image generation failed — ${e instanceof Error ? e.message : String(e)}`
    }
    if (!buffers.length) return 'ERROR: the backend returned no images.'

    const stem = args.path?.trim() || slugify(args.prompt)
    const saved: string[] = []
    const dataUrls: string[] = []
    for (let i = 0; i < buffers.length; i++) {
      // For count>1 with an explicit path, suffix the index; freePath also avoids clobbering.
      const rel = buffers.length > 1 && args.path ? stem.replace(/\.png$/i, '') + `-${i + 1}.png` : stem
      const abs = await freePath(ctx.workspace, rel)
      ctx.snapshots.record(abs, null) // new file → undo deletes it (no binary-fidelity concern)
      await writeBytesAtomic(abs, buffers[i])
      const after = await fs.stat(abs).catch(() => null)
      if (after) ctx.reads.record(abs, after.mtimeMs)
      saved.push(path.relative(ctx.workspace.resolve('.'), abs).replace(/\\/g, '/'))
      dataUrls.push(`data:image/png;base64,${buffers[i].toString('base64')}`)
    }
    ctx.attachImages?.(dataUrls) // show them inline in the tool card
    const via = cfg.provider === 'openai' ? (cfg.model || 'gpt-image-1') : args.model ? `comfyui (${args.model})` : cfg.provider
    return `Generated ${saved.length} image${saved.length === 1 ? '' : 's'} via ${via} (shown inline to the user automatically):\n${saved.join('\n')}`
  }
}
