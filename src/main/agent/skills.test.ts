import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseSkillDoc, discoverSkills, getSkill, skillsDigest } from './skills'

describe('parseSkillDoc', () => {
  it('parses frontmatter name + description and trims the body', () => {
    const raw = `---\nname: deploy\ndescription: Ship the app\n---\n\nDo the steps.\n`
    expect(parseSkillDoc(raw, 'fallback')).toEqual({
      name: 'deploy',
      description: 'Ship the app',
      body: 'Do the steps.'
    })
  })

  it('falls back to the file name and empty description without frontmatter', () => {
    const r = parseSkillDoc('Just a body, no frontmatter.', 'my-skill')
    expect(r.name).toBe('my-skill')
    expect(r.description).toBe('')
    expect(r.body).toBe('Just a body, no frontmatter.')
  })

  it('handles CRLF and strips surrounding quotes', () => {
    const raw = `---\r\nname: "q"\r\ndescription: 'has, comma'\r\n---\r\nBody\r\n`
    const r = parseSkillDoc(raw, 'fb')
    expect(r.name).toBe('q')
    expect(r.description).toBe('has, comma')
    expect(r.body).toBe('Body')
  })

  it('keeps the fallback name when frontmatter omits name', () => {
    const raw = `---\ndescription: only desc\n---\nbody`
    const r = parseSkillDoc(raw, 'fname')
    expect(r.name).toBe('fname')
    expect(r.description).toBe('only desc')
  })
})

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'))
}

describe('discoverSkills', () => {
  it('returns the built-in preview skill when there is no .agents dir', () => {
    const ws = tmpWorkspace()
    try {
      const skills = discoverSkills(ws)
      expect(skills.some((s) => s.name === 'preview' && s.source === 'builtin')).toBe(true)
    } finally {
      fs.rmSync(ws, { recursive: true, force: true })
    }
  })

  it('picks up workspace skills from .agents/*.md', () => {
    const ws = tmpWorkspace()
    try {
      fs.mkdirSync(path.join(ws, '.agents'))
      fs.writeFileSync(
        path.join(ws, '.agents', 'lint.md'),
        `---\nname: lint\ndescription: Run the linter\n---\nnpm run lint`,
        'utf8'
      )
      const lint = getSkill(ws, 'lint')
      expect(lint?.source).toBe('workspace')
      expect(lint?.body).toBe('npm run lint')
      // Workspace skills are tagged so the model (and the user) can tell them from trusted built-ins.
      expect(skillsDigest(ws)).toContain('lint (workspace) — Run the linter')
    } finally {
      fs.rmSync(ws, { recursive: true, force: true })
    }
  })

  it('lets a workspace skill override a built-in of the same name', () => {
    const ws = tmpWorkspace()
    try {
      fs.mkdirSync(path.join(ws, '.agents'))
      fs.writeFileSync(
        path.join(ws, '.agents', 'preview.md'),
        `---\nname: preview\ndescription: custom preview\n---\nmy own preview steps`,
        'utf8'
      )
      const preview = getSkill(ws, 'preview')
      expect(preview?.source).toBe('workspace')
      expect(preview?.body).toBe('my own preview steps')
      // Still exactly one skill named "preview".
      expect(discoverSkills(ws).filter((s) => s.name === 'preview')).toHaveLength(1)
    } finally {
      fs.rmSync(ws, { recursive: true, force: true })
    }
  })

  it('is case-insensitive on lookup', () => {
    const ws = tmpWorkspace()
    try {
      expect(getSkill(ws, 'PREVIEW')?.name).toBe('preview')
    } finally {
      fs.rmSync(ws, { recursive: true, force: true })
    }
  })
})
