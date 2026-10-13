/**
 * The folder picker's directory listing: folders only, sorted without regard
 * to case, hidden ones out unless asked for, symlinks to folders counted as
 * folders, a breadcrumb that reaches the root, `~` expanded, and a readable
 * reason for every way a path can fail.
 *
 * Standalone — run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/__tests__/paths-list-directories.test.ts
 */
export {}

import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

async function run(): Promise<void> {
  const { listDirectories, expandHome } = await import('@main/paths/paths')
  const base = mkdtempSync(path.join(os.tmpdir(), 'wolffish-dirs-'))
  for (const name of ['alpha', 'Beta', 'gamma', '.hidden']) mkdirSync(path.join(base, name))
  mkdirSync(path.join(base, 'alpha', 'inner'))
  writeFileSync(path.join(base, 'file.txt'), 'x')
  symlinkSync(path.join(base, 'alpha'), path.join(base, 'link-to-alpha'))
  symlinkSync(path.join(base, 'file.txt'), path.join(base, 'link-to-file'))

  const listing = await listDirectories(base)
  ok('no error on a readable folder', listing.error === null, String(listing.error))
  ok(
    'folders only, sorted without regard to case, symlinked folder included',
    JSON.stringify(listing.entries.map((e) => e.name)) ===
      JSON.stringify(['alpha', 'Beta', 'gamma', 'link-to-alpha']),
    JSON.stringify(listing.entries.map((e) => e.name))
  )
  ok('hidden folders left out by default', !listing.entries.some((e) => e.hidden))
  ok('entry paths are absolute children', listing.entries[0].path === path.join(base, 'alpha'))
  ok('parent is the directory above', listing.parent === path.dirname(base))
  ok('last crumb is the folder itself', listing.crumbs[listing.crumbs.length - 1].path === base)
  ok('first crumb is the root', listing.crumbs[0].path === path.parse(base).root)
  ok(
    'home and workspace are reported',
    listing.home === os.homedir() && listing.workspace.length > 0
  )

  const withHidden = await listDirectories(base, { hidden: true })
  const dot = withHidden.entries.find((e) => e.name === '.hidden')
  ok('hidden folders shown on request and flagged', dot !== undefined && dot.hidden === true)

  const inner = await listDirectories(path.join(base, 'alpha'))
  ok('descends one level', inner.entries.length === 1 && inner.entries[0].name === 'inner')

  const root = await listDirectories(path.parse(base).root)
  ok('root has no parent', root.parent === null && root.crumbs.length === 1)

  ok('~ expands to home', expandHome('~') === os.homedir())
  ok('~/x expands under home', expandHome('~/x') === path.join(os.homedir(), 'x'))
  ok('empty expands to home', expandHome('  ') === os.homedir())
  const tilde = await listDirectories('~')
  ok('listing ~ lists home', tilde.path === os.homedir())

  const missing = await listDirectories(path.join(base, 'nope'))
  ok(
    'missing folder: error says so, no entries',
    /does not exist/.test(missing.error ?? '') && missing.entries.length === 0
  )
  const file = await listDirectories(path.join(base, 'file.txt'))
  ok('a file: error says it is a file', /is a file/.test(file.error ?? ''))
  ok(
    'a failed listing still carries the crumbs to climb out',
    file.crumbs.length > 1 && file.parent === base
  )

  console.log(`paths-list-directories: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void run().catch((err) => {
  console.error(err)
  process.exit(1)
})
