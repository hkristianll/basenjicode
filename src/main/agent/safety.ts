import type { AgentMode, AllowList } from '../../shared/domain-types'
import type { ApprovalDecision } from '../../shared/ipc-types'
import type { ToolDef } from './registry'
import { screenShellCommand, type ShellScreenVerdict } from './shellScreen'

export interface ApprovalRequestInfo {
  callId: string
  toolName: string
  args: unknown
}

/** Async approval callback the loop awaits; resolves with the user's decision (and optional note). */
export type ApprovalFn = (req: ApprovalRequestInfo) => Promise<{ decision: ApprovalDecision; note?: string }>

export interface AuthorizeResult {
  allowed: boolean
  reason?: string
}

/**
 * Gates mutating tool calls according to the active mode:
 *  - plan        : deny all mutations (read-only)
 *  - ask         : prompt for every mutation (honoring the session allow-list)
 *  - acceptEdits : auto-approve file edits, still prompt for shell commands
 *  - auto        : auto-approve everything
 */
export class SafetyController {
  private allowAlwaysTool = new Set<string>()
  private allowAlwaysExact = new Set<string>()
  // EXACT shell commands the user chose "always allow" for. NOT a prefix list, despite the serialized
  // `shellPrefixes` field name (kept for back-compat): matching is whole-command equality (shellAllowed).
  // Do NOT turn this into prefix matching — `npm run dev` as a prefix would also authorize
  // `npm run dev; Remove-Item -Recurse ...` and reintroduce a shell-injection hole.
  private allowShellExact = new Set<string>()

  constructor(
    private approvalFn: ApprovalFn,
    private mode: AgentMode,
    initial?: AllowList,
    /** W3a shell screening for AUTO mode: `screenShell` turns the classifier on (default on via config),
     *  `workspaceRoot` anchors the outside-workspace check, and `headless` picks the flagged-command
     *  outcome — deny-with-guidance (board/sub-agent workers, no human present) vs downgrade to an
     *  approval prompt (chat, where a human can decide). */
    private screening: { screenShell?: boolean; headless?: boolean; workspaceRoot?: string } = {}
  ) {
    if (initial) {
      for (const t of initial.tools) this.allowAlwaysTool.add(t)
      for (const e of initial.exact) this.allowAlwaysExact.add(e)
      for (const p of initial.shellPrefixes) this.allowShellExact.add(p)
    }
  }

  setMode(mode: AgentMode): void {
    this.mode = mode
  }

  getAllowList(): AllowList {
    return {
      tools: [...this.allowAlwaysTool],
      exact: [...this.allowAlwaysExact],
      shellPrefixes: [...this.allowShellExact]
    }
  }

  clear(): void {
    this.allowAlwaysTool.clear()
    this.allowAlwaysExact.clear()
    this.allowShellExact.clear()
  }

  async authorize(def: ToolDef, args: unknown, callId: string): Promise<AuthorizeResult> {
    if (!def.mutating) return { allowed: true }

    if (this.mode === 'plan') {
      return {
        allowed: false,
        reason:
          'plan mode is active (read-only); mutating actions are disabled — describe the change in text instead of performing it'
      }
    }

    // Auto mode runs everything without prompting — including shell — matching its documented
    // behavior ("Run everything without asking") and Claude Code's full-auto. The user opts into
    // this explicitly; the cautious default (Ask) and Accept keep shell gated behind a human.
    // W3a exception: a DANGEROUS shell command (outside-workspace write, download-execute, system
    // mutation, credential paths) is screened even in auto — denied with guidance when headless
    // (board workers: the model can adapt instead of hanging), or dropped through to the approval
    // prompt below in chat (where the allow-list still lets a repeat-approved command run smoothly).
    if (this.mode === 'auto') {
      const verdict = this.screenIfShell(def, args)
      if (verdict.ok) return { allowed: true }
      if (this.screening.headless) {
        return {
          allowed: false,
          reason:
            `blocked by shell screening (${verdict.class}): ${verdict.reason}. ` +
            'Work INSIDE the workspace folder with relative paths; do not download-and-execute, change system configuration, or touch credentials.'
        }
      }
      // fall through to the ask-mode prompt for this one call
    }

    // Accept-edits auto-applies file edits but still prompts for shell commands.
    if (def.category === 'edit' && this.mode === 'acceptEdits') return { allowed: true }

    // Otherwise prompt, honoring the session allow-list ("always allow" decisions).
    const exactKey = `${def.name}:${stableStringify(args)}`
    if (this.allowAlwaysTool.has(def.name)) return { allowed: true }
    if (this.allowAlwaysExact.has(exactKey)) return { allowed: true }
    if (def.category === 'shell' && this.shellAllowed((args as { command?: string }).command)) {
      return { allowed: true }
    }

    const { decision, note } = await this.approvalFn({ callId, toolName: def.name, args })
    if (decision === 'reject') {
      return { allowed: false, reason: note ? `the user denied this action — note: ${note}` : 'the user denied this action' }
    }
    if (decision === 'always_tool') this.allowAlwaysTool.add(def.name)
    if (decision === 'always_exact') {
      // Shell commands are executable programs, not an argument list we can safely extend.
      // A prefix rule for `npm run dev` would also authorize `npm run dev; Remove-Item ...`.
      // Keep this decision exact; users can explicitly approve a different command when needed.
      if (def.category === 'shell') this.allowShellExact.add(((args as { command?: string }).command ?? '').trim())
      else this.allowAlwaysExact.add(exactKey)
    }
    return { allowed: true }
  }

  /** Screen a shell call when screening is on; anything else (screening off, non-shell tools) passes. */
  private screenIfShell(def: ToolDef, args: unknown): ShellScreenVerdict {
    if (!this.screening.screenShell || def.category !== 'shell') return { ok: true }
    const cmd = (args as { command?: string })?.command
    if (typeof cmd !== 'string' || !cmd.trim()) return { ok: true } // empty/absent → schema validation's problem
    return screenShellCommand(cmd, this.screening.workspaceRoot ?? '')
  }

  private shellAllowed(cmd: string | undefined): boolean {
    if (!cmd) return false
    const c = cmd.trim()
    for (const p of this.allowShellExact) {
      if (p && c === p) return true
    }
    return false
  }
}

/** Deterministic stringify (sorted keys) so "always allow this exact call" is stable. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
