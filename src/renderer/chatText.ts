const TOOL_CALL_MARKER = /<tool_call\b|<function=|<parameter=/i

/** Hide raw XML text-tool-call fragments when a weak model leaks them into assistant prose. */
export function visibleAssistantText(text: string): string {
  let out = text
    .replace(/<tool_call\b[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<tool_call\b[\s\S]*$/gi, '')
    .replace(/^\s*<function=[^>\n]+>.*$/gim, '')
    .replace(/^\s*<parameter=[^>\n]+>.*$/gim, '')

  out = out
    .split('\n')
    .filter((line) => !/^\s*<\/?(tool_call|function|parameter)\b/i.test(line))
    .join('\n')

  return out.replace(/\n{3,}/g, '\n\n').trim()
}

export function isHiddenAssistantNoise(text: string): boolean {
  return TOOL_CALL_MARKER.test(text) && visibleAssistantText(text).trim().length === 0
}

export function prepareMarkdownText(text: string): string {
  const lines = text.split(/\r\n|\r|\n/)
  const out: string[] = []
  let index = 0
  let fenced = false

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      out.push(line)
      index++
      continue
    }

    if (fenced || !isCodeLikeLine(line)) {
      out.push(line)
      index++
      continue
    }

    const start = index
    const block: string[] = []
    let blankCount = 0
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (/^\s*```/.test(current)) break
      if (!current.trim()) {
        if (blankCount >= 1) break
        blankCount++
        block.push(current)
        index++
        continue
      }
      if (!isCodeLikeLine(current)) break
      blankCount = 0
      block.push(current)
      index++
    }

    const codeLines = block.filter((part) => part.trim())
    if (codeLines.length >= 5 && codeSignalScore(codeLines) >= codeLines.length + 2) {
      const previous = out[out.length - 1]
      if (previous?.trim()) out.push('')
      out.push(`\`\`\`${guessLanguage(codeLines)}`)
      out.push(...block)
      out.push('```')
      if ((lines[index] ?? '').trim()) out.push('')
    } else {
      out.push(...lines.slice(start, index))
    }
  }

  return out.join('\n')
}

function isCodeLikeLine(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (/^(const|let|var|function|class|interface|type|enum|import|export|return|if|else|for|while|switch|case|try|catch|finally|async|await)\b/.test(t)) return true
  if (/^(public|private|protected|static|def|from|package|using|namespace|struct|impl|fn)\b/.test(t)) return true
  if (/^(\/\/|\/\*|\*|#|<!--|-->|<\/?[a-z][\w:-]*\b)/i.test(t)) return true
  if (/^[\]}),;]+$/.test(t)) return true
  if (/^\s{2,}\S/.test(line) && /[{}()[\];=<>]/.test(t)) return true
  if (/[{}()[\];]/.test(t) && /(=>|==|===|!=|!==|:=|=|: \w|,\s*$)/.test(t)) return true
  return false
}

function codeSignalScore(lines: string[]): number {
  return lines.reduce((score, line) => {
    const t = line.trim()
    let next = score
    if (/^(const|let|var|function|class|interface|type|enum|import|export|return|if|else|for|while|switch|case|try|catch|finally|async|await)\b/.test(t)) next += 2
    if (/^(def|from|package|using|namespace|struct|impl|fn|public|private|protected|static)\b/.test(t)) next += 2
    if (/[{}()[\];]/.test(t)) next += 1
    if (/(=>|==|===|!=|!==|:=|=)/.test(t)) next += 1
    if (/^(\/\/|\/\*|\*|#|<!--|-->|<\/?[a-z][\w:-]*\b)/i.test(t)) next += 1
    return next
  }, 0)
}

function guessLanguage(lines: string[]): string {
  const sample = lines.join('\n')
  if (/\b(const|let|var|function|import|export|interface|type)\b|=>|console\./.test(sample)) return 'ts'
  if (/\bdef\b|\bfrom\s+\w+\s+import\b|:\s*$/.test(sample)) return 'py'
  if (/<\/?[a-z][\w:-]*\b/i.test(sample)) return 'html'
  if (/\b(fn|impl|let mut)\b/.test(sample)) return 'rs'
  if (/#include|std::/.test(sample)) return 'cpp'
  return ''
}
