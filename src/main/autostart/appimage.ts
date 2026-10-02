/**
 * An AppImage does not run from where it lives.
 *
 * The runtime mounts the image at a fresh `/tmp/.mount_WolffiXXXXXX` for the
 * lifetime of the process and unmounts it on exit, so `app.getPath('exe')` and
 * `process.resourcesPath` both point INSIDE a directory that is gone the moment
 * the app closes — and that has a different name next time. Anything this app
 * writes for later therefore recorded a path that could never work again: the
 * CLI shim (`wolffish: No such file or directory` from the first day), the
 * systemd unit, the XDG autostart entry. Each of those is written once and read
 * by something else much later, which is exactly the worst case for a path that
 * expires; the app itself never noticed, because within a single run the mount
 * is real.
 *
 * The runtime exports `APPIMAGE` holding the path of the .AppImage FILE, which
 * is the stable handle to the same app. electron-updater already depends on it
 * to find the file it replaces on update, so it is as load-bearing as it looks.
 *
 * Everything here is a no-op off the AppImage path: a .deb, .rpm, .dmg or NSIS
 * install unpacks to a real directory and needs none of it.
 */
import { wlog } from '@main/workspace/logger'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const TAG = '[appimage]'

/** The .AppImage this process was launched from, or null when it wasn't. */
export function appImagePath(): string | null {
  const value = process.env.APPIMAGE
  return value && value.length > 0 ? value : null
}

/**
 * The path to this app that will still resolve tomorrow. Pass anything about to
 * be written into a shim, a unit file or a scheduled task.
 */
export function stableExecPath(execPath: string): string {
  return appImagePath() ?? execPath
}

/**
 * The environment a launcher needs to start this app the way it is running now.
 *
 * On a box with no `/dev/fuse` — a container started without the device — an
 * AppImage cannot mount and only runs by unpacking itself, which the runtime
 * does when `APPIMAGE_EXTRACT_AND_RUN` is set. The installer works that out
 * once and bakes it into the launcher it writes, but the shim written HERE
 * would launch the same file with a bare exec and simply fail on those
 * machines. Rather than repeat the installer's guess with our own copy of the
 * logic, copy the answer: this process is proof of a launch that worked.
 *
 * Returned as a bare NAME=VALUE because the three writers that need it are not
 * all shells: a POSIX shim takes it as a command prefix, a systemd unit as an
 * `Environment=` line, a .desktop entry as an argument to `env`.
 *
 * Null for every other kind of install, and for an AppImage that mounted
 * normally — self-extraction costs hundreds of megabytes per run and is never
 * something to opt into on a hunch.
 */
export function appImageLaunchEnv(): string | null {
  if (!appImagePath()) return null
  const extract = process.env.APPIMAGE_EXTRACT_AND_RUN
  return extract && extract.length > 0 ? 'APPIMAGE_EXTRACT_AND_RUN=1' : null
}

/**
 * The CLI client, at a path that outlives the process that copied it.
 *
 * Pointing the shim at the .AppImage fixes the binary but not the script it has
 * to run: `<mount>/resources/cli/wolffish-cli-linux-x64` expires with the mount, and its
 * replacement is unknowable from outside (the mount name is random per run, so
 * no fixed string can name it). The client is 400 KB of plain ESM importing
 * nothing but node builtins, so the honest fix is to lift it out of the image
 * and keep a copy under ~/.wolffish, where `rm -rf ~/.wolffish` still ends it.
 *
 * Re-copied on every boot rather than once: an AppImage self-updates in place,
 * and a CLI a version behind its daemon is a bug report nobody can reproduce.
 * Overwrite-in-place, never delete-then-copy — a `wolffish` starting up during
 * the gap would import half a client.
 *
 * Best-effort. If the copy fails the caller gets the in-mount path back, which
 * is no worse than what shipped before this existed.
 */
export async function stableCliEntry(entry: string): Promise<string> {
  if (!appImagePath()) return entry

  const dest = path.join(os.homedir(), '.wolffish', 'cli')
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.cp(path.dirname(entry), dest, { recursive: true, force: true })
    return path.join(dest, path.basename(entry))
  } catch (err) {
    wlog.warn(TAG, `cli copy failed: ${err instanceof Error ? err.message : String(err)}`)
    return entry
  }
}
