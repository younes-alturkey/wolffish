/**
 * Device collects identifying facts about the host machine so the LLM
 * can generate the right OS commands, paths, and shell syntax. The
 * facts that never change in-process (OS label, arch, hostname, home,
 * shell, username, total RAM/disk) are sampled once and reused. Free
 * RAM is read fresh every call — `os.freemem()` is a sync syscall and
 * costs nothing. Free disk requires shelling out, so it gets cached
 * with a 60-second TTL to keep the per-message cost flat.
 *
 * Output is rendered as a compact `<device>...</device>` XML block and
 * always included in the system prompt — it bypasses RAS scoring
 * because it's universally relevant: every tool call needs to know
 * what shell and paths it's targeting.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type DiskUsage = {
  totalBytes: number
  freeBytes: number
}

export type DeviceInfo = {
  osLabel: string
  arch: string
  hostname: string
  homeDir: string
  shell: string
  username: string
  ramTotalBytes: number
  ramFreeBytes: number
  disk: DiskUsage | null
}

export type DeviceOptions = {
  diskCacheTtlMs?: number
}

type StaticDeviceInfo = {
  osLabel: string
  arch: string
  hostname: string
  homeDir: string
  shell: string
  username: string
  ramTotalBytes: number
}

const DEFAULT_DISK_CACHE_TTL_MS = 60_000
const SHELL_TIMEOUT_MS = 2_000
const POWERSHELL_TIMEOUT_MS = 5_000

export class Device {
  private staticInfoPromise: Promise<StaticDeviceInfo> | null = null
  private diskCache: { value: DiskUsage | null; expiresAt: number } | null = null
  private readonly diskCacheTtlMs: number

  constructor(options: DeviceOptions = {}) {
    this.diskCacheTtlMs = options.diskCacheTtlMs ?? DEFAULT_DISK_CACHE_TTL_MS
  }

  async getInfo(): Promise<DeviceInfo> {
    const staticInfo = await this.getStaticInfo()
    // ramFreeBytes is the platform-aware "actually available" figure,
    // not raw os.freemem(). On macOS, freemem() ignores reclaimable
    // file cache (Pages inactive/speculative/purgeable) and reports
    // ~99% used even when ~5GB is reclaimable for new allocations.
    // See detectAvailableMemory() for the per-platform formula.
    const ramFreeBytes = await detectAvailableMemory()
    const disk = await this.getCachedDisk(staticInfo.homeDir)
    return {
      osLabel: staticInfo.osLabel,
      arch: staticInfo.arch,
      hostname: staticInfo.hostname,
      homeDir: staticInfo.homeDir,
      shell: staticInfo.shell,
      username: staticInfo.username,
      ramTotalBytes: staticInfo.ramTotalBytes,
      ramFreeBytes,
      disk
    }
  }

  /**
   * Render the device facts as the body of a `<device>` XML block —
   * just the inner lines, without the surrounding tags. The caller
   * (prefrontal) wraps it. Compact format keeps the section under 200
   * tokens even with long hostnames or paths.
   */
  async getBlockBody(): Promise<string> {
    const info = await this.getInfo()
    // Only STATIC facts go in this block. It sits before the <runtime> cache
    // breakpoint, i.e. inside the prefix the provider caches across turns —
    // so anything that changes between turns (free RAM, free disk) would bust
    // that cache and re-bill the whole system prompt every follow-up message.
    // Live headroom is reachable on demand via wolffish_status when needed.
    const lines = [
      `os: ${info.osLabel}`,
      `arch: ${info.arch}`,
      `hostname: ${info.hostname}`,
      `user: ${info.username}`,
      `home: ${info.homeDir}`,
      `shell: ${info.shell}`,
      `ram: ${formatBytes(info.ramTotalBytes)} total`
    ]
    if (info.disk) {
      lines.push(`disk (${info.homeDir}): ${formatBytes(info.disk.totalBytes)} total`)
    }
    return lines.join('\n')
  }

  private getStaticInfo(): Promise<StaticDeviceInfo> {
    if (!this.staticInfoPromise) {
      this.staticInfoPromise = collectStaticInfo().catch((err) => {
        this.staticInfoPromise = null
        throw err
      })
    }
    return this.staticInfoPromise
  }

  private async getCachedDisk(homeDir: string): Promise<DiskUsage | null> {
    const now = Date.now()
    if (this.diskCache && this.diskCache.expiresAt > now) {
      return this.diskCache.value
    }
    const value = await detectDiskUsage(homeDir).catch(() => null)
    this.diskCache = { value, expiresAt: now + this.diskCacheTtlMs }
    return value
  }
}

async function collectStaticInfo(): Promise<StaticDeviceInfo> {
  const homeDir = os.homedir()
  return {
    osLabel: await detectOsLabel(),
    arch: process.arch,
    hostname: os.hostname(),
    homeDir,
    shell: detectShell(),
    username: detectUsername(),
    ramTotalBytes: os.totalmem()
  }
}

async function detectOsLabel(): Promise<string> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('sw_vers', ['-productVersion'], {
        timeout: SHELL_TIMEOUT_MS
      })
      const version = stdout.trim()
      if (version) return `macOS ${version}`
    } catch {
      // fall through to release-based label
    }
    return `macOS (darwin ${os.release()})`
  }

  if (process.platform === 'linux') {
    try {
      const raw = await fs.readFile('/etc/os-release', 'utf8')
      const match = /^PRETTY_NAME="?([^"\n]+?)"?$/m.exec(raw)
      if (match && match[1]) return match[1]
    } catch {
      // fall through
    }
    return `Linux ${os.release()}`
  }

  if (process.platform === 'win32') {
    // os.version() on Windows already returns a friendly label like
    // "Windows 11 Pro" — prefer it when available.
    const v = os.version()
    if (v && /^windows/i.test(v)) return v
    return `Windows ${os.release()}`
  }

  return `${process.platform} ${os.release()}`
}

