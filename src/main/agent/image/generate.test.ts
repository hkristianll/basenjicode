import { describe, it, expect } from 'vitest'
import type { ImageConfig } from '../../../shared/domain-types'
import {
  parseSize,
  slugify,
  buildA1111Body,
  extractA1111Base64,
  buildOpenAIBody,
  extractOpenAIImages,
  buildComfyWorkflow,
  buildWanVideoWorkflow,
  geminiAspectRatio,
  extractGeminiImages
} from './generate'

const cfg = (over: Partial<ImageConfig> = {}): ImageConfig => ({
  provider: 'a1111',
  baseURL: 'http://127.0.0.1:7860',
  apiKey: '',
  model: '',
  size: '1024x1024',
  steps: 28,
  ...over
})

describe('parseSize', () => {
  it('parses WxH (x and ×)', () => {
    expect(parseSize('1024x1536')).toEqual({ width: 1024, height: 1536 })
    expect(parseSize('512×768')).toEqual({ width: 512, height: 768 })
  })
  it('falls back and clamps', () => {
    expect(parseSize(undefined)).toEqual({ width: 1024, height: 1024 })
    expect(parseSize('garbage')).toEqual({ width: 1024, height: 1024 })
    expect(parseSize('99999x10')).toEqual({ width: 4096, height: 64 })
  })
})

describe('slugify', () => {
  it('makes a filesystem-safe slug', () => {
    expect(slugify('A red fox, in the snow!')).toBe('a-red-fox-in-the-snow')
    expect(slugify('   ')).toBe('image')
  })
})

describe('buildA1111Body', () => {
  it('maps prompt/size/steps/count and omits override when no model', () => {
    const b = buildA1111Body(cfg({ steps: 30 }), { prompt: 'a cat', size: '512x512', count: 2 })
    expect(b).toMatchObject({ prompt: 'a cat', steps: 30, width: 512, height: 512, batch_size: 2 })
    expect(b.override_settings).toBeUndefined()
  })
  it('adds the checkpoint override when a model is set', () => {
    const b = buildA1111Body(cfg({ model: 'sd_xl_base.safetensors' }), { prompt: 'x', count: 1 })
    expect(b.override_settings).toEqual({ sd_model_checkpoint: 'sd_xl_base.safetensors' })
  })
})

describe('extractA1111Base64', () => {
  it('pulls base64 strings and strips any data: prefix', () => {
    expect(extractA1111Base64({ images: ['AAAA', 'data:image/png;base64,BBBB'] })).toEqual(['AAAA', 'BBBB'])
    expect(extractA1111Base64({})).toEqual([])
  })
})

describe('buildOpenAIBody', () => {
  it('defaults the model and never sends response_format (gpt-image-1 rejects it)', () => {
    const b = buildOpenAIBody(cfg({ provider: 'openai', model: '' }), { prompt: 'hi', count: 3, size: '1024×1024' })
    expect(b).toMatchObject({ model: 'gpt-image-1', prompt: 'hi', n: 3, size: '1024x1024' })
    expect('response_format' in b).toBe(false)
  })
})

describe('extractOpenAIImages', () => {
  it('handles b64_json and url entries', () => {
    expect(extractOpenAIImages({ data: [{ b64_json: 'ZZ' }, { url: 'http://x/y.png' }] })).toEqual([
      { b64: 'ZZ' },
      { url: 'http://x/y.png' }
    ])
    expect(extractOpenAIImages({})).toEqual([])
  })
})

describe('geminiAspectRatio', () => {
  it('maps a size to the closest Imagen ratio token', () => {
    expect(geminiAspectRatio('1024x1024')).toBe('1:1')
    expect(geminiAspectRatio('1920x1080')).toBe('16:9') // wide
    expect(geminiAspectRatio('1024x768')).toBe('4:3') // mild landscape
    expect(geminiAspectRatio('1080x1920')).toBe('9:16') // tall
    expect(geminiAspectRatio('768x1024')).toBe('3:4') // mild portrait
    expect(geminiAspectRatio(undefined)).toBe('1:1') // falls back square
  })
})

