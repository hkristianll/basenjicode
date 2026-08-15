import { ToolRegistry } from '../registry'
import { managerRememberTool } from './remember'
import { readFileTool } from './readFile'
import { writeFileTool } from './writeFile'
import { editFileTool } from './editFile'
import { multiEditTool } from './multiEdit'
import { listDirTool } from './listDir'
import { grepTool } from './grep'
import { globTool } from './glob'
import { deleteFileTool } from './deleteFile'
import { moveFileTool } from './moveFile'
import { runShellTool } from './runShell'
import { runBackgroundTool } from './runBackground'
import { generateImageTool } from './generateImage'
import { generateVideoTool } from './generateVideo'
import { backgroundTools } from './backgroundTools'
import { previewTools } from './preview'
import { webTools } from './web'
import { todoWriteTool } from './todo'
import { skillTool } from './skill'
import { kanbanTool } from './kanban'
import { taskTool } from './task'
import { rememberTool, forgetTool } from './memory'
import { hermesControlTools } from './hermesTools'
import { fileFindingTool } from './fileFinding'
import { escalateTool } from './escalate'
import { DEFAULT_SETTINGS, type ImageConfig } from '../../../shared/domain-types'

/**
 * Is image/video generation plausibly usable on THIS machine? (B3 feature flag.) Cloud providers
 * need a key; local providers need either a configured launcher or a deliberately configured
 * server URL. On a fresh install none of that holds, so the tools are absent from the registry —
 * the model never sees a tool that can only error.
 */
export function imageGenConfigured(img: ImageConfig): boolean {
  if (img.provider === 'openai' || img.provider === 'gemini') return !!img.apiKey.trim()
  if (img.launcherPath?.trim()) return true
  return img.baseURL.trim() !== '' && img.baseURL.trim() !== DEFAULT_SETTINGS.image.baseURL
}

/** Build the MVP tool registry: auto-run read tools + approval-gated mutating tools. */
export function buildRegistry(opts?: { imageGen?: boolean }): ToolRegistry {
  const r = new ToolRegistry()
  // Read / search.
  r.register(readFileTool)
  r.register(listDirTool)
  r.register(grepTool)
  r.register(globTool)
  // Edit / file management (approval-gated, snapshot-aware so the turn is undoable).
  r.register(writeFileTool)
  r.register(editFileTool)
  r.register(multiEditTool)
  r.register(deleteFileTool)
  r.register(moveFileTool)
  if (opts?.imageGen !== false) {
    r.register(generateImageTool) // text→image, saves PNG into the workspace
    r.register(generateVideoTool) // text→video (Wan 2.2), saves mp4 into the workspace
  }
  // Shell + background processes.
  r.register(runShellTool)
  r.register(runBackgroundTool)
  for (const t of backgroundTools) r.register(t) // list/read/stop a background task
  // Preview-driving tools (open/reload/console/snapshot/eval/screenshot) — auto-run, non-mutating.
  for (const t of previewTools) r.register(t)
  // Web access (auto-run; SSRF-guarded).
  for (const t of webTools) r.register(t)
  // Planning + skills.
  r.register(todoWriteTool)
  r.register(skillTool)
  r.register(kanbanTool) // shared cross-agent ticket board (REST → Desktop\ticket-board)
  r.register(taskTool) // delegate a read-only sub-task to a sub-agent on any backend connection
  r.register(fileFindingTool) // REVIEW workers route fixes to implementation; inert without a project context
  r.register(escalateTool) // any worker: escalate a stuck ticket to its lead instead of thrashing/rewriting files
  // Persistent project memory (capped .nordcode/memory.md, recalled across sessions).
  r.register(rememberTool)
  r.register(forgetTool)
  return r
}

/** Brooke's scoped registry: she READS the project files + drives HER project's board/run via control tools,
 *  but never edits files, runs the shell, or touches the raw cross-project board (her control tools are all
 *  scoped to her one project). Read/search + her project-scoped control tools only. */
export function buildManagerRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  r.register(readFileTool)
  r.register(listDirTool)
  r.register(grepTool)
  r.register(globTool)
  // NOT the raw `kanban` tool — it spans every project, which would let her report on / touch the wrong board.
  // Her control tools (team_status, add_work, …) are all bound to her own project via ctx.hermesProject.
  for (const t of hermesControlTools) r.register(t) // start_goal / add_work / reopen / improve / pause / resume / stop / team_status
  r.register(managerRememberTool) // her durable cross-project learning loop — persists lessons that survive into future runs
  return r
}
