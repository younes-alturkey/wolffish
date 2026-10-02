/**
 * The project a changed file is charged to — the folder a chip over the
 * transcript names and opens. One rule, applied per touched directory, so a
 * run never costs the strip a chain of nested directories and the chip always
 * reads as the folder you would open to see the work: `wolffish-landing`, not
 * `blog`; `wolffish-app`, not `src`.
 *
 * Resolution order, first match wins:
 *
 *  1. The repository root — the nearest ancestor holding `.git` (a directory,
 *     or the file a worktree/submodule keeps). Nothing on a path says "this is
 *     the project" more plainly, and it needs no knowledge of how the tree is
 *     shaped: a blog under `content/`, an app under `src/`, a crate under
 *     `crates/` all collapse to their repo. A working folder never overrides
 *     it — set the folder to `wolffish-app/src/renderer` or to the parent
 *     holding ten repos, and the chip is still the repo the file lives in.
 *  2. The nearest ancestor holding a project manifest (package.json,
 *     pyproject.toml, Cargo.toml, go.mod, …), for a project that is not a
 *     repository.
 *  3. A container the directory sits in: a working folder (the folder itself
 *     — the user named it as the project), the workspace's `files/` tree (the
 *     automation's own folder directly under it — "one folder per run" is the
 *     app's own convention), or the home directory and its Desktop, Documents
 *     and Downloads (the first folder under them). Longest match wins.
 *  4. The old shape heuristic — the path before the outermost `src`, `lib`,
 *     `test`, `docs` or repo-admin dot-directory — for a bare tree with none
 *     of the above.
 *  5. The directory itself.
 *
 * The marker walk in 1 and 2 stops at the fixed containers of 3 and never
 * climbs above home: a dotfiles repo at `~/.git`, or a `.git` on the runtime
 * folder, would otherwise swallow every file on the machine into one chip.
 *
 * Pure: the filesystem enters through `deps.exists`, so the rules are tested
 * against a fake tree (src/main/runtime/__tests__/touched-folders.test.ts).
 * Paths are compared with forward slashes; callers may pass either separator.
 */

export type ProjectFolderDeps = {
  /** Whether a path exists (file or directory). */
  exists: (p: string) => boolean
  /** The user's home directory. */
  home: string
  /** `~/.wolffish/workspace/files`, or null when there is no workspace. */
  workspaceFiles: string | null
}

const REPO_MARKERS = ['.git']
const MANIFEST_MARKERS = [
  'package.json',
  'pyproject.toml',
  'setup.py',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
  'Package.swift',
  'mix.exs',
  'deno.json',
  'pubspec.yaml',
  'CMakeLists.txt'
]
const BOUNDARY_RE = /^(src|lib|test|tests|docs|doc|scripts)$/
const PROJECT_MARKER_RE = /^(\.github|\.githooks|\.gitlab|\.circleci|\.vscode|\.idea|\.husky)$/
const HOME_CONTAINERS = ['Desktop', 'Documents', 'Downloads']

export function normalizePath(p: string): string {
  const slashed = p.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (slashed.length > 1 && slashed.endsWith('/')) return slashed.replace(/\/+$/, '')
  return slashed
}

/** A leading `~` is the home directory — a folder typed into an automation's
 *  `dir:` line, or a project's, may carry one; the filesystem does not. */
function expandHome(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/')) return `${home}/${p.slice(2)}`
  return p
}

function parentOf(p: string): string | null {
  const idx = p.lastIndexOf('/')
  if (idx < 0) return null
  if (idx === 0) return p === '/' ? null : '/'
  const up = p.slice(0, idx)
  // `C:` is the root of a drive path; nothing sits above it.
  if (/^[a-zA-Z]:$/.test(up)) return p === `${up}/` ? null : `${up}/`
  return up
}

function isWithin(dir: string, container: string): boolean {
  if (dir === container) return true
  const base = container.endsWith('/') ? container : `${container}/`
  return dir.startsWith(base)
}

