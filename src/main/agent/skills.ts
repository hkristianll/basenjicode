import fs from 'node:fs'
import path from 'node:path'

/**
 * Skills = reusable, on-demand instruction bundles (Claude-Code style). The system prompt lists
 * each skill's name + description; the model calls the `skill` tool to load the full body when a
 * task matches. Built-in skills ship with the app; workspace skills live in `.agents/*.md` and can
 * override a built-in of the same name.
 */
export interface Skill {
  name: string
  description: string
  body: string
  source: 'builtin' | 'workspace'
}

/** Directory (relative to the workspace root) scanned for workspace skill files. */
export const SKILLS_DIR = '.agents'

const MAX_SKILLS = 50
const MAX_BODY = 100_000

/**
 * Parse a skill markdown doc with optional `--- name/description ---` frontmatter.
 * Pure (no FS) so it is unit-testable. `fallbackName` is used when frontmatter omits `name`.
 */
export function parseSkillDoc(raw: string, fallbackName: string): { name: string; description: string; body: string } {
  let name = fallbackName
  let description = ''
  let body = raw
  const fm = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(raw)
  if (fm) {
    body = raw.slice(fm[0].length)
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(line)
      if (!m) continue
      const key = m[1].toLowerCase()
      const val = m[2].trim().replace(/^["']|["']$/g, '')
      if (key === 'name' && val) name = val
      else if (key === 'description') description = val
    }
  }
  return { name: name.trim(), description: description.trim(), body: body.trim().slice(0, MAX_BODY) }
}

const PREVIEW_SKILL_BODY = `# Verify web UI changes in the live preview

You can drive an embedded browser preview yourself — never tell the user to "open the app and check".
Verify your own web/UI work before you report it done.

Workflow:
1. REUSE a running dev server — call list_background first. Only run_background a new one
   (e.g. \`npm run dev\`) if none is already serving this project. Starting a second dev server makes it
   bind a NEW port (5174, 5175…), floods localhost, and leaves the preview pointing at the wrong one.
2. Get the REAL url — read_background(id) and copy the address the server actually printed
   (e.g. "Local: http://localhost:5174"). The port often differs from the 5173 / 3000 default when one
   is already in use; opening the default then fails with ERR_CONNECTION_REFUSED. preview_open(that url).
3. preview_console() FIRST — runtime errors and failed network requests show up here and usually
   explain a blank or broken page. Pass {"level":"error"} to see only errors.
4. preview_snapshot() — confirm the expected headings, text, buttons, and inputs are present.
5. preview_eval("return ...") — assert specific values a snapshot can't show, e.g.
   return document.querySelectorAll('.row').length, or return getComputedStyle(document.body).color.
6. After editing source: if the dev server hot-reloads, just preview_snapshot again; otherwise
   preview_reload() first, then re-check.
7. preview_screenshot() to SEE how the page actually LOOKS — it attaches the image for you to view, so use it to
   judge visual quality (layout, art, colors, spacing, polish) against the intended design, not just whether it runs.
   (Needs a vision-capable model; for reading exact values/text prefer console/snapshot/eval.)

Notes:
- "No live preview is open" means you skipped preview_open, or the dev server isn't up yet.
- The preview only loads http(s) URLs; it can't open local files directly.
- Keep iterating (edit → reload → check) until the page is actually correct.
- Reuse the SAME dev server across edits within a task. When the task is done, stop_background it so it
  doesn't linger holding its port — orphaned servers accumulate and the next run opens a stale one.
- After a rebuild with no hot-reload, preview_reload does a cache-bypassing reload, so you won't see
  stale assets — if content still looks old, you opened the wrong port (see step 2), not a cache.`

const BUILTIN_SKILLS: Skill[] = [
  {
    name: 'preview',
    description: 'Verify web/UI changes in the live browser preview (open, read console, snapshot, eval, reload).',
    body: PREVIEW_SKILL_BODY,
    source: 'builtin'
  }
]

// Cache by workspace root, invalidated when the `.agents` listing/mtimes change.
const cache = new Map<string, { sig: string; skills: Skill[] }>()

function dirSignature(dir: string): string {
  try {
    const names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort()
    return names
      .map((n) => {
        try {
          return `${n}:${fs.statSync(path.join(dir, n)).mtimeMs}`
        } catch {
          return n
        }
      })
      .join('|')
  } catch {
    return '' // no .agents dir
  }
}

function readWorkspaceSkills(dir: string): Skill[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'))
  } catch {
    return []
  }
  const out: Skill[] = []
  for (const file of names.sort()) {
    if (out.length >= MAX_SKILLS) break
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8')
      const { name, description, body } = parseSkillDoc(raw, file.replace(/\.md$/i, ''))
      if (name && body) out.push({ name, description, body, source: 'workspace' })
    } catch {
      /* skip unreadable file */
    }
  }
  return out
}

/** All skills available in this workspace: built-ins plus `.agents/*.md` (workspace wins on name). */
export function discoverSkills(workspaceRoot: string): Skill[] {
  const dir = path.join(workspaceRoot, SKILLS_DIR)
  const sig = dirSignature(dir)
  const hit = cache.get(workspaceRoot)
  if (hit && hit.sig === sig) return hit.skills
  const byName = new Map<string, Skill>()
  for (const s of BUILTIN_SKILLS) byName.set(s.name.toLowerCase(), s)
  for (const s of readWorkspaceSkills(dir)) byName.set(s.name.toLowerCase(), s)
  const skills = [...byName.values()]
  cache.set(workspaceRoot, { sig, skills })
  return skills
}

export function getSkill(workspaceRoot: string, name: string): Skill | undefined {
  const want = name.trim().toLowerCase()
  return discoverSkills(workspaceRoot).find((s) => s.name.toLowerCase() === want)
}

/** The "Skills available" block for the system prompt, or '' if there are none. */
export function skillsDigest(workspaceRoot: string): string {
  const skills = discoverSkills(workspaceRoot)
  if (!skills.length) return ''
  const lines = skills.map((s) => `- ${s.name}${s.source === 'workspace' ? ' (workspace)' : ''} — ${s.description || '(no description)'}`)
  return (
    `Skills available (reusable playbooks). When a task matches one, call skill("<name>") to load its ` +
    `step-by-step instructions before you start:\n${lines.join('\n')}`
  )
}
