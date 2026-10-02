/**
 * The folder chips over the transcript: which folders a conversation changed
 * files in. Two halves, each pinned on its own:
 *
 *  - the segment scan (renderer): only successful file-changing calls count,
 *    the diff's absolute path wins over the call's argument, a relative
 *    argument resolves against the first working folder, files group by the
 *    project their directory resolves to, labels are the project's own name;
 *  - the project resolution (main, src/main/uploads/project-folders.ts) over
 *    a fake filesystem: the repository root wins, then a manifest, then the
 *    working folder / workspace / home container, then the old shape
 *    heuristic — so a run editing `wolffish-landing/content/blog/en` bills
 *    `wolffish-landing`, never `blog` (the chip a user caught), and nothing
 *    ever collapses into the home directory.
 *
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/touched-folders.test.ts
 */
import type { Segment } from '@preload/index'
import { projectFolderFor, projectFoldersFor } from '../../uploads/project-folders'
import {
  changedDirectories,
  collectChangedFiles,
  folderChips,
  groupTouchedFolders
} from '../../../renderer/src/lib/touched-folders/touchedFolders'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: unknown): void {
  if (cond) passed++
  else {
    failed++
    console.error(`FAIL ${label}${detail !== undefined ? `\n     ${JSON.stringify(detail)}` : ''}`)
  }
}
function eq(label: string, actual: unknown, expected: unknown): void {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })
}

function call(id: string, name: string, args: Record<string, unknown>): Segment {
  return { kind: 'tool_call', turnId: 't1', segmentId: `c-${id}`, toolCallId: id, name, args }
}
function result(id: string, status: 'success' | 'failed' | 'denied', diffFile?: string): Segment {
  return {
    kind: 'tool_result',
    turnId: 't1',
    segmentId: `r-${id}`,
    toolCallId: id,
    status,
    output: '',
    ...(diffFile
      ? { meta: { diff: { file: diffFile, patch: '', additions: 1, deletions: 0, kind: 'edit' } } }
      : {})
  } as Segment
}
const msg = (segments: Segment[]): { role: string; segments: Segment[] } => ({
  role: 'assistant',
  segments
})

const HOME = '/Users/y'
const WS_FILES = `${HOME}/.wolffish/workspace/files`
const LANDING = `${HOME}/Documents/wolffish/wolffish-landing`
const APP = `${HOME}/Documents/wolffish/wolffish-app`
const CLOUD = `${HOME}/Documents/wolffish/wolffish-cloud`

/** A fake tree: the set of paths that exist. */
function fakeFs(paths: string[]): (p: string) => boolean {
  const set = new Set(paths)
  return (p) => set.has(p)
}
function deps(paths: string[]): Parameters<typeof projectFolderFor>[2] {
  return { exists: fakeFs(paths), home: HOME, workspaceFiles: WS_FILES }
}

function segmentScan(): void {
  const W = '/repo/app'
  const messages = [
    { role: 'user', segments: undefined },
    msg([
      call('1', 'file_read', { path: 'src/a.ts' }),
      result('1', 'success'),
      call('2', 'file_edit', { path: 'src/a.ts' }),
      result('2', 'success', `${W}/src/a.ts`),
      call('3', 'file_write', { path: `${W}/src/lib/b.ts` }),
      result('3', 'success', `${W}/src/lib/b.ts`),
      call('4', 'file_edit', { path: 'src/a.ts' }),
      result('4', 'success', `${W}/src/a.ts`),
      call('5', 'file_patch', { path: 'test/x.test.ts' }),
      result('5', 'success'),
      call('6', 'file_edit', { path: 'src/never.ts' }),
      result('6', 'failed'),
      call('7', 'file_write', { path: 'src/denied.ts' }),
      result('7', 'denied'),
      call('8', 'file_write', { path: 'README.md' }),
      result('8', 'success', `${W}/README.md`),
      call('9', 'file_edit', { path: '/tmp/scratch/notes.md' }),
      result('9', 'success'),
      call('10', 'file_edit', { path: 'pending.ts' })
    ])
  ]
  const files = collectChangedFiles(messages, [W])
  eq('only successful file-changing calls count, in stream order', files, [
    `${W}/src/a.ts`,
    `${W}/src/lib/b.ts`,
    `${W}/src/a.ts`,
    `${W}/test/x.test.ts`,
    `${W}/README.md`,
    '/tmp/scratch/notes.md'
  ])
  eq('distinct directories, first-seen order', changedDirectories(files), [
    `${W}/src`,
    `${W}/src/lib`,
    `${W}/test`,
    W,
    '/tmp/scratch'
  ])
  ok(
    'no working folder: a relative path cannot resolve and is skipped',
    collectChangedFiles(messages, []).every((f) => f.startsWith('/'))
  )
  ok(
    'a message without segments contributes nothing',
    collectChangedFiles([{ role: 'assistant' }], [W]).length === 0
  )
  eq(
    'windows separators are normalized',
    collectChangedFiles(
      [msg([call('w', 'file_edit', { path: 'src\\win.ts' }), result('w', 'success')])],
      ['C:\\proj']
    ),
    ['C:/proj/src/win.ts']
  )

  // Grouping: every directory of one project lands on one chip, files are
  // deduplicated, the label is the project's own name, and a directory main
  // has not answered for yet earns no chip at all.
  const project = (dir: string): string | undefined =>
    dir.startsWith(W) ? W : dir === '/tmp/scratch' ? undefined : dir
  eq(
    'one chip per project, files deduplicated, label = project name',
    groupTouchedFolders(files, project),
    [{ path: W, label: 'app', files: 4 }]
  )
  eq(
    'an unresolved directory contributes nothing',
    groupTouchedFolders(['/tmp/scratch/notes.md'], () => undefined),
    []
  )
  ok(
    'no chip label reads as a nested path',
    groupTouchedFolders(files, (d) => d).every((f) => !f.label.includes('/'))
  )
}