function firstSegmentUnder(dir: string, container: string): string {
  if (dir === container) return dir
  const base = container.endsWith('/') ? container : `${container}/`
  const segment = dir.slice(base.length).split('/')[0]
  return segment ? `${base}${segment}` : dir
}

/** The fixed containers (never projects themselves), longest first. */
function fixedContainers(deps: ProjectFolderDeps): string[] {
  const home = normalizePath(deps.home)
  const out = [
    ...(deps.workspaceFiles ? [normalizePath(deps.workspaceFiles)] : []),
    ...HOME_CONTAINERS.map((name) => `${home}/${name}`),
    home
  ]
  return out.sort((a, b) => b.length - a.length)
}

/**
 * The nearest ancestor of `dir` (itself included) holding one of `markers`,
 * walking up until `stopAt` (exclusive) or the filesystem root. Null when
 * none does.
 */
function nearestWithMarker(
  dir: string,
  markers: readonly string[],
  stopAt: string | null,
  exists: (p: string) => boolean
): string | null {
  let cursor: string | null = dir
  while (cursor && cursor !== stopAt) {
    const base = cursor.endsWith('/') ? cursor : `${cursor}/`
    for (const marker of markers) {
      if (exists(`${base}${marker}`)) return cursor
    }
    cursor = parentOf(cursor)
  }
  return null
}

function shapeCut(dir: string): string | null {
  const parts = dir.split('/').filter(Boolean)
  for (let i = 1; i < parts.length; i++) {
    if (BOUNDARY_RE.test(parts[i]) || PROJECT_MARKER_RE.test(parts[i])) {
      const at = parts.slice(0, i).join('/')
      return dir.startsWith('/') ? `/${at}` : at
    }
  }
  return null
}

/** The project folder `dir` is charged to. See the module comment for the rules. */
export function projectFolderFor(
  rawDir: string,
  workingFolders: readonly string[],
  deps: ProjectFolderDeps
): string {
  const home = normalizePath(deps.home)
  const dir = expandHome(normalizePath(rawDir), home)
  if (!dir) return dir
  const containers = fixedContainers(deps)
  const stopAt = containers.find((c) => isWithin(dir, c)) ?? null

  // 1 + 2: repository, then manifest — never at or above a fixed container.
  const repo = nearestWithMarker(dir, REPO_MARKERS, stopAt, deps.exists)
  if (repo) return repo
  const manifest = nearestWithMarker(dir, MANIFEST_MARKERS, stopAt, deps.exists)
  if (manifest) return manifest

  // 3: the longest container holding the directory. A working folder that IS
  // a fixed container (someone set Documents itself) is not a project; the
  // first folder under it is.
  let working: string | null = null
  for (const raw of workingFolders) {
    const folder = expandHome(normalizePath(raw), home)
    if (folder && isWithin(dir, folder) && (!working || folder.length > working.length)) {
      working = folder
    }
  }
  if (working && (!stopAt || working.length > stopAt.length)) return working
  if (stopAt) return firstSegmentUnder(dir, stopAt)

  // 4 + 5: the shape heuristic, else the directory as it is.
  return shapeCut(dir) ?? dir
}

/** `projectFolderFor` over many directories, keyed by the directory as given. */
export function projectFoldersFor(
  dirs: readonly string[],
  workingFolders: readonly string[],
  deps: ProjectFolderDeps
): Record<string, string> {
  const cache = new Map<string, boolean>()
  const exists = (p: string): boolean => {
    const hit = cache.get(p)
    if (hit !== undefined) return hit
    const value = deps.exists(p)
    cache.set(p, value)
    return value
  }
  const memo = { ...deps, exists }
  const out: Record<string, string> = {}
  for (const dir of dirs) {
    if (typeof dir !== 'string' || !dir) continue
    out[dir] = projectFolderFor(dir, workingFolders, memo)
  }
  return out
}
