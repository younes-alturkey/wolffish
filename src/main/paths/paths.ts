/**
 * Directory listings for the Web UI's folder picker. A browser has no dialog
 * for the machine the agent runs on, so the sheet browses it through this:
 * one level at a time, folders only, with the ancestors a breadcrumb needs
 * and the two places people start from (home, the workspace). The agent
 * already has the whole filesystem; this is a narrower view for the person
 * steering it, and it never lists files.
 */
import { workspaceRoot } from '@main/workspace/root'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export type DirectoryEntry = { name: string; path: string; hidden: boolean }

export type DirectoryListing = {
  /** The folder listed, absolute, `~` expanded. */
  path: string
  parent: string | null
  /** Every ancestor from the root down to `path`, for a breadcrumb. */
  crumbs: Array<{ name: string; path: string }>
  entries: DirectoryEntry[]
  truncated: boolean
  home: string
  workspace: string
  /** Why the folder could not be read, when it could not; `entries` is empty then. */
  error: string | null
}

const MAX_ENTRIES = 1000

/** `~` and `~/…` to the home directory; anything else resolved absolute. */
export function expandHome(input: string): string {
  const text = (input ?? '').trim()
  if (text === '' || text === '~') return os.homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2))
  return path.resolve(text)
}

export async function listDirectories(
  input: string,
  options: { hidden?: boolean } = {}
): Promise<DirectoryListing> {
  const target = expandHome(input)
  const root = path.parse(target).root
  const base = {
    path: target,
    parent: target === root ? null : path.dirname(target),
    crumbs: crumbsOf(target),
    entries: [] as DirectoryEntry[],
    truncated: false,
    home: os.homedir(),
    workspace: workspaceRoot()
  }
  let dirents: import('node:fs').Dirent[]
  try {
    dirents = await fs.readdir(target, { withFileTypes: true })
  } catch (err) {
    return { ...base, error: describeError(err, target) }
  }
  const entries: DirectoryEntry[] = []
  for (const dirent of dirents) {
    let isDirectory = dirent.isDirectory()
    if (!isDirectory && dirent.isSymbolicLink()) {
      // A symlink to a folder is a folder to anyone navigating into it.
      try {
        isDirectory = (await fs.stat(path.join(target, dirent.name))).isDirectory()
      } catch {
        isDirectory = false
      }
    }
    if (!isDirectory) continue
    const hidden = dirent.name.startsWith('.')
    if (hidden && !options.hidden) continue
    entries.push({ name: dirent.name, path: path.join(target, dirent.name), hidden })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  const truncated = entries.length > MAX_ENTRIES
  return {
    ...base,
    entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries,
    truncated,
    error: null
  }
}

function crumbsOf(target: string): Array<{ name: string; path: string }> {
  const root = path.parse(target).root
  const crumbs = [{ name: root, path: root }]
  const rest = path.relative(root, target)
  if (!rest) return crumbs
  let current = root
  for (const segment of rest.split(path.sep)) {
    if (!segment) continue
    current = path.join(current, segment)
    crumbs.push({ name: segment, path: current })
  }
  return crumbs
}

function describeError(err: unknown, target: string): string {
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') return `${target} does not exist`
  if (code === 'ENOTDIR') return `${target} is a file, not a folder`
  if (code === 'EACCES' || code === 'EPERM') return `no permission to read ${target}`
  return err instanceof Error ? err.message : String(err)
}
