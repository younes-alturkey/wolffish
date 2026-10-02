/**
 * Capability import stress tests — every shape the Cerebellum panel accepts
 * (single SKILL.md, folder, .zip) on the happy path, plus the rejection
 * cases that must fail loudly: bad frontmatter, invalid YAML, malformed
 * tools/triggers, irregular names, zip-slip, collisions, empty drops.
 *
 * Run: npx tsx src/main/runtime/__tests__/capability-import.test.ts
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  deleteCapabilityFolder,
  importCapability,
  parseSkillMd,
  slugify
} from '../capabilityImport'

let passed = 0
let failed = 0

function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

const SKILL_OK = `---
name: my-skill
description: A test skill that does a thing.
triggers:
  - thing
  - test
---

# My Skill

Do the thing when the user asks for the thing.
`

const SKILL_WITH_TOOLS = `---
name: weather
description: Get the weather.
tools:
  - name: weather_get
    description: Get the current weather for a city.
    parameters:
      city:
        type: string
        description: City name.
---

# Weather

Call weather_get with a city.
`

const PLUGIN_MJS = `export default {
  name: 'weather',
  tools: [],
  async execute() { return { success: true, output: 'ok' } }
}
`

async function freshCerebellum(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wolffish-cb-test-'))
  return path.join(dir, 'brain', 'cerebellum')
}

async function makeZip(files: Record<string, string>, zipPath: string): Promise<void> {
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) zip.file(name, content)
  const buf = await zip.generateAsync({ type: 'nodebuffer' })
  await fs.writeFile(zipPath, buf)
}

async function run(): Promise<void> {
  // -------------------------------------------------------------------------
  // slugify / parseSkillMd units
  // -------------------------------------------------------------------------
  ok('slugify spaces', slugify('My Cool Skill') === 'my-cool-skill', slugify('My Cool Skill'))
  ok(
    'slugify punctuation',
    slugify('Web Search!! v2') === 'web-search-v2',
    slugify('Web Search!! v2')
  )
  ok('slugify leading junk', slugify('  --Hello--  ') === 'hello', slugify('  --Hello--  '))
  ok('slugify all-symbols empty', slugify('!!!') === '', `got "${slugify('!!!')}"`)
  ok(
    'parse bom-prefixed frontmatter',
    parseSkillMd('﻿' + SKILL_OK).frontmatter?.name === 'my-skill'
  )
  ok('parse no-frontmatter null', parseSkillMd('# just markdown').frontmatter === null)

  // -------------------------------------------------------------------------
  // HAPPY: single SKILL.md
  // -------------------------------------------------------------------------
  {
    const cb = await freshCerebellum()
    const src = path.join(os.tmpdir(), `cap-skill-${Date.now()}.md`)
    await fs.writeFile(src, SKILL_OK)
    const r = await importCapability({
      sourcePath: src,
      cerebellumDir: cb,
      existingNames: new Set()
    })
    ok('H1 skill ok', r.ok, JSON.stringify(r))
    if (r.ok) {
      ok('H1 source', r.source === 'skill')
      ok('H1 name', r.name === 'my-skill')
      ok('H1 no plugin', r.hasPlugin === false)
      ok('H1 file on disk', await exists(path.join(cb, 'my-skill', 'SKILL.md')))
    }
    await fs.unlink(src).catch(() => {})
  }

  // -------------------------------------------------------------------------
  // HAPPY: folder with plugin + package.json + node_modules (excluded)
  // -------------------------------------------------------------------------
  {
    const cb = await freshCerebellum()
    const srcRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cap-folder-'))
    const src = path.join(srcRoot, 'weather')
    await fs.mkdir(path.join(src, 'plugin'), { recursive: true })
    await fs.mkdir(path.join(src, 'node_modules', 'left-pad'), { recursive: true })
    await fs.writeFile(path.join(src, 'SKILL.md'), SKILL_WITH_TOOLS)
    await fs.writeFile(path.join(src, 'plugin', 'index.mjs'), PLUGIN_MJS)
    await fs.writeFile(path.join(src, 'package.json'), '{"name":"weather","dependencies":{}}')
    await fs.writeFile(path.join(src, 'node_modules', 'left-pad', 'index.js'), 'module.exports={}')

    const r = await importCapability({
      sourcePath: src,
      cerebellumDir: cb,
      existingNames: new Set()
    })
    ok('H2 folder ok', r.ok, JSON.stringify(r))
    if (r.ok) {
      ok('H2 source', r.source === 'folder')
      ok('H2 hasPlugin', r.hasPlugin === true)
      ok('H2 toolCount', r.toolCount === 1, String(r.toolCount))
      ok('H2 plugin copied', await exists(path.join(cb, 'weather', 'plugin', 'index.mjs')))
      ok('H2 package.json copied', await exists(path.join(cb, 'weather', 'package.json')))
      ok('H2 node_modules excluded', !(await exists(path.join(cb, 'weather', 'node_modules'))))
    }
    await fs.rm(srcRoot, { recursive: true, force: true }).catch(() => {})
  }

  // -------------------------------------------------------------------------
  // HAPPY: zip (folder nested one level)
  // -------------------------------------------------------------------------
  {
    const cb = await freshCerebellum()
    const zipPath = path.join(os.tmpdir(), `cap-zip-${Date.now()}.zip`)
    await makeZip(
      {
        'weather/SKILL.md': SKILL_WITH_TOOLS,
        'weather/plugin/index.mjs': PLUGIN_MJS
      },
      zipPath
    )
    const r = await importCapability({
      sourcePath: zipPath,
      cerebellumDir: cb,
      existingNames: new Set()
    })
    ok('H3 zip ok', r.ok, JSON.stringify(r))
    if (r.ok) {
      ok('H3 source', r.source === 'zip')
      ok('H3 hasPlugin', r.hasPlugin === true)
      ok('H3 plugin on disk', await exists(path.join(cb, 'weather', 'plugin', 'index.mjs')))
    }
    await fs.unlink(zipPath).catch(() => {})
  }

  // -------------------------------------------------------------------------
  // HAPPY: zip with SKILL.md at root (no wrapper dir)
  // -------------------------------------------------------------------------
  {
    const cb = await freshCerebellum()
    const zipPath = path.join(os.tmpdir(), `cap-zip-root-${Date.now()}.zip`)
    await makeZip({ 'SKILL.md': SKILL_OK }, zipPath)
    const r = await importCapability({
      sourcePath: zipPath,
      cerebellumDir: cb,
      existingNames: new Set()
    })
    ok('H4 zip-root ok', r.ok, JSON.stringify(r))
    if (r.ok) ok('H4 on disk', await exists(path.join(cb, 'my-skill', 'SKILL.md')))
    await fs.unlink(zipPath).catch(() => {})
  }

  // -------------------------------------------------------------------------
  // HAPPY: name needs slugify + lowercase skill.md normalized
  // -------------------------------------------------------------------------
  {
    const cb = await freshCerebellum()
    const srcRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cap-slug-'))
    const src = path.join(srcRoot, 'whatever')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(
      path.join(src, 'skill.md'), // lowercase on purpose
      SKILL_OK.replace('name: my-skill', 'name: My Cool Skill')
    )
    const r = await importCapability({
      sourcePath: src,
      cerebellumDir: cb,
      existingNames: new Set()
    })
    ok('H5 slug ok', r.ok, JSON.stringify(r))
    if (r.ok) {
      ok('H5 folderName', r.folderName === 'my-cool-skill', r.folderName)
      ok('H5 name preserved', r.name === 'My Cool Skill', r.name)
      ok('H5 canonical SKILL.md', await exists(path.join(cb, 'my-cool-skill', 'SKILL.md')))
    }
    await fs.rm(srcRoot, { recursive: true, force: true }).catch(() => {})
  }

  // -------------------------------------------------------------------------
  // REJECT cases
  // -------------------------------------------------------------------------
  const reject = async (
    label: string,
    write: (cb: string) => Promise<string>, // returns sourcePath
    existing: Set<string> = new Set(),
    expectSub?: string
  ): Promise<void> => {
    const cb = await freshCerebellum()
    const src = await write(cb)
    const r = await importCapability({
      sourcePath: src,
      cerebellumDir: cb,
      existingNames: existing
    })
    ok(label, !r.ok, r.ok ? 'expected rejection but got ok' : undefined)
    if (!r.ok && expectSub) {
      ok(
        `${label} (msg)`,
        r.error.toLowerCase().includes(expectSub.toLowerCase()),
        `"${r.error}" missing "${expectSub}"`
      )
    }
  }

  const tmpMd = async (
    content: string,
    name = `r-${Math.random().toString(36).slice(2)}.md`
  ): Promise<string> => {
    const p = path.join(os.tmpdir(), name)
    await fs.writeFile(p, content)
    return p
  }

  await reject(
    'R1 no frontmatter',
    () => tmpMd('# just a heading\n\nno frontmatter'),
    new Set(),
    'frontmatter'
  )
  await reject(
    'R2 missing name',
    () => tmpMd('---\ndescription: hi\n---\n\nbody'),
    new Set(),
    'name'
  )
  await reject(
    'R3 invalid yaml',
    () => tmpMd('---\nname: [unterminated\n---\n\nbody'),
    new Set(),
    'yaml'
  )
  await reject(
    'R4 empty body no tools',
    () => tmpMd('---\nname: hollow\ndescription: nothing\n---\n'),
    new Set(),
    'content'
  )
  await reject(
    'R6 triggers not array',
    () => tmpMd('---\nname: x\ndescription: d\ntriggers: nope\n---\n\nbody'),
    new Set(),
    'triggers'
  )
  await reject(
    'R7 tool missing name',
    () => tmpMd('---\nname: x\ndescription: d\ntools:\n  - description: no name\n---\n\nbody'),
    new Set(),
    'name'
  )
  await reject('R8 duplicate name', () => tmpMd(SKILL_OK), new Set(['my-skill']), 'already exists')
  await reject(
    'R11 unsupported ext',
    async () => {
      const p = path.join(os.tmpdir(), `r-${Date.now()}.txt`)
      await fs.writeFile(p, 'hello')
      return p
    },
    new Set(),
    'unsupported'
  )
  await reject('R15 empty file', () => tmpMd('', `empty-${Date.now()}.md`), new Set(), 'empty')
  await reject(
    'R16 missing source',
    async () => path.join(os.tmpdir(), `does-not-exist-${Date.now()}.md`),
    new Set(),
    'could not read'
  )
  await reject(
    'R17 name slugifies empty',
    () => tmpMd('---\nname: "!!!"\ndescription: d\n---\n\nbody'),
    new Set(),
    'folder name'
  )

  // R5: tools declared but folder has no plugin
  await reject(
    'R5 tools without plugin',
    async (cb) => {
      void cb
      const srcRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'r5-'))
      const src = path.join(srcRoot, 'noplug')
      await fs.mkdir(src, { recursive: true })
      await fs.writeFile(path.join(src, 'SKILL.md'), SKILL_WITH_TOOLS)
      return src
    },
    new Set(),
    'plugin'
  )

  // R12: folder with no SKILL.md
  await reject(
    'R12 folder no skill',
    async () => {
      const srcRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'r12-'))
      const src = path.join(srcRoot, 'empty-cap')
      await fs.mkdir(src, { recursive: true })
      await fs.writeFile(path.join(src, 'readme.txt'), 'hi')
      return src
    },
    new Set(),
    'no skill.md'
  )

  // R13: two SKILL.md files
  await reject(
    'R13 two skills',
    async () => {
      const srcRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'r13-'))
      const src = path.join(srcRoot, 'multi')
      await fs.mkdir(path.join(src, 'a'), { recursive: true })
      await fs.mkdir(path.join(src, 'b'), { recursive: true })
      await fs.writeFile(path.join(src, 'a', 'SKILL.md'), SKILL_OK)
      await fs.writeFile(path.join(src, 'b', 'SKILL.md'), SKILL_OK)
      return src
    },
    new Set(),
    'exactly one'
  )

  // R14: plugin dir without entry file
  await reject(
    'R14 plugin no entry',
    async () => {
      const srcRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'r14-'))
      const src = path.join(srcRoot, 'badplug')
      await fs.mkdir(path.join(src, 'plugin'), { recursive: true })
      await fs.writeFile(path.join(src, 'SKILL.md'), SKILL_OK)
      await fs.writeFile(path.join(src, 'plugin', 'helper.py'), 'print(1)')
      return src
    },
    new Set(),
    'entry file'
  )

  // R9: collision on disk (folder already exists)
  {
    const cb = await freshCerebellum()
    await fs.mkdir(path.join(cb, 'my-skill'), { recursive: true })
    await fs.writeFile(path.join(cb, 'my-skill', 'placeholder'), 'x')
    const src = await tmpMd(SKILL_OK)
    const r = await importCapability({
      sourcePath: src,
      cerebellumDir: cb,
      existingNames: new Set()
    })
    ok(
      'R9 disk collision',
      !r.ok && r.error.toLowerCase().includes('already exists'),
      JSON.stringify(r)
    )
    await fs.unlink(src).catch(() => {})
  }

  // R10: zip-slip
  {
    const cb = await freshCerebellum()
    const zipPath = path.join(os.tmpdir(), `slip-${Date.now()}.zip`)
    await makeZip({ 'SKILL.md': SKILL_OK, '../../evil.txt': 'pwned' }, zipPath)
    // Confirm the malicious entry actually survived into the archive; if JSZip
    // normalized it away this test would be meaningless.
    const JSZip = (await import('jszip')).default
    const probe = await JSZip.loadAsync(await fs.readFile(zipPath))
    const hasSlip = Object.keys(probe.files).some((n) => n.includes('..'))
    const r = await importCapability({
      sourcePath: zipPath,
      cerebellumDir: cb,
      existingNames: new Set()
    })
    if (hasSlip) {
      ok(
        'R10 zip-slip rejected',
        !r.ok && r.error.toLowerCase().includes('unsafe'),
        JSON.stringify(r)
      )
      ok('R10 nothing escaped', !(await exists(path.join(path.dirname(cb), '..', 'evil.txt'))))
    } else {
      // JSZip sanitized the path — the slip can't be constructed this way, so
      // the import should simply succeed on the remaining valid SKILL.md.
      ok('R10 zip-slip (sanitized by jszip)', r.ok, JSON.stringify(r))
    }
    await fs.unlink(zipPath).catch(() => {})
  }

  // R-corrupt: a .zip that isn't a real archive
  await reject(
    'R-corrupt zip',
    async () => {
      const p = path.join(os.tmpdir(), `corrupt-${Date.now()}.zip`)
      await fs.writeFile(p, 'this is not a zip file at all')
      return p
    },
    new Set(),
    'corrupt'
  )

  // -------------------------------------------------------------------------
  // DELETE: nuke a user-imported capability + refusal guards
  // -------------------------------------------------------------------------

  // D1: import then delete — folder is gone, returns ok
  {
    const cb = await freshCerebellum()
    const src = await tmpMd(SKILL_OK)
    const imp = await importCapability({
      sourcePath: src,
      cerebellumDir: cb,
      existingNames: new Set()
    })
    ok('D1 import for delete', imp.ok, JSON.stringify(imp))
    if (imp.ok) {
      const dir = path.join(cb, imp.folderName)
      ok('D1 folder exists pre-delete', await exists(dir))
      const del = await deleteCapabilityFolder({
        name: imp.name,
        dir,
        cerebellumDir: cb,
        isOfficial: false,
        isInProcess: false
      })
      ok('D1 delete ok', del.ok, JSON.stringify(del))
      ok('D1 folder nuked', !(await exists(dir)))
    }
    await fs.unlink(src).catch(() => {})
  }

  // D2: refuse official
  {
    const cb = await freshCerebellum()
    const dir = path.join(cb, 'filesystem')
    await fs.mkdir(dir, { recursive: true })
    const del = await deleteCapabilityFolder({
      name: 'filesystem',
      dir,
      cerebellumDir: cb,
      isOfficial: true,
      isInProcess: false
    })
    ok(
      'D2 official refused',
      !del.ok && del.error.toLowerCase().includes('official'),
      JSON.stringify(del)
    )
    ok('D2 folder untouched', await exists(dir))
  }

  // D3: refuse in-process
  {
    const cb = await freshCerebellum()
    const del = await deleteCapabilityFolder({
      name: 'telegram',
      dir: path.join(cb, 'telegram'),
      cerebellumDir: cb,
      isOfficial: false,
      isInProcess: true
    })
    ok(
      'D3 in-process refused',
      !del.ok && del.error.toLowerCase().includes('built-in'),
      JSON.stringify(del)
    )
  }

  // D4: refuse a dir outside cerebellumDir (traversal)
  {
    const cb = await freshCerebellum()
    const del = await deleteCapabilityFolder({
      name: 'evil',
      dir: path.join(cb, '..', '..', 'somewhere-else'),
      cerebellumDir: cb,
      isOfficial: false,
      isInProcess: false
    })
    ok(
      'D4 traversal refused',
      !del.ok && del.error.toLowerCase().includes('refusing'),
      JSON.stringify(del)
    )
  }

  // D5: refuse a nested (non-direct-child) path
  {
    const cb = await freshCerebellum()
    const del = await deleteCapabilityFolder({
      name: 'nested',
      dir: path.join(cb, 'a', 'b'),
      cerebellumDir: cb,
      isOfficial: false,
      isInProcess: false
    })
    ok(
      'D5 nested refused',
      !del.ok && del.error.toLowerCase().includes('refusing'),
      JSON.stringify(del)
    )
  }

  // D6: refuse the cerebellum dir itself
  {
    const cb = await freshCerebellum()
    await fs.mkdir(cb, { recursive: true })
    const del = await deleteCapabilityFolder({
      name: 'self',
      dir: cb,
      cerebellumDir: cb,
      isOfficial: false,
      isInProcess: false
    })
    ok(
      'D6 self refused',
      !del.ok && del.error.toLowerCase().includes('refusing'),
      JSON.stringify(del)
    )
    ok('D6 cerebellum dir intact', await exists(cb))
  }

  // -------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

run().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
