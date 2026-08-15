import { describe, it, expect } from 'vitest'
import { findUnwiredModules, importSpecifiers } from './unwiredModules'

describe('importSpecifiers', () => {
  it('extracts named, side-effect, re-export, dynamic, and require specifiers', () => {
    const c = [
      "import { A } from './a'",
      "import './side'",
      "export { B } from './b'",
      "import('./lazy')",
      "const r = require('./req')",
      "import D from '../d'",
      "import pkg from 'some-package'"
    ].join('\n')
    expect(importSpecifiers(c)).toEqual(['./a', './side', './b', './lazy', './req', '../d', 'some-package'])
  })
})

describe('findUnwiredModules', () => {
  it('flags a module reachable ONLY from its test (built-but-unwired), not the wired ones', () => {
    const files = [
      { path: 'src/main.ts', content: "import { Game } from './game'\nnew Game()" },
      { path: 'src/game.ts', content: "import { Scene } from './scene'\nexport class Game {}" },
      { path: 'src/scene.ts', content: 'export class Scene {}' },
      { path: 'src/systems/mapRenderer.ts', content: 'export class MapRenderer {}' }, // never imported by the app
      { path: 'src/systems/mapRenderer.test.ts', content: "import { MapRenderer } from './mapRenderer'" } // only its test
    ]
    expect(findUnwiredModules(files)).toEqual(['src/systems/mapRenderer.ts'])
  })

  it('returns [] when every module is wired into the entry', () => {
    const files = [
      { path: 'src/index.ts', content: "import './a'\nimport './b'" },
      { path: 'src/a.ts', content: 'export const a = 1' },
      { path: 'src/b.ts', content: 'export const b = 2' }
    ]
    expect(findUnwiredModules(files)).toEqual([])
  })

  it('returns [] when no entry point is detectable (cannot judge)', () => {
    expect(findUnwiredModules([{ path: 'src/foo.ts', content: 'export const x = 1' }])).toEqual([])
  })

  it('never flags test / config / .d.ts files themselves', () => {
    const files = [
      { path: 'src/main.ts', content: "import './a'" },
      { path: 'src/a.ts', content: 'export const a = 1' },
      { path: 'src/lonely.test.ts', content: "import { a } from './a'" }, // a test imported by nobody
      { path: 'vite.config.ts', content: 'export default {}' },
      { path: 'src/types.d.ts', content: 'export {}' }
    ]
    expect(findUnwiredModules(files)).toEqual([]) // `a` is wired; test/config/d.ts excluded
  })

  it('resolves index barrels + dynamic imports; still finds a true orphan', () => {
    const files = [
      { path: 'src/main.ts', content: "import { thing } from './lib'\nimport('./lazy')" },
      { path: 'src/lib/index.ts', content: "export { thing } from './thing'" },
      { path: 'src/lib/thing.ts', content: 'export const thing = 1' },
      { path: 'src/lazy.ts', content: 'export default 1' },
      { path: 'src/orphan.ts', content: 'export const o = 1' }
    ]
    expect(findUnwiredModules(files)).toEqual(['src/orphan.ts'])
  })
})
