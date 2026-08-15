import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { BgTask } from '../shared/ipc-types'
import { resolveShellInvocation, treeKill, SPAWN_DETACHED } from './shell/powershell'

interface Task {
  id: string
  command: string
  cwd: string
  status: 'running' | 'exited' | 'killed'
  code: number | null
  startedAt: number
  output: string
  child: ChildProcess
}

const MAX_OUTPUT = 200_000
const TAIL = 6000

/** Tracks long-running background processes started by the run_background tool. */
class BgTaskManager {
  private tasks = new Map<string, Task>()
  private listeners = new Set<() => void>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined

  onUpdate(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  // Coalesce bursts of output into ~10 updates/sec so the renderer isn't flooded.
  private notify(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      for (const cb of this.listeners) cb()
    }, 100)
  }

  private evict(): void {
    const MAX = 20
    if (this.tasks.size <= MAX) return
    const finished = [...this.tasks.values()]
      .filter((t) => t.status !== 'running')
      .sort((a, b) => a.startedAt - b.startedAt)
    for (const t of finished) {
      if (this.tasks.size <= MAX) break
      this.tasks.delete(t.id)
    }
  }

  start(command: string, cwd: string): string {
    const id = randomUUID().slice(0, 8)
    // Same hardened invocation as run_shell: PowerShell (PS7 when available) on Windows, $SHELL on
    // POSIX. detached on POSIX so the dev-server tree can be group-killed on stop/quit.
    const { exe, args } = resolveShellInvocation(command)
    const child = spawn(exe, args, { cwd, windowsHide: true, detached: SPAWN_DETACHED })
    const task: Task = {
      id,
      command,
      cwd,
      status: 'running',
      code: null,
      startedAt: Date.now(),
      output: '',
      child
    }
    // Decode as UTF-8 at the stream level so multi-byte glyphs (box-drawing, ✓/✗, arrows emitted by
    // npm/vite/tsc) that straddle a chunk boundary aren't corrupted into U+FFFD — both in the panel
    // and in the read_background output the model consumes.
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    const append = (d: string): void => {
      task.output += d
      if (task.output.length > MAX_OUTPUT) task.output = task.output.slice(task.output.length - MAX_OUTPUT)
      this.notify()
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', (e) => {
      task.output += `\n[error] ${e.message}`
      task.status = 'exited'
      task.code = -1
      this.notify()
    })
    child.on('close', (code) => {
      if (task.status === 'running') {
        task.status = 'exited'
        task.code = code
      }
      this.notify()
    })
    this.tasks.set(id, task)
    this.evict()
    this.notify()
    return id
  }

  stop(id: string): void {
    const t = this.tasks.get(id)
    if (!t || t.status !== 'running') return
    if (t.child.pid) treeKill(t.child.pid)
    else t.child.kill()
    t.status = 'killed'
    this.notify()
  }

  /** Synchronous tree-kill of every running task — safe to call from before-quit. */
  killAll(): void {
    for (const t of this.tasks.values()) {
      if (t.status !== 'running') continue
      if (t.child.pid) treeKill(t.child.pid, { sync: true })
      else t.child.kill()
      t.status = 'killed'
    }
  }

  output(id: string): string {
    return this.tasks.get(id)?.output ?? ''
  }

  /** How many tasks are currently running — used to cap concurrent background processes. */
  runningCount(): number {
    let n = 0
    for (const t of this.tasks.values()) if (t.status === 'running') n++
    return n
  }

  /**
   * The id of an already-running task with this exact command+cwd, if any. run_background uses this to
   * REUSE a live dev server instead of spawning a duplicate — a second `npm run dev` binds a new port
   * (5174, 5175…) and floods localhost while the preview still points at the old one.
   */
  findRunning(command: string, cwd: string): string | null {
    for (const t of this.tasks.values()) {
      if (t.status === 'running' && t.command === command && t.cwd === cwd) return t.id
    }
    return null
  }

  list(): BgTask[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((t) => ({
        id: t.id,
        command: t.command,
        status: t.status,
        code: t.code,
        startedAt: t.startedAt,
        outputTail: t.output.length > TAIL ? `…${t.output.slice(t.output.length - TAIL)}` : t.output
      }))
  }
}

export const bgTasks = new BgTaskManager()
