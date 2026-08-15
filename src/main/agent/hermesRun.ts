// Durable Hermes run record (C2). The goal a run was launched with lives only on runHermes's call stack, so
// Brooke's requestImprove (a separate entry) can't recover it and falls back to the spec — and nothing survives
// an app restart. This persists a small record per work folder (.nordcode/hermes/run.json) so the real goal is
// recoverable and a future "resume the team" affordance has state to resume from. Best-effort: every fs op is
// guarded — a failed read/write degrades to the old behaviour, never throws into the orchestrator.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type HermesRunStatus = 'running' | 'complete' | 'needs-integration' | 'needs-split' | 'improve-cap' | 'replan-empty' | 'max-rounds' | 'stopped' | 'error'

export interface HermesRunRecord {
  goal: string
  project: string
  startedAt: number
  updatedAt: number
  status: HermesRunStatus
}

function recordPath(cwd: string): string {
  return join(cwd, '.nordcode', 'hermes', 'run.json')
}

/** The run record for a work folder, or null if none/unreadable/corrupt. */
export function readRunRecord(cwd: string): HermesRunRecord | null {
  try {
    const raw = readFileSync(recordPath(cwd), 'utf8')
    const obj = JSON.parse(raw) as Partial<HermesRunRecord>
    if (typeof obj?.goal !== 'string' || typeof obj?.project !== 'string') return null
    return {
      goal: obj.goal,
      project: obj.project,
      startedAt: typeof obj.startedAt === 'number' ? obj.startedAt : 0,
      updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : 0,
      status: (obj.status as HermesRunStatus) ?? 'running'
    }
  } catch {
    return null
  }
}

/** Write the full record (best-effort; a failed write is swallowed — the record is an optimization). */
export function writeRunRecord(cwd: string, rec: HermesRunRecord): void {
  try {
    mkdirSync(join(cwd, '.nordcode', 'hermes'), { recursive: true })
    writeFileSync(recordPath(cwd), JSON.stringify(rec, null, 2))
  } catch {
    /* best-effort */
  }
}

/** Merge a patch onto the existing record (e.g. set the final status at run end), preserving goal/startedAt. */
export function patchRunRecord(cwd: string, patch: Partial<HermesRunRecord>, now: number): void {
  const cur = readRunRecord(cwd)
  if (!cur && !patch.goal) return // nothing to anchor a record on
  writeRunRecord(cwd, {
    goal: '',
    project: '',
    startedAt: now,
    ...(cur ?? {}),
    ...patch,
    updatedAt: now,
    status: patch.status ?? cur?.status ?? 'running'
  } as HermesRunRecord)
}
