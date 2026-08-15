import type { Api } from '../shared/ipc-types'
import type { DetailedHTMLProps, HTMLAttributes } from 'react'

declare global {
  interface Window {
    api: Api
  }
}

// Electron's <webview> tag (used by the Preview panel). Typed minimally so JSX accepts it.
type WebviewProps = DetailedHTMLProps<
  HTMLAttributes<HTMLElement> & {
    src?: string
    partition?: string
    allowpopups?: string
    useragent?: string
  },
  HTMLElement
>

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: WebviewProps
    }
  }
}

export {}
