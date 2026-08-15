// A tiny pause gate the Hermes orchestrator awaits BETWEEN rounds, so a pause genuinely holds across the whole
// decompose→drain→replan cycle. Without it, pausing only halts the in-flight drain; the orchestrator's next
// round calls boardRunner.start(), which treats the paused drain as "resuming" and silently un-pauses it.
// Pure (no electron/timers) so it unit-tests headless; ipc.ts owns the single live instance and wires the
// pause/resume controls (Brooke's tools + the header button) to it.

export interface PauseGate {
  isPaused(): boolean
  pause(): void
  resume(): void
  /**
   * Resolves immediately when not paused; otherwise resolves when `resume()` is called (or `signal` aborts —
   * so a Stop never deadlocks a paused run). Multiple concurrent waiters are all released on resume/abort.
   */
  waitWhilePaused(signal?: AbortSignal): Promise<void>
}

export function createPauseGate(): PauseGate {
  let paused = false
  let waiters: Array<() => void> = []
  const release = (): void => {
    const pending = waiters
    waiters = []
    for (const r of pending) r()
  }
  return {
    isPaused: () => paused,
    pause: () => {
      paused = true
    },
    resume: () => {
      paused = false
      release()
    },
    waitWhilePaused: (signal) => {
      if (!paused || signal?.aborted) return Promise.resolve()
      return new Promise<void>((resolve) => {
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', finish)
          resolve()
        }
        waiters.push(finish)
        signal?.addEventListener('abort', finish, { once: true })
      })
    }
  }
}