function detectShell(): string {
  if (process.platform === 'win32') {
    if (process.env.PSModulePath) return 'powershell'
    const com = process.env.COMSPEC
    if (com)
      return path
        .basename(com)
        .toLowerCase()
        .replace(/\.exe$/, '')
    return 'cmd'
  }
  const sh = process.env.SHELL
  if (sh) return path.basename(sh)
  return 'sh'
}

function detectUsername(): string {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'unknown'
  }
}

async function detectDiskUsage(homeDir: string): Promise<DiskUsage | null> {
  if (process.platform === 'win32') {
    return detectDiskUsageWindows(homeDir)
  }
  return detectDiskUsageUnix(homeDir)
}

async function detectDiskUsageUnix(homeDir: string): Promise<DiskUsage | null> {
  try {
    // -k forces 1024-byte blocks (portable units on BSD and GNU df).
    // -P forces POSIX single-line output even when device names are long.
    const { stdout } = await execFileAsync('df', ['-kP', homeDir], {
      timeout: SHELL_TIMEOUT_MS
    })
    const lines = stdout.trim().split('\n')
    if (lines.length < 2) return null
    const fields = lines[1].trim().split(/\s+/)
    // POSIX df: Filesystem 1024-blocks Used Available Capacity Mounted-on
    if (fields.length < 6) return null
    const totalKb = Number.parseInt(fields[1], 10)
    const availKb = Number.parseInt(fields[3], 10)
    if (!Number.isFinite(totalKb) || !Number.isFinite(availKb)) return null
    return { totalBytes: totalKb * 1024, freeBytes: availKb * 1024 }
  } catch {
    return null
  }
}

async function detectDiskUsageWindows(homeDir: string): Promise<DiskUsage | null> {
  const driveMatch = /^([A-Za-z]):/.exec(homeDir)
  if (!driveMatch) return null
  const driveLetter = driveMatch[1].toUpperCase()
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-PSDrive -Name ${driveLetter} | Select-Object Used, Free | ConvertTo-Json`
      ],
      { timeout: POWERSHELL_TIMEOUT_MS }
    )
    const parsed = JSON.parse(stdout) as { Used?: number; Free?: number }
    const used = typeof parsed.Used === 'number' ? parsed.Used : null
    const free = typeof parsed.Free === 'number' ? parsed.Free : null
    if (used === null || free === null) return null
    return { totalBytes: used + free, freeBytes: free }
  } catch {
    return null
  }
}

/**
 * Best-effort "actually available memory" for the current platform.
 * Returns bytes that the OS could hand to a new allocation right now,
 * including reclaimable file cache.
 *
 * - darwin: parse `vm_stat` and sum free + inactive + speculative +
 *   purgeable pages × page size. Inactive pages on macOS are file
 *   cache that the kernel evicts on demand, so they're effectively
 *   free even though `os.freemem()` doesn't count them.
 * - linux: read `MemAvailable` from /proc/meminfo (kernel ≥ 3.14).
 *   It's the kernel's own estimate of reclaimable memory and is what
 *   `free -m` reports under "available".
 * - win32 (and any fallback): `os.freemem()` is closer to truth on
 *   Windows because the working-set model doesn't aggressively park
 *   reclaimable file cache outside "free".
 */
async function detectAvailableMemory(): Promise<number> {
  if (process.platform === 'darwin') {
    const fromVmStat = await detectAvailableMemoryDarwin()
    if (fromVmStat !== null) return fromVmStat
  } else if (process.platform === 'linux') {
    const fromMeminfo = await detectAvailableMemoryLinux()
    if (fromMeminfo !== null) return fromMeminfo
  }
  return os.freemem()
}

async function detectAvailableMemoryDarwin(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('vm_stat', [], { timeout: SHELL_TIMEOUT_MS })
    const pageSizeMatch = /page size of (\d+) bytes/.exec(stdout)
    if (!pageSizeMatch) return null
    const pageSize = Number.parseInt(pageSizeMatch[1], 10)
    if (!Number.isFinite(pageSize) || pageSize <= 0) return null
    const free = parseVmStatPages(stdout, /^Pages free:\s+(\d+)/m)
    const inactive = parseVmStatPages(stdout, /^Pages inactive:\s+(\d+)/m)
    const speculative = parseVmStatPages(stdout, /^Pages speculative:\s+(\d+)/m)
    const purgeable = parseVmStatPages(stdout, /^Pages purgeable:\s+(\d+)/m)
    if (free === null || inactive === null || speculative === null || purgeable === null) {
      return null
    }
    return (free + inactive + speculative + purgeable) * pageSize
  } catch {
    return null
  }
}

function parseVmStatPages(stdout: string, pattern: RegExp): number | null {
  const m = pattern.exec(stdout)
  if (!m) return null
  const n = Number.parseInt(m[1], 10)
  return Number.isFinite(n) ? n : null
}

async function detectAvailableMemoryLinux(): Promise<number | null> {
  try {
    const raw = await fs.readFile('/proc/meminfo', 'utf8')
    const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(raw)
    if (!m) return null
    const kb = Number.parseInt(m[1], 10)
    if (!Number.isFinite(kb)) return null
    return kb * 1024
  } catch {
    return null
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes < 1024 * 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(1)} TB`
}
