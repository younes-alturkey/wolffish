import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { workspaceRoot } from '@main/workspace/workspace'

export type DataAnalytics = {
  workspaceBytes: number
  hippocampusBytes: number
  corpusBytes: number
  prefrontalBytes: number
  ramBytes: number
  cpuPercent: number
  totalRamBytes: number
  cpuCount: number
  /** Volume the workspace lives on. Null when the OS refuses statfs — the
   *  panels render an em dash rather than a made-up disk. */
  freeDiskBytes: number | null
  totalDiskBytes: number | null
}

/**
 * Walk a directory tree and sum every regular file's size in bytes.
 * Returns 0 for missing directories so a never-touched region (e.g. a
 * fresh prefrontal/.debug/ that hasn't been written to yet) shows as
 * 0 B instead of erroring.
 */
async function dirSize(dir: string): Promise<number> {
  let total = 0
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await dirSize(child)
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(child)
        total += stat.size
      } catch {
        // skip unreadable entries
      }
    }
  }
  return total
}

/**
 * Sample CPU usage of the main process over a short interval. Returns a
 * percentage of one core; >100% means the process is using more than one
 * core's worth of CPU (process.cpuUsage sums every thread in the process).
 *
 * Nothing else may run in this process during the window — the sample
 * measures whatever the process is doing, so any concurrent work becomes
 * the reading. Callers must await their own work before sampling.
 */
async function sampleCpuPercent(intervalMs = 250): Promise<number> {
  const start = process.cpuUsage()
  const startWall = Date.now()
  await new Promise((resolve) => setTimeout(resolve, intervalMs))
  const diff = process.cpuUsage(start)
  const elapsedMicros = (Date.now() - startWall) * 1000
  if (elapsedMicros <= 0) return 0
  return ((diff.user + diff.system) / elapsedMicros) * 100
}

/** Free/total bytes of the volume holding `dir`, or nulls where unsupported. */
async function diskSpace(dir: string): Promise<{ free: number | null; total: number | null }> {
  try {
    const stats = await fs.statfs(dir)
    return { free: stats.bsize * stats.bavail, total: stats.bsize * stats.blocks }
  } catch {
    return { free: null, total: null }
  }
}

export async function getDataAnalytics(): Promise<DataAnalytics> {
  const root = workspaceRoot()
  const brainDir = path.join(root, 'brain')

  const [workspaceBytes, hippocampusBytes, corpusBytes, prefrontalBytes, disk] = await Promise.all([
    dirSize(root),
    dirSize(path.join(brainDir, 'hippocampus')),
    dirSize(path.join(brainDir, 'corpus')),
    dirSize(path.join(brainDir, 'prefrontal')),
    diskSpace(root)
  ])

  // Sample only once the walks above have finished. Sampling alongside them
  // measured this function's own readdir/stat storm rather than the app: an
  // otherwise-idle process read ~0.3% standalone but ~93% inside the walk.
  const cpuPercent = await sampleCpuPercent()

  return {
    workspaceBytes,
    hippocampusBytes,
    corpusBytes,
    prefrontalBytes,
    ramBytes: process.memoryUsage().rss,
    cpuPercent,
    totalRamBytes: os.totalmem(),
    cpuCount: os.cpus().length,
    freeDiskBytes: disk.free,
    totalDiskBytes: disk.total
  }
}
