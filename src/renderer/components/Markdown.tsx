import { isValidElement, memo, useState, type HTMLAttributes, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { CopyButton } from './CopyButton'
import { Icon } from './Icon'
import { prepareMarkdownText } from '../chatText'

/** Renders model output as GitHub-flavored markdown with syntax-highlighted code blocks.
 * react-markdown does not render raw HTML, so model text cannot inject scripts.
 * Memoized on `text`: parsing + highlight.js is O(n) per render, so without this every streamed
 * token re-parses every prior message. With memoization only the message whose text changed re-renders. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const displayText = prepareMarkdownText(text)
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{ pre: CodePre }}
      >
        {displayText}
      </ReactMarkdown>
    </div>
  )
})

function CodePre({ children, ...props }: HTMLAttributes<HTMLPreElement>) {
  const [expanded, setExpanded] = useState(false)
  const language = codeLanguage(children)
  const text = plainText(children).replace(/\n$/, '')
  const lineCount = text ? text.split(/\r\n|\r|\n/).length : 0
  const shouldCollapse = lineCount > 10 || text.length > 1600
  const collapsed = shouldCollapse && !expanded
  const preClass = [props.className, 'code-artifact-pre', collapsed ? 'is-collapsed' : '', shouldCollapse && expanded ? 'is-expanded' : '']
    .filter(Boolean)
    .join(' ')
  return (
    <div className={`code-artifact ${shouldCollapse ? 'is-long' : ''}`}>
      <div className="code-artifact-head">
        <span className="code-artifact-meta">
          <span className="code-artifact-kind">{language || 'code'}</span>
          {lineCount > 0 && <span className="code-artifact-lines">{lineCount} line{lineCount === 1 ? '' : 's'}</span>}
        </span>
        <span className="code-artifact-actions">
          {shouldCollapse && (
            <button
              type="button"
              className="code-artifact-toggle"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${language || 'code'} block, ${lineCount} line${lineCount === 1 ? '' : 's'}`}
              title={expanded ? 'Collapse code' : 'Expand code'}
            >
              <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={13} />
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          )}
          <CopyButton text={text} />
        </span>
      </div>
      <pre {...props} className={preClass}>{children}</pre>
    </div>
  )
}

function codeLanguage(children: ReactNode): string {
  const child = Array.isArray(children) ? children[0] : children
  if (!isValidElement<{ className?: string }>(child)) return ''
  const match = /language-([\w-]+)/.exec(child.props.className ?? '')
  return match?.[1] ?? ''
}

function plainText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(plainText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return plainText(node.props.children)
  return ''
}
