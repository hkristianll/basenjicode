import { describe, it, expect } from 'vitest'
import { runBranchName, canonicalizeProject, projectFolder, resolveRaidCwd, capExceeded, commitMessage, decideStop, pickReopenTargets, type LoopCaps, type RunCounters, type StopInput } from './loop-safety'

describe('runBranchName', () => {
  it('slug + sortable UTC stamp', () => {
    expect(runBranchName('My Repo', new Date(Date.UTC(2026, 5, 21, 9, 30, 0)))).toBe('board/my-repo-20260621-093000')
  })
  it('blank project → run slug', () => {
    expect(runBranchName('   ', new Date(Date.UTC(2026, 0, 1, 0, 0, 0)))).toBe('board/run-20260101-000000')
  })
  it('collapses runs of non-alphanumerics and trims edges', () => {
    expect(runBranchName('  __A!!b--C__  ', new Date(Date.UTC(2026, 0, 1, 0, 0, 0)))).toBe('board/a-b-c-20260101-000000')
  })
  it('zero-pads every field', () => {
    expect(runBranchName('p', new Date(Date.UTC(2026, 2, 5, 4, 6, 8)))).toBe('board/p-20260305-040608')
  })
})

describe('canonicalizeProject', () => {
  it('merges case + surrounding/internal whitespace drift to ONE key', () => {
    expect(canonicalizeProject('3D Slicer ')).toBe('3d slicer')
    expect(canonicalizeProject('3d  slicer')).toBe('3d slicer')
    expect(canonicalizeProject('  3d slicer  ')).toBe('3d slicer')
  })
  it('is a NO-OP on existing live board keys (no orphaning / no migration)', () => {
    // Real keys from the running board — none may change, or the existing board is orphaned.
    for (const k of ['3d slicer', '3d slicer.3', '3d slicer2', '3d-slicer-3', 'balloon-burst-defense', 'critter-keep', 'nordcode-mcp']) {
      expect(canonicalizeProject(k)).toBe(k)
    }
  })
  it('does NOT slug to dashes (so it cannot collide a spaced key with a dashed one)', () => {
    expect(canonicalizeProject('3d slicer')).not.toBe('3d-slicer')
    expect(canonicalizeProject('3d slicer.3')).not.toBe(canonicalizeProject('3d-slicer-3'))
  })
  it('blank → "project"', () => {
    expect(canonicalizeProject('   ')).toBe('project')
    expect(canonicalizeProject('')).toBe('project')
  })
})

describe('projectFolder', () => {
  it('is input-invariant under canonicalization — the run cwd (raw) and brookeCwd (canonical key) resolve to ONE folder', () => {
    expect(projectFolder('3D Slicer 3')).toBe(projectFolder('3d slicer 3'))
    expect(projectFolder('  3d  slicer 3 ')).toBe('3d slicer 3')
  })
  it('strips filesystem-illegal characters', () => {
    expect(projectFolder('a/b:c*?')).toBe('abc')
    expect(projectFolder('foo<bar>')).toBe('foobar')
  })
  it('matches the canonical board key for fs-legal names (folder ↔ key stay 1:1)', () => {
    for (const k of ['3d slicer', '3d slicer.3', '3d-slicer-3', 'balloon-burst-defense']) {
      expect(projectFolder(k)).toBe(canonicalizeProject(k))
    }
  })
  it('blank → "project"', () => {
    expect(projectFolder('   ')).toBe('project')
    expect(projectFolder('')).toBe('project')
  })
})

describe('resolveRaidCwd', () => {
  it('an explicit per-raid override wins over the derived base/<name>', () => {
    expect(
      resolveRaidCwd('critter-keep', { raidFolders: { 'critter-keep': 'D:\\repos\\critter-keep' }, lastCwd: 'C:\\root' })
    ).toBe('D:\\repos\\critter-keep')
  })
  it('matches the override on the CANONICAL key even when called with a case/space variant', () => {
    expect(
      resolveRaidCwd('  Critter-Keep ', { raidFolders: { 'critter-keep': 'D:\\repos\\ck' } })
    ).toBe('D:\\repos\\ck')
  })
  it('falls back to <lastCwd>/<projectFolder>, inferring the separator from the base', () => {
    expect(resolveRaidCwd('My Proj', { lastCwd: 'C:\\work' })).toBe('C:\\work\\my proj')
    expect(resolveRaidCwd('My Proj', { lastCwd: '/home/u/work/' })).toBe('/home/u/work/my proj')
  })
  it('uses hermesProjectsRoot only when lastCwd is empty (legacy fallback)', () => {
    expect(resolveRaidCwd('p', { lastCwd: '', hermesProjectsRoot: 'C:\\root' })).toBe('C:\\root\\p')
  })
  it('returns "" when nothing is configured (caller decides its own fallback)', () => {
    expect(resolveRaidCwd('p', {})).toBe('')
  })
})