function projectResolution(): void {
  // The run that reached a user: a heartbeat with no working folder on the
  // conversation wrote ten posts under wolffish-landing/content/blog/{en,ar}
  // and the strip read `blog`. The repository root is the answer, whatever
  // the working folder is set to — none, the repo, or the parent of ten repos.
  const tree = deps([`${LANDING}/.git`, `${APP}/.git`, `${CLOUD}/.git`])
  const blogEn = `${LANDING}/content/blog/en`
  const blogAr = `${LANDING}/content/blog/ar`
  eq('repo root, no working folder', projectFolderFor(blogEn, [], tree), LANDING)
  eq('repo root, working folder = the repo', projectFolderFor(blogEn, [LANDING], tree), LANDING)
  eq(
    'repo root, working folder = the parent of many repos',
    projectFolderFor(blogEn, [`${HOME}/Documents/wolffish`], tree),
    LANDING
  )
  eq(
    'repo root, working folder inside the repo',
    projectFolderFor(`${APP}/src/renderer/src/pages`, [`${APP}/src/renderer`], tree),
    APP
  )
  eq(
    'two directories of one repo resolve to the same project',
    projectFoldersFor([blogEn, blogAr, LANDING], [], tree),
    { [blogEn]: LANDING, [blogAr]: LANDING, [LANDING]: LANDING }
  )
  // Two repos whose trees share a shape never read the same: each is its own
  // repo, and the monorepo's app is billed to the monorepo (the repository
  // beats the sub-package's manifest).
  const twins = deps([
    `${APP}/.git`,
    `${CLOUD}/.git`,
    `${CLOUD}/package.json`,
    `${CLOUD}/apps/desktop/package.json`
  ])
  eq(
    'one project per repository, never two chips named src',
    projectFoldersFor(
      [`${APP}/src/renderer/src/pages`, `${CLOUD}/apps/desktop/src/renderer/src/pages`],
      [],
      twins
    ),
    {
      [`${APP}/src/renderer/src/pages`]: APP,
      [`${CLOUD}/apps/desktop/src/renderer/src/pages`]: CLOUD
    }
  )
  // A worktree or submodule keeps `.git` as a FILE; existence is what counts.
  eq(
    'a .git file (worktree) marks a repo too',
    projectFolderFor('/srv/wt/src/x', [], deps(['/srv/wt/.git'])),
    '/srv/wt'
  )
  // No repo: the nearest manifest is the project.
  eq(
    'manifest folder when there is no repo',
    projectFolderFor('/srv/site/src/pages', [], deps(['/srv/site/package.json'])),
    '/srv/site'
  )
  // Working folder with no repo or manifest: the folder the user named IS the
  // project, however deep the edit — never the first folder under it.
  const notes = `${HOME}/Desktop/notes`
  eq('working folder is the project', projectFolderFor(`${notes}/a/b`, [notes], deps([])), notes)
  eq(
    'the longest containing working folder wins',
    projectFolderFor(`${notes}/a/b`, [`${HOME}/Desktop`, notes], deps([])),
    notes
  )
  // Nothing ever collapses into the home directory: a dotfiles repo at ~/.git
  // or a .git on the runtime folder is ignored, and the home containers hand
  // out their first folder instead.
  const dotfiles = deps([`${HOME}/.git`, `${HOME}/.wolffish/.git`])
  eq('~/.git never swallows Desktop work', projectFolderFor(`${notes}/a`, [], dotfiles), notes)
  eq(
    'a file straight on the Desktop bills Desktop',
    projectFolderFor(`${HOME}/Desktop`, [], dotfiles),
    `${HOME}/Desktop`
  )
  eq(
    'Documents hands out its first folder',
    projectFolderFor(`${HOME}/Documents/wolffish`, [], dotfiles),
    `${HOME}/Documents/wolffish`
  )
  eq(
    'a home folder outside the named ones bills itself',
    projectFolderFor(`${HOME}/Pictures/2026/09`, [], dotfiles),
    `${HOME}/Pictures`
  )
  eq(
    'Documents set as the working folder is still a container',
    projectFolderFor(`${HOME}/Documents/wolffish/x`, [`${HOME}/Documents`], dotfiles),
    `${HOME}/Documents/wolffish`
  )
  // The workspace's files tree: one folder per automation, whatever a run
  // nests beneath it, even with a .git on the runtime folder above.
  const run = `${WS_FILES}/wolffish-signal/2026-09-21-0630`
  eq(
    'workspace files bill the automation folder',
    projectFoldersFor([run, `${run}/fonts`, `${run}/shots`], [LANDING], dotfiles),
    {
      [run]: `${WS_FILES}/wolffish-signal`,
      [`${run}/fonts`]: `${WS_FILES}/wolffish-signal`,
      [`${run}/shots`]: `${WS_FILES}/wolffish-signal`
    }
  )
  eq(
    'a repo cloned inside a run folder is its own project',
    projectFolderFor(`${run}/site/src`, [], deps([`${run}/site/.git`])),
    `${run}/site`
  )
  // Outside every container with no marker: the old shape heuristic, then
  // the directory itself.
  eq(
    'bare tree: the outermost src boundary',
    projectFolderFor('/repo/app/src/lib/deep/nested', [], deps([])),
    '/repo/app'
  )
  eq(
    'bare tree: a repo-admin dot-directory folds into its project',
    projectFolderFor('/repo/app/.github/workflows', [], deps([])),
    '/repo/app'
  )
  eq(
    'bare tree, no boundary: the directory itself',
    projectFolderFor('/tmp/scratch', [], deps([])),
    '/tmp/scratch'
  )
  eq(
    'windows separators are normalized',
    projectFolderFor('C:\\proj\\src', ['C:\\proj'], deps([])),
    'C:/proj'
  )
  eq(
    'windows repo root',
    projectFolderFor('C:/proj/src/deep', [], {
      exists: fakeFs(['C:/proj/.git']),
      home: 'C:\\Users\\y',
      workspaceFiles: null
    }),
    'C:/proj'
  )
}

