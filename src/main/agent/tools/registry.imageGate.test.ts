import { describe, expect, it } from 'vitest'
import { buildRegistry, imageGenConfigured } from './index'
import { DEFAULT_SETTINGS, type ImageConfig } from '../../../shared/domain-types'

const img = (over: Partial<ImageConfig>): ImageConfig => ({ ...DEFAULT_SETTINGS.image, ...over })

describe('B3 image-generation feature flag', () => {
  it('default registry keeps the tools (back-compat for callers without opts)', () => {
    const names = buildRegistry().list().map((t) => t.name)
    expect(names).toContain('generate_image')
    expect(names).toContain('generate_video')
  })

  it('imageGen:false removes both tools — the model never sees them', () => {
    const names = buildRegistry({ imageGen: false }).list().map((t) => t.name)
    expect(names).not.toContain('generate_image')
    expect(names).not.toContain('generate_video')
    expect(names).toContain('read_file') // rest of the registry intact
  })

  it('fresh install is NOT configured (local provider, default URL, no launcher)', () => {
    expect(imageGenConfigured(img({}))).toBe(false)
  })

  it('a configured launcher (incl. the legacy-adoption path) enables generation', () => {
    expect(imageGenConfigured(img({ launcherPath: 'D:\\Software\\ComfyUI\\run_nordcode_comfy.bat' }))).toBe(true)
  })

  it('a deliberately configured server URL enables generation', () => {
    expect(imageGenConfigured(img({ baseURL: 'http://192.168.1.50:8188' }))).toBe(true)
  })

  it('cloud providers hinge on the API key', () => {
    expect(imageGenConfigured(img({ provider: 'openai', apiKey: '' }))).toBe(false)
    expect(imageGenConfigured(img({ provider: 'openai', apiKey: 'sk-x' }))).toBe(true)
  })
})