describe('extractGeminiImages', () => {
  it('pulls base64 from Imagen :predict (predictions[].bytesBase64Encoded)', () => {
    expect(extractGeminiImages({ predictions: [{ bytesBase64Encoded: 'AAA' }, { bytesBase64Encoded: 'BBB' }] })).toEqual(['AAA', 'BBB'])
  })
  it('pulls inline image data from :generateContent (camelCase and snake_case)', () => {
    const camel = { candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { data: 'CCC' } }] } }] }
    const snake = { candidates: [{ content: { parts: [{ inline_data: { data: 'DDD' } }] } }] }
    expect(extractGeminiImages(camel)).toEqual(['CCC'])
    expect(extractGeminiImages(snake)).toEqual(['DDD'])
  })
  it('returns [] for an error envelope or empty response (caller surfaces the API error)', () => {
    expect(extractGeminiImages({ error: { message: 'billing required' } })).toEqual([])
    expect(extractGeminiImages({})).toEqual([])
  })
})

describe('buildComfyWorkflow', () => {
  it('produces a wired FLUX.2-klein graph with the unet, size, steps and seed', () => {
    const { graph, outNode } = buildComfyWorkflow(
      cfg({ provider: 'comfyui', steps: 6 }),
      { prompt: 'castle', count: 1, size: '768x768' },
      'flux-2-klein-4b-fp8.safetensors',
      42
    )
    expect(outNode).toBe('22')
    const g = graph as Record<string, { class_type: string; inputs: Record<string, unknown> }>
    expect(g['10'].inputs.unet_name).toBe('flux-2-klein-4b-fp8.safetensors')
    expect(g['11'].inputs).toMatchObject({ type: 'flux2', clip_name: 'qwen_3_4b.safetensors' })
    expect(g['13'].inputs.text).toBe('castle')
    expect(g['17'].inputs).toMatchObject({ steps: 6, width: 768, height: 768 })
    expect(g['18'].inputs).toMatchObject({ width: 768, height: 768 })
    expect(g['19'].inputs.noise_seed).toBe(42)
    expect(g['22'].class_type).toBe('SaveImage')
  })
  it('defaults to 4 steps for the distilled klein model when steps is 0', () => {
    const { graph } = buildComfyWorkflow(
      cfg({ provider: 'comfyui', steps: 0 }),
      { prompt: 'x', count: 1 },
      'flux-2-klein-4b-fp8.safetensors',
      1
    )
    const g = graph as Record<string, { inputs: Record<string, unknown> }>
    expect(g['17'].inputs.steps).toBe(4)
  })
})

