import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ticketTerms, scoreFile, pickRelevantFiles } from './relevantFiles'

describe('ticketTerms', () => {
  it('keeps significant terms + explicit filenames, drops stopwords', () => {
    const terms = ticketTerms('Create traffic.js with NPC car spawning, lane following', 'Wire into main.js')
    expect(terms).toContain('traffic.js')
    expect(terms).toContain('main.js')
    expect(terms).toContain('npc')
    expect(terms).toContain('car')
    expect(terms).toContain('lane')
    expect(terms).not.toContain('create') // stopword
    expect(terms).not.toContain('with') // stopword
  })
})

describe('scoreFile', () => {
  it('weights a path match (×5) above a content match (×1), and unrelated files score 0', () => {
    expect(scoreFile('src/game/npcs.js', 'pedestrian logic', ['npc'])).toBe(5) // path includes "npc"
    expect(scoreFile('src/game/city.js', 'road lane intersection', ['lane'])).toBe(1) // content only
    expect(scoreFile('src/game/buildings.js', 'box meshes', ['npc', 'car', 'lane'])).toBe(0) // unrelated
  })
})

describe('pickRelevantFiles', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relevant-'))
    mkdirSync(join(dir, 'src', 'game'), { recursive: true })
    writeFileSync(join(dir, 'src', 'main.js'), 'import city from "./game/city.js"')
    writeFileSync(join(dir, 'src', 'game', 'city.js'), 'const roads=[]; // lane intersection grid')
    writeFileSync(join(dir, 'src', 'game', 'npcs.js'), 'class NPC { walk(){} }')
    writeFileSync(join(dir, 'src', 'game', 'vehicle.js'), 'const CAR_TYPES = {}; // car meshes')
    writeFileSync(join(dir, 'src', 'game', 'buildings.js'), 'function makeBuilding(){} // box meshes')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('points at the files relevant to the ticket and skips the unrelated one', () => {
    const files = pickRelevantFiles(dir, { title: 'Create traffic.js with NPC car spawning, lane following', body: 'Wire into main.js' }, 6)
    expect(files).toContain('src/main.js') // explicit "main.js"
    expect(files).toContain('src/game/npcs.js') // path "npc"
    expect(files).toContain('src/game/city.js') // content "lane"/"intersection"
    expect(files).toContain('src/game/vehicle.js') // content "car"
    expect(files).not.toContain('src/game/buildings.js') // no term match — the file the worker wasted time on
  })
})