describe('capExceeded', () => {
  const caps: LoopCaps = { maxTickets: 5, tokenBudget: 1000, wallClockMs: 60000, maxConsecutiveFailures: 3 }
  const base: RunCounters = { ticketsDone: 0, tokensUsed: 0, startedAt: 0, consecutiveFailures: 0 }

  it('returns null when nothing is breached', () => {
    expect(capExceeded(caps, base, 0)).toBeNull()
  })
  it('reports max-tickets first, before any other breach', () => {
    expect(capExceeded(caps, { ticketsDone: 5, tokensUsed: 9999, startedAt: 0, consecutiveFailures: 9 }, 999999)).toBe('max-tickets')
  })
  it('token-budget when tokensUsed reaches the budget', () => {
    expect(capExceeded(caps, { ...base, tokensUsed: 1000 }, 0)).toBe('token-budget')
  })
  it('wall-clock when elapsed >= wallClockMs', () => {
    expect(capExceeded(caps, base, 60000)).toBe('wall-clock')
  })
  it('consecutive-failures last', () => {
    expect(capExceeded(caps, { ...base, consecutiveFailures: 3 }, 0)).toBe('consecutive-failures')
  })
  it('non-positive cap values mean unlimited (skipped)', () => {
    const noCap: LoopCaps = { maxTickets: 0, tokenBudget: 0, wallClockMs: 0, maxConsecutiveFailures: 0 }
    expect(capExceeded(noCap, { ticketsDone: 1e9, tokensUsed: 1e9, startedAt: 0, consecutiveFailures: 1e9 }, 1e9)).toBeNull()
  })
})

describe('commitMessage', () => {
  it('formats #id + title and collapses internal whitespace/newlines', () => {
    expect(commitMessage({ id: 7, title: 'Wire  up\nthe  API' })).toBe('loop: #7 Wire up the API')
  })
  it('accepts a string id', () => {
    expect(commitMessage({ id: 'T5', title: ' Eval ' })).toBe('loop: #T5 Eval')
  })
})

describe('decideStop', () => {
  const caps: LoopCaps = { maxTickets: 5, tokenBudget: 1000, wallClockMs: 60000, maxConsecutiveFailures: 3 }
  // Work remains, nothing tripped: the baseline "keep draining" input.
  const live: StopInput = {
    ready: 2,
    inProgress: 0,
    review: 0,
    ticketsRun: 0,
    tokensUsed: 0,
    elapsedMs: 0,
    consecutiveFailures: 0,
    caps,
    paused: false
  }

  it('board-green when nothing ready, in-flight, or in review', () => {
    expect(decideStop({ ...live, ready: 0, inProgress: 0, review: 0 })).toEqual({ stop: true, reason: 'board-green' })
  })
  it('in-flight work (in review) is NOT green', () => {
    expect(decideStop({ ...live, ready: 0, inProgress: 0, review: 1 })).toEqual({ stop: false, reason: 'none' })
  })
  it('paused stops with the paused reason when work remains', () => {
    expect(decideStop({ ...live, paused: true })).toEqual({ stop: true, reason: 'paused' })
  })
  it('max-tickets cap', () => {
    expect(decideStop({ ...live, ticketsRun: 5 })).toEqual({ stop: true, reason: 'max-tickets' })
  })
  it('token-budget cap → max-tokens', () => {
    expect(decideStop({ ...live, tokensUsed: 1000 })).toEqual({ stop: true, reason: 'max-tokens' })
  })
  it('wall-clock cap', () => {
    expect(decideStop({ ...live, elapsedMs: 60000 })).toEqual({ stop: true, reason: 'wall-clock' })
  })
  it('consecutive-failures cap → max-failures', () => {
    expect(decideStop({ ...live, consecutiveFailures: 3 })).toEqual({ stop: true, reason: 'max-failures' })
  })
  it('keeps draining when work remains, no cap, not paused', () => {
    expect(decideStop(live)).toEqual({ stop: false, reason: 'none' })
  })
})

describe('pickReopenTargets', () => {
  it('returns all review tickets when nothing is excluded', () => {
    expect(pickReopenTargets([4, 5, 6], [])).toEqual([4, 5, 6])
  })
  it('skips tickets already reopened this run (no churn)', () => {
    expect(pickReopenTargets([4, 5, 6], [5])).toEqual([4, 6])
  })
  it('skips tickets the user set aside (skip)', () => {
    expect(pickReopenTargets([4, 5, 6], new Set([4, 6]))).toEqual([5])
  })
  it('returns empty when every review ticket is excluded (→ board-green stands)', () => {
    expect(pickReopenTargets([4, 5], [4, 5])).toEqual([])
  })
})
