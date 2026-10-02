import { diskWriter } from '@main/io/diskWriter'
import fs from 'node:fs/promises'
import path from 'node:path'
import { defaultsWorkspacePath, workspaceRoot } from '@main/workspace/workspace'

export type ViewerTreeNode =
  | { type: 'dir'; name: string; relativePath: string; children: ViewerTreeNode[] }
  | { type: 'file'; name: string; relativePath: string }

function viewerRoot(): string {
  return workspaceRoot()
}

function defaultViewerRoot(): string {
  return defaultsWorkspacePath()
}

function resolveScoped(root: string, relativePath: string): string {
  const normalized = path.normalize(relativePath).replace(/^[/\\]+/, '')
  const target = path.resolve(root, normalized)
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new Error(`path escapes viewer root: ${relativePath}`)
  }
  return target
}

async function readDirRecursive(absDir: string, relDir: string): Promise<ViewerTreeNode[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true })
  } catch {
    return []
  }

  const nodes: ViewerTreeNode[] = []
  for (const entry of entries) {
    if (entry.name === '.DS_Store' || entry.name === '.gitkeep') continue
    if (entry.name === '.lock') continue
    const childRel = relDir ? `${relDir}/${entry.name}` : entry.name
    const childAbs = path.join(absDir, entry.name)
    if (entry.isDirectory()) {
      nodes.push({
        type: 'dir',
        name: entry.name,
        relativePath: childRel,
        children: await readDirRecursive(childAbs, childRel)
      })
    } else if (entry.isFile()) {
      nodes.push({ type: 'file', name: entry.name, relativePath: childRel })
    }
  }

  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

export async function readViewerTree(): Promise<ViewerTreeNode[]> {
  return readDirRecursive(viewerRoot(), '')
}

export async function readViewerFile(relativePath: string): Promise<string> {
  const target = resolveScoped(viewerRoot(), relativePath)
  return fs.readFile(target, 'utf8')
}

export async function readViewerBinaryFile(relativePath: string): Promise<Buffer> {
  const target = resolveScoped(viewerRoot(), relativePath)
  return fs.readFile(target)
}

/** Absolute on-disk path for a viewer-relative path, or null if it escapes the root. */
export function resolveViewerPath(relativePath: string): string | null {
  try {
    return resolveScoped(viewerRoot(), relativePath)
  } catch {
    return null
  }
}

export async function statViewerFile(relativePath: string): Promise<{ mtimeMs: number }> {
  const target = resolveScoped(viewerRoot(), relativePath)
  const s = await fs.stat(target)
  return { mtimeMs: s.mtimeMs }
}

export async function writeViewerFile(relativePath: string, content: string): Promise<void> {
  const target = resolveScoped(viewerRoot(), relativePath)
  await diskWriter.writeFileAtomic(target, content)
}

export async function hasBundledDefault(relativePath: string): Promise<boolean> {
  try {
    const target = resolveScoped(defaultViewerRoot(), relativePath)
    const stat = await fs.stat(target)
    return stat.isFile()
  } catch {
    return false
  }
}

export async function readBundledDefault(relativePath: string): Promise<string> {
  const target = resolveScoped(defaultViewerRoot(), relativePath)
  return fs.readFile(target, 'utf8')
}