function homeExpansion(): void {
  const tree = deps([`${LANDING}/.git`])
  eq(
    '~ in a directory expands to home before the walk',
    projectFolderFor('~/Documents/wolffish/wolffish-landing/content/blog/en', [], tree),
    LANDING
  )
  eq(
    '~ in a working folder expands to home',
    projectFolderFor(`${HOME}/Desktop/notes/a`, ['~/Desktop/notes'], deps([])),
    `${HOME}/Desktop/notes`
  )
  eq('~ alone is home', projectFolderFor('~', [], deps([])), HOME)
}

/**
 * The strip: attached folders show as chips from the first message on, an
 * attached repo that was edited is one chip with the count, an untouched
 * folder's chip goes when the folder is removed, a touched one's stays, and
 * two spellings of one folder never make two chips.
 */
function strip(): void {
  const project = (dir: string): string | undefined => {
    if (dir === '/pending') return undefined
    for (const root of [LANDING, APP]) {
      if (dir === root || dir === `${root}/` || dir.startsWith(`${root}/`)) return root
    }
    if (dir === '~/Documents/wolffish/wolffish-landing') return LANDING
    return dir
  }
  const landing = { path: LANDING, label: 'wolffish-landing', files: 10 }
  const touched = [landing]
  eq(
    'attached folders first; an attached repo that was edited is ONE chip carrying the count',
    folderChips([APP, LANDING], touched, project),
    [{ path: APP, label: 'wolffish-app', files: 0 }, landing]
  )
  eq(
    'a project edited outside every attached folder follows the attached ones',
    folderChips([APP], touched, project),
    [{ path: APP, label: 'wolffish-app', files: 0 }, landing]
  )
  eq(
    'an untouched folder removed is gone; a touched one stays',
    folderChips([], touched, project),
    [landing]
  )
  eq(
    'one folder attached three ways — as is, trailing slash, ~ — is one chip',
    folderChips([LANDING, `${LANDING}/`, '~/Documents/wolffish/wolffish-landing'], [], project),
    [{ path: LANDING, label: 'wolffish-landing', files: 0 }]
  )
  eq(
    'an attached subfolder of a repo shows as the repo, and meets its edits there',
    folderChips([`${APP}/src/renderer`], [{ path: APP, label: 'wolffish-app', files: 3 }], project),
    [{ path: APP, label: 'wolffish-app', files: 3 }]
  )
  eq(
    'an attached folder main has not resolved yet earns no chip',
    folderChips(['/pending', ''], [], project),
    []
  )
  const many = folderChips(
    [APP, LANDING, `${APP}/`],
    [landing, { path: '/tmp/x', label: 'x', files: 1 }],
    project
  )
  ok('chips are unique by path', new Set(many.map((c) => c.path)).size === many.length, many)
}

function main(): void {
  segmentScan()
  projectResolution()
  homeExpansion()
  strip()
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}
main()
