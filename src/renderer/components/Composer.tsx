import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction
} from 'react'
import type { AgentMode, QueuedPrompt } from '../../shared/domain-types'
import { ModeSelector } from './ModeSelector'
import { EffortSelector, type ChatEffort } from './EffortSelector'
import { AddMenu } from './AddMenu'
import { Icon } from './Icon'
import { VoiceOrb, type OrbState } from './VoiceOrb'
import { BasenjiNook } from './BasenjiNook'
import type { PetState } from './BasenjiPet'
import { fileToImageDataUrl } from '../image'
import { PromptQueue } from './PromptQueue'

export interface SlashCommand {
  name: string
  desc: string
  run: () => void
}

/** Voice-mode controls surfaced in the composer (omitted entirely when voice is off). */
export interface ComposerVoice {
  orbState: OrbState
  levelRef: React.MutableRefObject<number>
  disabled?: boolean
  status?: string
  statusWarn?: boolean
  onPressStart: () => void
  onPressEnd: () => void
}

interface Popup {
  kind: 'mention' | 'command'
  items: string[]
  active: number
  range?: [number, number]
}

export function Composer(props: {
  input: string
  setInput: (v: string) => void
  images: string[]
  setImages: Dispatch<SetStateAction<string[]>>
  running: boolean
  disabled: boolean
  mode: AgentMode
  sessionId: string | null
  slashCommands: SlashCommand[]
  petState: PetState
  mascotEnabled: boolean
  voice?: ComposerVoice
  history: string[]
  queue: QueuedPrompt[]
  editingQueueId: string | null
  onChangeMode: (m: AgentMode) => void
  effort: ChatEffort
  onChangeEffort: (v: ChatEffort) => void
  onAddFiles: () => void
  onAddFolder: () => void
  onSend: () => void
  onSteer: () => void
  onStop: () => void
  onEditQueue: (id: string) => void
  onRemoveQueue: (id: string) => void
  onPromoteQueue: (id: string) => void
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [popup, setPopup] = useState<Popup | null>(null)
  const [pendingCaret, setPendingCaret] = useState<number | null>(null)
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const historyDraft = useRef('')
  // Monotonic token so a slow @mention lookup can't overwrite the popup for a newer keystroke.
  const popupSeq = useRef(0)

  async function addImageFiles(files: FileList | File[]): Promise<void> {
    const urls = (await Promise.all(Array.from(files).map(fileToImageDataUrl))).filter((u): u is string => u != null)
    if (urls.length) props.setImages((prev) => [...prev, ...urls])
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>): void {
    if (!e.clipboardData) return
    const imgs = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f != null)
    if (imgs.length) {
      e.preventDefault()
      void addImageFiles(imgs)
    }
  }

  function onPickImages(e: ChangeEvent<HTMLInputElement>): void {
    if (e.target.files) void addImageFiles(e.target.files)
    e.target.value = ''
  }

  useEffect(() => {
    const ta = taRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
    }
  }, [props.input])

  useEffect(() => {
    if (pendingCaret != null && taRef.current) {
      taRef.current.focus()
      taRef.current.setSelectionRange(pendingCaret, pendingCaret)
      setPendingCaret(null)
    }
  }, [pendingCaret, props.input])

  useEffect(() => {
    setHistoryIndex(null)
    historyDraft.current = ''
  }, [props.sessionId])

  async function updatePopups(v: string, caret: number): Promise<void> {
    const seq = ++popupSeq.current
    if (v.startsWith('/') && !/\s/.test(v)) {
      const q = v.slice(1).toLowerCase()
      const matches = props.slashCommands.filter((c) => c.name.toLowerCase().includes(q))
      setPopup(matches.length ? { kind: 'command', items: matches.map((c) => c.name), active: 0 } : null)
      return
    }
    const men = detectMention(v, caret)
    if (men && props.sessionId) {
      let files: string[] = []
      try {
        files = await window.api.workspace.listFiles({ sessionId: props.sessionId, query: men.query })
      } catch {
        files = [] // IPC failure — just show no suggestions rather than throwing into the void
      }
      if (seq !== popupSeq.current) return // a newer keystroke superseded this lookup
      setPopup(files.length ? { kind: 'mention', items: files, active: 0, range: [men.start, caret] } : null)
    } else {
      setPopup(null)
    }
  }

  function openSlash(): void {
    props.setInput('/')
    setPopup({ kind: 'command', items: props.slashCommands.map((c) => c.name), active: 0 })
    setTimeout(() => taRef.current?.focus(), 0)
  }

  function onChange(e: ChangeEvent<HTMLTextAreaElement>): void {
    const v = e.target.value
    setHistoryIndex(null)
    props.setInput(v)
    void updatePopups(v, e.target.selectionStart ?? v.length)
  }

  function selectItem(idx: number): void {
    if (!popup) return
    if (popup.kind === 'command') {
      const cmd = props.slashCommands.find((c) => c.name === popup.items[idx])
      setPopup(null)
      props.setInput('')
      cmd?.run()
      return
    }
    const path = popup.items[idx]
    // Re-detect the mention against the CURRENT input + caret instead of trusting the range captured
    // when the (async) popup opened — the user may have typed since, which would make the stored offsets
    // stale and splice the path in at the wrong position.
    const caret = taRef.current?.selectionStart ?? props.input.length
    const fresh = detectMention(props.input, caret)
    const [start, end] = fresh ? [fresh.start, caret] : (popup.range ?? [props.input.length, props.input.length])
    const before = props.input.slice(0, start)
    const after = props.input.slice(end)
    const insert = `@${path} `
    props.setInput(before + insert + after)
    setPopup(null)
    setPendingCaret(before.length + insert.length)
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (popup) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPopup({ ...popup, active: Math.min(popup.active + 1, popup.items.length - 1) })
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPopup({ ...popup, active: Math.max(popup.active - 1, 0) })
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        selectItem(popup.active)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setPopup(null)
        return
      }
    }
    if (e.key === 'ArrowUp' && props.history.length && (historyIndex !== null || !props.input)) {
      e.preventDefault()
      const next = historyIndex === null ? props.history.length - 1 : Math.max(0, historyIndex - 1)
      if (historyIndex === null) historyDraft.current = props.input
      setHistoryIndex(next)
      props.setInput(props.history[next])
      return
    }
    if (e.key === 'ArrowDown' && historyIndex !== null) {
      e.preventDefault()
      if (historyIndex < props.history.length - 1) {
        const next = historyIndex + 1
        setHistoryIndex(next)
        props.setInput(props.history[next])
      } else {
        setHistoryIndex(null)
        props.setInput(historyDraft.current)
      }
      return
    }
    if (
      e.key === 'Enter' &&
      (e.ctrlKey || e.metaKey) &&
      props.running &&
      !props.editingQueueId &&
      props.input.trim() &&
      props.images.length === 0
    ) {
      e.preventDefault()
      props.onSteer()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      props.onSend()
    }
  }

  const placeholder = props.disabled
    ? 'Choose a working folder to begin…'
    : props.running
      ? 'Type to queue · Ctrl+Enter steers the running task'
      : props.mode === 'plan'
        ? 'Plan mode (read-only) — ask for a plan…'
        : 'Ask the agent…  ( @ for files, / for commands )'

  return (
    <div className={`composer-wrap ${props.mascotEnabled ? '' : 'mascot-hidden'}`}>
      {props.mascotEnabled && <BasenjiNook state={props.petState} />}
      <PromptQueue
        entries={props.queue}
        editingId={props.editingQueueId}
        running={props.running}
        onEdit={props.onEditQueue}
        onRemove={props.onRemoveQueue}
        onPromote={props.onPromoteQueue}
      />
      {popup && (
        <div className="composer-popup">
          {popup.items.map((it, i) => (
            <button
              key={it}
              className={`popup-item ${i === popup.active ? 'active' : ''}`}
              onMouseEnter={() => setPopup({ ...popup, active: i })}
              onMouseDown={(e) => {
                e.preventDefault()
                selectItem(i)
              }}
            >
              {popup.kind === 'command' ? (
                <>
                  <span className="popup-cmd">/{it}</span>
                  <span className="popup-desc">{props.slashCommands.find((c) => c.name === it)?.desc}</span>
                </>
              ) : (
                <span className="popup-file">{it}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {props.images.length > 0 && (
        <div className="composer-attachments">
          {props.images.map((src, i) => (
            <div key={i} className="attach-thumb">
              <img src={src} alt="attachment" />
              <button
                className="attach-remove"
                title="Remove"
                aria-label="Remove image"
                onClick={() => props.setImages((prev) => prev.filter((_, j) => j !== i))}
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className={`composer ${props.mode === 'plan' ? 'plan' : ''}`}>
        <textarea
          ref={taRef}
          value={props.input}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          disabled={props.disabled}
          rows={1}
        />
        {props.running ? (
          <>
            {props.input.trim() && props.images.length === 0 && !props.editingQueueId && (
              <button
                className="send-btn steer"
                onClick={props.onSteer}
                title="Steer the running task (Ctrl+Enter)"
                aria-label="Send to steer"
              >
                <Icon name="zap" size={16} />
              </button>
            )}
            {(props.input.trim() || props.images.length > 0) && (
              <button className="send-btn" onClick={props.onSend} title="Queue message (Enter)" aria-label="Queue message">
                <Icon name="send" size={18} />
              </button>
            )}
            <button className="send-btn stop" onClick={props.onStop} title="Stop" aria-label="Stop">
              <Icon name="stop" size={14} />
            </button>
          </>
        ) : (
          <button
            className="send-btn"
            onClick={props.onSend}
            disabled={props.disabled || (!props.input.trim() && props.images.length === 0)}
            title="Send (Enter)"
            aria-label="Send"
          >
            <Icon name="send" size={18} />
          </button>
        )}
      </div>

      <div className="composer-bottom">
        <div className="composer-left">
          <AddMenu
            onAddFiles={props.onAddFiles}
            onAddFolder={props.onAddFolder}
            onAddImage={() => fileRef.current?.click()}
            onSlash={openSlash}
          />
          <ModeSelector mode={props.mode} onChange={props.onChangeMode} />
          <EffortSelector value={props.effort} onChange={props.onChangeEffort} />
          {props.voice && (
            <div className="voice-row">
              <VoiceOrb
                state={props.voice.orbState}
                levelRef={props.voice.levelRef}
                disabled={props.voice.disabled}
                onPressStart={props.voice.onPressStart}
                onPressEnd={props.voice.onPressEnd}
              />
              {props.voice.status && (
                <span className={`voice-status ${props.voice.statusWarn ? 'warn' : ''}`}>{props.voice.status}</span>
              )}
            </div>
          )}
        </div>
        <span className="composer-hint">
          {props.running
            ? 'Enter queues · Ctrl+Enter steers · Shift+Enter newline'
            : 'Enter to send · Shift+Enter newline · Ctrl+K palette'}
        </span>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={onPickImages}
      />
    </div>
  )
}

function detectMention(text: string, caret: number): { query: string; start: number } | null {
  let i = caret - 1
  while (i >= 0 && !/\s/.test(text[i]) && text[i] !== '@') i--
  if (i >= 0 && text[i] === '@') {
    const token = text.slice(i + 1, caret)
    if (/^[\w./\-]*$/.test(token)) return { query: token, start: i }
  }
  return null
}
