import { useEffect, useRef, useState } from 'react'
import type { AgentEvent } from '../../shared/ipc-types'

/** A lightweight planning conversation inside the Loop shell. Reuses the real agent engine (so it has the
 *  `kanban` tool to plan/spec tickets) but renders a minimal message list — not the full chat surface. */
interface ChatItem {
  id: number
  role: 'user' | 'assistant' | 'tool' | 'notice'
  text: string
  callId?: string
  awaiting?: boolean
}

export function LoopChat({ cwd, project }: { cwd: string; project: string }) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [items, setItems] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const turnRef = useRef<string | null>(null)
  const seq = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  // A dedicated planning session, scoped to the loop's folder, in ask mode (so edits gate but kanban runs free).
  useEffect(() => {
    let live = true
    window.api.sessions
      .create(cwd || '.')
      .then((s) => {
        if (!live) return
        setSessionId(s.id)
        void window.api.agent.setMode({ sessionId: s.id, mode: 'ask' })
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [cwd])

  useEffect(() => {
    const off = window.api.agent.onEvent((e) => {
      // agent.onEvent is the GLOBAL event channel — every session's turn broadcasts here, including the main
      // chat that stays mounted (display-hidden) behind the Loop tab. Fold in ONLY events for THIS loop chat's
      // own turn; otherwise a concurrent main-chat turn streams its deltas / tool chips / approval buttons into
      // this list. Mirror App.tsx's turnId routing. (session-titled/session-cwd carry no turnId, so skip them.)
      if (e.type === 'session-titled' || e.type === 'session-cwd' || e.turnId !== turnRef.current) return
      setItems((cur) => reduce(cur, e, () => ++seq.current))
      if (e.type === 'turn-done') setBusy(false)
    })
    return () => off()
  }, [])

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    })
    return () => cancelAnimationFrame(raf)
  }, [items])

  async function send(): Promise<void> {
    const text = input.trim()
    if (!text || !sessionId || busy) return
    setItems((cur) => [...cur, { id: ++seq.current, role: 'user', text }])
    setInput('')
    setBusy(true)
    try {
      const { turnId } = await window.api.agent.startTurn({ sessionId, userText: text })
      turnRef.current = turnId
    } catch {
      setBusy(false)
    }
  }

  function decide(callId: string, decision: 'approve' | 'reject'): void {
    const turnId = turnRef.current
    if (!turnId) return
    void window.api.agent.decide({ turnId, callId, decision })
    setItems((cur) => cur.map((it) => (it.callId === callId ? { ...it, awaiting: false } : it)))
  }

  return (
    <div className="loop-chat">
      <div className="loop-chat-msgs" ref={scrollRef}>
        {items.length === 0 && (
          <div className="loop-chat-empty">
            Plan this loop here — e.g. “break the auth feature into board tickets for <b>{project}</b>”. I can
            create and order tickets; start the drain with the button above.
          </div>
        )}
        {items.map((it) => (
          <div key={it.id} className={`loop-chat-item lc-${it.role}`}>
            {it.role === 'tool' ? (
              <>
                <span className="lc-tool">⚙ {it.text}</span>
                {it.awaiting && it.callId && (
                  <span className="lc-approve">
                    <button className="btn" onClick={() => decide(it.callId!, 'approve')}>
                      Approve
                    </button>
                    <button className="btn reject" onClick={() => decide(it.callId!, 'reject')}>
                      Reject
                    </button>
                  </span>
                )}
              </>
            ) : (
              it.text
            )}
          </div>
        ))}
      </div>
      <div className="loop-chat-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={sessionId ? 'Plan the loop…' : 'starting…'}
          rows={2}
        />
        <button className="btn primary" disabled={!input.trim() || !sessionId || busy} onClick={() => void send()}>
          Send
        </button>
      </div>
    </div>
  )
}

/** Fold one agent event into the minimal item list. */
function reduce(items: ChatItem[], e: AgentEvent, nextId: () => number): ChatItem[] {
  switch (e.type) {
    case 'assistant-delta': {
      const last = items[items.length - 1]
      if (last && last.role === 'assistant') {
        return [...items.slice(0, -1), { ...last, text: last.text + e.text }]
      }
      return [...items, { id: nextId(), role: 'assistant', text: e.text }]
    }
    case 'tool-call-proposed':
      return [...items, { id: nextId(), role: 'tool', text: e.name, callId: e.callId }]
    case 'awaiting-approval':
      return items.map((it) => (it.callId === e.callId ? { ...it, awaiting: true } : it))
    case 'tool-result':
      return items.map((it) => (it.callId === e.callId ? { ...it, awaiting: false, text: `${it.text} — ${e.ok ? 'done' : 'failed'}` } : it))
    case 'notice':
      return [...items, { id: nextId(), role: 'notice', text: e.text }]
    case 'turn-done':
      return e.error ? [...items, { id: nextId(), role: 'notice', text: `error: ${e.error}` }] : items
    default:
      return items
  }
}
