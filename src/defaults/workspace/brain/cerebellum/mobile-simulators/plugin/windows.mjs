// Window locator: where on the host screen is the simulator or emulator
// window for a device? The driving indicator frames that rectangle.
//
// macOS: a tiny Swift helper over CGWindowListCopyWindowInfo, compiled once
//        with swiftc (present wherever Xcode is) into the managed bin dir;
//        JXA over System Events as the fallback (needs Accessibility).
//        Owner name and bounds need no permission; window titles need
//        Screen Recording, which is why the fallback and the "single window
//        of that owner" rule exist.
// Windows: PowerShell + user32 (EnumWindows / GetWindowRect), physical px.
// Linux:   xdotool when present.
//
// Results are `{ owner, pid, title, id, x, y, w, h }` in the platform's
// native window units (logical points on macOS, physical px on Windows and
// X11); the indicator converts to Electron DIP where needed.
import { createHash } from 'node:crypto'
import { access, constants, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { run } from './exec.mjs'

const SWIFT_SRC = `import Cocoa
import Foundation
let opts = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
let list = (CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]]) ?? []
var out: [[String: Any]] = []
for w in list {
  guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
  guard let b = w[kCGWindowBounds as String] as? [String: Any] else { continue }
  out.append([
    "owner": (w[kCGWindowOwnerName as String] as? String) ?? "",
    "pid": (w[kCGWindowOwnerPID as String] as? Int) ?? 0,
    "title": (w[kCGWindowName as String] as? String) ?? "",
    "id": (w[kCGWindowNumber as String] as? Int) ?? 0,
    "x": b["X"] ?? 0, "y": b["Y"] ?? 0, "w": b["Width"] ?? 0, "h": b["Height"] ?? 0
  ])
}
if let data = try? JSONSerialization.data(withJSONObject: out), let s = String(data: data, encoding: .utf8) { print(s) } else { print("[]") }
`

const HELPER_DIR = path.join(homedir(), '.wolffish', 'bin', 'wolffish-winfo')
let helperPath = null
let helperTried = false
let capabilityNote = null

async function exists(p) {
  try {
    await access(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Compile the CGWindowList helper once (keyed by source hash). Null when swiftc is unavailable. */
async function macHelper() {
  if (helperPath) return helperPath
  if (helperTried) return null
  helperTried = true
  const hash = createHash('sha1').update(SWIFT_SRC).digest('hex').slice(0, 10)
  const bin = path.join(HELPER_DIR, `winfo-${hash}`)
  if (await exists(bin)) {
    helperPath = bin
    return bin
  }
  const swiftc = await run('xcrun', ['--find', 'swiftc'], { timeout: 15_000 })
  if (swiftc.code !== 0) {
    capabilityNote = 'swiftc not found; using System Events for window bounds'
    return null
  }
  // swiftc needs the macOS SDK to find its standard library; `xcrun swiftc`
  // alone picks the toolchain but not the SDK when run outside a shell.
  const sdk = await run('xcrun', ['--show-sdk-path', '--sdk', 'macosx'], { timeout: 15_000 })
  await mkdir(HELPER_DIR, { recursive: true })
  const src = path.join(HELPER_DIR, `winfo-${hash}.swift`)
  await writeFile(src, SWIFT_SRC, 'utf8')
  const sdkArgs = sdk.code === 0 && sdk.out.trim() ? ['-sdk', sdk.out.trim()] : []
  const c = await run('xcrun', ['swiftc', '-O', ...sdkArgs, '-o', bin, src], { timeout: 180_000 })
  if (c.code !== 0 || !(await exists(bin))) {
    capabilityNote = `window helper failed to compile (${(c.err || c.out).trim().split('\n').pop() ?? 'unknown'}); using System Events`
    return null
  }
  helperPath = bin
  return bin
}

async function macWindowsViaHelper() {
  const bin = await macHelper()
  if (!bin) return null
  const r = await run(bin, [], { timeout: 8000 })
  if (r.code !== 0) return null
  try {
    return JSON.parse(r.out)
  } catch {
    return null
  }
}

async function macWindowsViaJxa(owners) {
  const script =
    `const se = Application('System Events'); const want = ${JSON.stringify(owners)}; const out = [];` +
    `for (const p of se.processes()) { let n = ''; try { n = p.name() } catch (e) { continue } if (want.length && !want.includes(n)) continue;` +
    `let ws = []; try { ws = p.windows() } catch (e) { continue }` +
    `for (const w of ws) { try { const pos = w.position(); const sz = w.size(); out.push({ owner: n, pid: p.unixId(), title: w.name() || '', id: 0, x: pos[0], y: pos[1], w: sz[0], h: sz[1] }) } catch (e) {} } }` +
    `JSON.stringify(out)`
  const r = await run('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 10_000 })
  if (r.code !== 0) return null
  try {
    return JSON.parse(r.out.trim())
  } catch {
    return null
  }
}

async function windowsViaPowershell(processNames) {
  const ps =
    `Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class W { [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
 public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; } }
"@
$names = @(${processNames.map((n) => `'${n.replace(/'/g, "''")}'`).join(',')})
$out = New-Object System.Collections.ArrayList
$cb = [W+EnumWindowsProc]{ param($h, $l)
  if (-not [W]::IsWindowVisible($h)) { return $true }
  $pid = 0; [void][W]::GetWindowThreadProcessId($h, [ref]$pid)
  $p = Get-Process -Id $pid -ErrorAction SilentlyContinue; if ($null -eq $p) { return $true }
  if ($names.Count -gt 0 -and ($names -notcontains $p.ProcessName)) { return $true }
  $len = [W]::GetWindowTextLength($h); $sb = New-Object System.Text.StringBuilder ($len + 1); [void][W]::GetWindowText($h, $sb, $len + 1)
  $r = New-Object W+RECT; [void][W]::GetWindowRect($h, [ref]$r)
  [void]$out.Add(@{ owner = $p.ProcessName; pid = $pid; title = $sb.ToString(); id = [int64]$h; x = $r.L; y = $r.T; w = ($r.R - $r.L); h = ($r.B - $r.T) })
  return $true }
[void][W]::EnumWindows($cb, [IntPtr]::Zero)
ConvertTo-Json -Compress -InputObject @($out)`
  const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 20_000 })
  if (r.code !== 0) return null
  try {
    const parsed = JSON.parse(r.out.trim() || '[]')
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return null
  }
}

async function linuxViaXdotool(titleNeedle) {
  const search = await run('xdotool', ['search', '--onlyvisible', '--name', titleNeedle], { timeout: 8000 })
  if (search.code !== 0) return null
  const out = []
  for (const id of search.out.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const g = await run('xdotool', ['getwindowgeometry', '--shell', id], { timeout: 5000 })
    if (g.code !== 0) continue
    const kv = Object.fromEntries(g.out.split('\n').map((l) => l.split('=')).filter((p) => p.length === 2))
    const name = await run('xdotool', ['getwindowname', id], { timeout: 5000 })
    const pid = await run('xdotool', ['getwindowpid', id], { timeout: 5000 })
    out.push({ owner: 'xdotool', pid: Number(pid.out.trim()) || 0, title: name.out.trim(), id: Number(id), x: Number(kv.X), y: Number(kv.Y), w: Number(kv.WIDTH), h: Number(kv.HEIGHT) })
  }
  return out
}

/**
 * Every visible top-level window of the given owners (process names) on
 * this platform, best effort. Returns `{ windows, via, note }`.
 */
export async function listWindows({ owners = [], titleNeedle = '' } = {}) {
  if (process.platform === 'darwin') {
    const viaHelper = await macWindowsViaHelper()
    if (viaHelper) {
      const filtered = owners.length ? viaHelper.filter((w) => owners.includes(w.owner)) : viaHelper
      // Titles need Screen Recording; when they are all empty, ask System Events.
      if (filtered.length && filtered.every((w) => !w.title)) {
        const jxa = await macWindowsViaJxa(owners)
        if (jxa && jxa.length) return { windows: jxa, via: 'system-events', note: 'window titles unavailable to CGWindowList (Screen Recording not granted); used Accessibility' }
      }
      return { windows: filtered, via: 'cgwindowlist', note: capabilityNote }
    }
    const jxa = await macWindowsViaJxa(owners)
    if (jxa) return { windows: jxa, via: 'system-events', note: capabilityNote }
    return { windows: [], via: 'none', note: capabilityNote ?? 'no window locator available' }
  }
  if (process.platform === 'win32') {
    const w = await windowsViaPowershell(owners)
    return { windows: w ?? [], via: w ? 'user32' : 'none', note: w ? null : 'PowerShell window enumeration failed' }
  }
  const w = await linuxViaXdotool(titleNeedle || 'Android Emulator')
  return { windows: w ?? [], via: w ? 'xdotool' : 'none', note: w ? null : 'xdotool not available' }
}

/** Owner process names of the emulator window per platform. */
export function emulatorOwners() {
  if (process.platform === 'darwin') return ['qemu-system-aarch64', 'qemu-system-x86_64', 'emulator']
  if (process.platform === 'win32') return ['qemu-system-x86_64', 'qemu-system-aarch64', 'emulator']
  return ['qemu-system-x86_64', 'qemu-system-aarch64', 'emulator']
}

/**
 * The window that shows `target`. iOS: owner Simulator, title == device
 * name (or the only Simulator window). Android: an emulator window whose
 * title carries the AVD name or console port; largest wins (the toolbar is
 * a separate small window).
 */
export async function locateDeviceWindow(target) {
  if (target.platform === 'ios') {
    const { windows, via, note } = await listWindows({ owners: ['Simulator'] })
    const sims = windows.filter((w) => w.w > 80 && w.h > 80)
    const byTitle = sims.filter((w) => w.title && (w.title === target.name || w.title.startsWith(`${target.name} `) || w.title.startsWith(`${target.name} –`)))
    const pick = byTitle[0] ?? (sims.length === 1 ? sims[0] : null)
    return { window: pick, candidates: sims, via, note, ambiguous: !pick && sims.length > 1 }
  }
  const port = (/^emulator-(\d+)$/.exec(target.id) ?? [])[1]
  const { windows, via, note } = await listWindows({ owners: emulatorOwners(), titleNeedle: 'Android Emulator' })
  const emus = windows.filter((w) => w.w > 120 && w.h > 120)
  const byTitle = emus.filter((w) => w.title && ((port && w.title.endsWith(`:${port}`)) || (target.name && w.title.includes(target.name))))
  const pool = byTitle.length ? byTitle : emus
  pool.sort((a, b) => b.w * b.h - a.w * a.h)
  const pick = byTitle.length ? pool[0] : emus.length ? pool[0] : null
  return { window: pick, candidates: emus, via, note, ambiguous: !byTitle.length && emus.length > 1 }
}

export function __resetWindows() {
  helperPath = null
  helperTried = false
  capabilityNote = null
}
