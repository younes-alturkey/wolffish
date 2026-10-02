import os from 'node:os'
import fs from 'node:fs/promises'

export type SystemInfo = {
  totalRamBytes: number
  freeDiskBytes: number | null
  totalDiskBytes: number | null
  platform: NodeJS.Platform
  arch: string
  cpuCount: number
  cpuModel: string
}

export async function detectSystem(): Promise<SystemInfo> {
  const disk = await detectDisk()
  return {
    totalRamBytes: os.totalmem(),
    freeDiskBytes: disk.free,
    totalDiskBytes: disk.total,
    platform: process.platform,
    arch: process.arch,
    cpuCount: os.cpus().length,
    cpuModel: os.cpus()[0]?.model.trim() ?? 'Unknown CPU'
  }
}

async function detectDisk(): Promise<{ free: number | null; total: number | null }> {
  try {
    // statfs landed in Node 18.15. Probing the home directory is good enough
    // for a "do you have room for a model" heuristic.
    const stats = await fs.statfs(os.homedir())
    return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize }
  } catch {
    return { free: null, total: null }
  }
}