describe('buildComfyWorkflow (Qwen-Image)', () => {
  it('steps > 12 → full-quality cfg-4 graph, no Lightning LoRA, ModelSampling fed by the base model', () => {
    const { graph, outNode } = buildComfyWorkflow(
      cfg({ provider: 'comfyui', steps: 24 }),
      { prompt: 'a neon sign that says OPEN', negativePrompt: 'blurry', count: 1, size: '1328x1328' },
      'qwen_image_2512_fp8_e4m3fn.safetensors',
      7
    )
    expect(outNode).toBe('19')
    const g = graph as Record<string, { class_type: string; inputs: Record<string, unknown> }>
    expect(g['10'].inputs.unet_name).toBe('qwen_image_2512_fp8_e4m3fn.safetensors')
    expect(g['11'].inputs).toMatchObject({ type: 'qwen_image', clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors' })
    expect(g['15'].class_type).toBe('ModelSamplingAuraFlow')
    expect(g['15'].inputs.model).toEqual(['10', 0])
    expect(g['20']).toBeUndefined()
    expect(g['13'].inputs.text).toBe('a neon sign that says OPEN')
    expect(g['14'].inputs.text).toBe('blurry')
    expect(g['16'].inputs).toMatchObject({ width: 1328, height: 1328 })
    expect(g['17'].inputs).toMatchObject({ steps: 24, cfg: 4, sampler_name: 'euler', scheduler: 'simple', seed: 7 })
    expect(g['19'].class_type).toBe('SaveImage')
  })
  it('defaults to 8 steps + the Lightning LoRA at cfg 1 (ModelSampling fed by the LoRA)', () => {
    const { graph } = buildComfyWorkflow(
      cfg({ provider: 'comfyui', steps: 0, size: '' }),
      { prompt: 'x', count: 1 },
      'qwen_image_2512_fp8_e4m3fn.safetensors',
      1
    )
    const g = graph as Record<string, { class_type: string; inputs: Record<string, unknown> }>
    expect(g['17'].inputs).toMatchObject({ steps: 8, cfg: 1 })
    expect(g['20'].class_type).toBe('LoraLoaderModelOnly')
    expect(g['20'].inputs).toMatchObject({ lora_name: 'Qwen-Image-Lightning-8steps-V2.0.safetensors', strength_model: 1 })
    expect(g['15'].inputs.model).toEqual(['20', 0])
    expect(g['16'].inputs).toMatchObject({ width: 1328, height: 1328 })
  })
})

describe('buildComfyWorkflow (Z-Image-Turbo)', () => {
  it('routes a z-image model to the Z-Image graph (lumina2 clip, res_multistep, 8 steps, cfg 1)', () => {
    const { graph, outNode } = buildComfyWorkflow(
      cfg({ provider: 'comfyui', steps: 0 }),
      { prompt: 'a misty harbor at dawn', count: 1, size: '1024x1024' },
      'z-image-turbo-fp8-e4m3fn.safetensors',
      5
    )
    expect(outNode).toBe('19')
    const g = graph as Record<string, { class_type: string; inputs: Record<string, unknown> }>
    expect(g['10'].inputs.unet_name).toBe('z-image-turbo-fp8-e4m3fn.safetensors')
    expect(g['11'].inputs).toMatchObject({ type: 'lumina2', clip_name: 'qwen_3_4b.safetensors' })
    expect(g['12'].inputs.vae_name).toBe('z_image_ae.safetensors')
    expect(g['15'].class_type).toBe('ModelSamplingAuraFlow')
    expect(g['17'].inputs).toMatchObject({ steps: 8, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', seed: 5 })
    expect(g['19'].class_type).toBe('SaveImage')
  })
})

describe('buildWanVideoWorkflow (Wan 2.2 14B video)', () => {
  it('wires the two-expert MoE graph: high/low UNETs, wan CLIP, CreateVideo → SaveVideo mp4', () => {
    const { graph, outNode } = buildWanVideoWorkflow({ prompt: 'a fox running', seconds: 3, size: '832x480' }, 7)
    expect(outNode).toBe('23')
    const g = graph as Record<string, { class_type: string; inputs: Record<string, unknown> }>
    expect(g['10'].inputs.unet_name).toMatch(/high_noise/)
    expect(g['11'].inputs.unet_name).toMatch(/low_noise/)
    expect(g['12'].inputs).toMatchObject({ type: 'wan' })
    expect(g['18'].inputs).toMatchObject({ width: 832, height: 480, length: 49 }) // 3s×16=48 → 49 (4n+1)
    expect(g['19'].inputs).toMatchObject({ add_noise: 'enable', start_at_step: 0, end_at_step: 10, return_with_leftover_noise: 'enable' })
    expect(g['20'].inputs).toMatchObject({ add_noise: 'disable', start_at_step: 10, return_with_leftover_noise: 'disable' })
    expect(g['22'].class_type).toBe('CreateVideo')
    expect(g['23'].inputs).toMatchObject({ format: 'mp4', codec: 'h264' })
  })
  it('defaults to 5s / 832×480 / 20 steps and snaps frames to 4n+1', () => {
    const { graph } = buildWanVideoWorkflow({ prompt: 'x' }, 1)
    const g = graph as Record<string, { inputs: Record<string, unknown> }>
    expect(g['18'].inputs).toMatchObject({ width: 832, height: 480, length: 81 }) // 5s×16=80 → 81
    expect(g['19'].inputs.steps).toBe(20)
  })
})
