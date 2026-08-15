import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { z } from 'zod'
import type { ToolDef } from '../registry'
import type { ToolPreview } from '../../../shared/ipc-types'
import { generateVideo, ImageGenError, slugify } from '../image/generate'
import { writeBytesAtomic } from '../fsutil'

const schema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe('The video to generate — describe the subject, its motion/action, the camera, style and lighting.'),
  path: z
    .string()
    .optional()
    .describe('Output file path (relative to the workspace), e.g. assets/clip.mp4. Defaults to a slug of the prompt.'),
  negative_prompt: z.string().optional().describe('What to avoid in the video.'),
  seconds: z.number().min(1).max(8).optional().describe('Clip length in seconds (default 5). Longer = slower.'),
  size: z.string().optional().describe('WxH — 832x480 (default, faster) or 1280x720 (sharper, slower).'),
  seed: z.number().int().optional().describe('Seed for reproducibility (optional).')
})

/** Free the GPU by unloading any local LM Studio model — Wan 14B needs the full 24GB. Best-effort, no-op if none. */
async function unloadLocalLLM(): Promise<void> {
  const lms = path.join(os.homedir(), '.lmstudio', 'bin', process.platform === 'win32' ? 'lms.exe' : 'lms')
  await new Promise<void>((resolve) => {
    try {
      execFile(lms, ['unload', '--all'], () => resolve())
    } catch {
      resolve()
    }
  })
}

/** Resolve a non-colliding .mp4 path inside the workspace (append -2, -3… if taken). */
async function freePath(workspace: { resolve: (p: string) => string }, rel: string): Promise<string> {
  let abs = workspace.resolve(rel)
  if (!/\.mp4$/i.test(abs)) abs += '.mp4'
  const dir = path.dirname(abs)
  const base = path.basename(abs).replace(/\.mp4$/i, '')
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? path.join(dir, `${base}.mp4`) : path.join(dir, `${base}-${i + 1}.mp4`)
    const exists = await fs.stat(candidate).then(() => true).catch(() => false)
    if (!exists) return candidate
  }
}

export const generateVideoTool: ToolDef<typeof schema> = {
  name: 'generate_video',
  description:
    'Generate a short video clip (~5s) from a text prompt and save it into the workspace as an mp4, using the local ' +
    'ComfyUI + Wan 2.2 (Apache 2.0). Requires user approval. SLOW — several minutes per clip — and it UNLOADS the local ' +
    'LLM to free the GPU (the model reloads on the next message). The clip is shown to the user inline automatically. ' +
    'Use only for actual motion; for still images use generate_image instead. Returns the saved path.',
  schema,
  mutating: true,
  category: 'edit',
  // Video generation is very slow — override the default tool timeout.
  timeoutMs: 1_200_000,
  preview(args): ToolPreview {
    const secs = args.seconds ? ` ${args.seconds}s` : ''
    const sz = args.size ? ` (${args.size})` : ''
    return { kind: 'text', text: `Generate video${secs}${sz}: "${args.prompt}"` }
  },
  async handler(args, ctx) {
    const cfg = ctx.images
    if (!cfg || !cfg.baseURL.trim()) {
      return 'ERROR: no image backend configured. Open Settings → Image generation and set the ComfyUI base URL.'
    }
    if (cfg.provider !== 'comfyui') {
      return 'ERROR: video generation requires the ComfyUI backend (Settings → Image generation → provider: comfyui).'
    }
    // Wan 14B can't share the GPU with the LLM, so free it first (no-op if nothing is loaded).
    await unloadLocalLLM()
    let buf: Buffer
    try {
      buf = await generateVideo(
        cfg,
        { prompt: args.prompt, negativePrompt: args.negative_prompt, seconds: args.seconds, size: args.size, seed: args.seed },
        ctx.signal
      )
    } catch (e) {
      if (ctx.signal.aborted) return 'CANCELLED: video generation stopped.'
      if (e instanceof ImageGenError) return `ERROR: video generation failed — ${e.message}`
      return `ERROR: video generation failed — ${e instanceof Error ? e.message : String(e)}`
    }
    if (!buf.length) return 'ERROR: the backend returned no video.'

    const stem = args.path?.trim() || slugify(args.prompt)
    const abs = await freePath(ctx.workspace, stem)
    ctx.snapshots.record(abs, null) // new file → undo deletes it
    await writeBytesAtomic(abs, buf)
    const after = await fs.stat(abs).catch(() => null)
    if (after) ctx.reads.record(abs, after.mtimeMs)
    const rel = path.relative(ctx.workspace.resolve('.'), abs).replace(/\\/g, '/')

    // Inline playback: reuse the image channel with a video data URL (ToolCallCard renders <video> for data:video/…).
    // Skip very large clips to keep the session light — the file is still saved to the workspace.
    const MAX_INLINE = 40 * 1024 * 1024
    if (buf.length <= MAX_INLINE) ctx.attachImages?.([`data:video/mp4;base64,${buf.toString('base64')}`])

    return `Generated a ${(buf.length / 1024 / 1024).toFixed(1)}MB video via Wan 2.2 (shown inline to the user automatically; the local LLM was unloaded to free the GPU and reloads on the next message):\n${rel}`
  }
}
