import { describe, expect, it } from 'vitest'
import { prepareMarkdownText, visibleAssistantText } from './chatText'

describe('chat text presentation', () => {
  it('turns long unfenced code-looking runs into fenced markdown', () => {
    const text = [
      'Here is the relevant helper:',
      '',
      'const PALETTE = { grass: "#5a9e3a" };',
      'function shadeColor(hex, factor) {',
      '  const value = parseInt(hex.slice(1), 16);',
      '  const r = value >> 16;',
      '  return r * factor;',
      '}',
      '',
      'That should fix the rendering.'
    ].join('\n')

    expect(prepareMarkdownText(text)).toContain('```ts\nconst PALETTE')
    expect(prepareMarkdownText(text)).toContain('```\n\nThat should fix')
  })

  it('leaves ordinary prose lists alone', () => {
    const text = [
      'Next steps:',
      '- Check the preview.',
      '- Review the diff.',
      '- Ask Hans before reinstalling.',
      '- Keep the mascot intact.',
      '- Run typecheck.'
    ].join('\n')

    expect(prepareMarkdownText(text)).toBe(text)
  })

  it('keeps hiding leaked text tool-call fragments', () => {
    expect(visibleAssistantText('<tool_call>\n<function=read_file>\n<parameter=path>a.ts</parameter>\n</tool_call>')).toBe('')
  })
})
