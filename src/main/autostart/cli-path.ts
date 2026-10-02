/**
 * Making `wolffish` a command the shell can find, on all three platforms.
 *
 * This is the single most consequential piece of the CLI: everything else is
 * unreachable if the shell can't resolve the name, and the failure looks like
 * "wolffish: command not found" rather than anything that points at a fix. So
 * the app reports the state honestly (installed / missing / shadowed by
 * something else) and offers to install it, instead of assuming the packaging
 * did it.
 *
 * The entry point is a SHIM that execs the compiled client
 * (`resources/cli/wolffish-cli-<os>-<arch>`), never the app binary itself:
 * booting ~150 MB of Electron to run `wolffish ls` is absurd, and on Windows
 * the packaged app is GUI-subsystem and would print nothing to a console. The
 * client is its own console executable (built with Bun, see src/cli), so the
 * shim's only jobs are to find the right binary for this machine and to tell
 * it where the app lives (`WOLFFISH_EXEC`, for starting a daemon that is not
 * running).
 *
 * On Linux the `.deb`/`.rpm` postinst runs `update-alternatives --install` for
 * the app binary — but under electron-builder that is named after
 * package.json#name, so what appears is `/usr/bin/wolffish-app`, NOT
 * `/usr/bin/wolffish`. The name this shim wants is free on a freshly installed
 * machine, and until the app has booted once there is no `wolffish` at all:
 * the installer has to name `wolffish-app` for the first launch, because it is
 * the only command that exists yet.
 */
import { appImageLaunchEnv, stableCliEntry, stableExecPath } from '@main/autostart/appimage'
import { wlog } from '@main/workspace/logger'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const TAG = '[cli-path]'

export type CliPathStatus = {
  /** `wolffish` resolves on PATH and points at our shim. */
  installed: boolean
  /**
   * Our shim FILE exists, whether or not the shell can find it.
   *
   * Not the same question as `installed`, and the difference is what a Remove
   * control has to gate on: a shim written into a directory that is not on
   * PATH, or one shadowed by another binary, reports `installed: false` while
   * very much still being a file this app put there. Gating removal on
   * `installed` hid the button in exactly the cases someone wants it.
   */
  present: boolean
  /** Where the shim is (or would be) written. */
  target: string
  /** What `which wolffish` actually answers, when anything does. */
  resolved: string | null
  /**
   * The shim's directory is not on PATH, so writing it changed nothing the
   * shell can see. Carries the line to add to the profile.
   */
  needsPathEntry: boolean
  /**
   * The app has already put the shim's folder on PATH for NEW terminals —
   * a marked block in the shell profiles (POSIX) or the user PATH (Windows).
   * With `needsPathEntry` this means "open a new terminal", not "do this".
   */
  profileHasEntry: boolean
  /** Shell snippet that fixes `needsPathEntry` by hand — only when the app could not. */
  profileHint: string | null
  /** Something else already owns the name — usually a stale symlink. */
  shadowedBy: string | null
  /** Populated when install failed; surfaced verbatim as an alert. */
  error: string | null
}

/**
 * Where the shim goes: `~/.wolffish/bin`, the app's own managed bin directory
 * — the same one that already holds `gog`, `ffmpeg` and the voice engines.
 *
 * It used to be `~/.local/bin` on POSIX, chosen because that is the XDG
 * convention and is usually already on PATH. Two things were wrong with that.
 * It broke the project's own hard rule — *uninstall must be `rm -rf
 * ~/.wolffish/`* — by leaving an executable behind that pointed at a deleted
 * app. And the convenience it bought was not real: `~/.local/bin` is NOT in
 * macOS's default PATH (`/etc/paths` lists only /usr/local/bin and the system
 * dirs), so two of three platforms needed a profile line anyway. Windows was
 * already writing here, so the old split was also internally inconsistent.
 *
 * Needs no privilege on any platform, and it is one directory to add to PATH
 * for every wolffish-managed binary rather than one per tool.
 */
export function shimDir(): string {
  return path.join(os.homedir(), '.wolffish', 'bin')
}

export function shimPath(): string {
  return path.join(shimDir(), process.platform === 'win32' ? 'wolffish.cmd' : 'wolffish')
}

/**
 * The pre-`~/.wolffish/bin` location. Swept on install so an upgraded machine
 * does not keep a stale shim that is EARLIER on PATH than the new one — it
 * would keep winning `command -v` and silently run the old target forever.
 * Only removed when it is recognisably ours.
 */
function legacyShimPath(): string | null {
  if (process.platform === 'win32') return null
  return path.join(os.homedir(), '.local', 'bin', 'wolffish')
}

async function removeLegacyShim(): Promise<void> {
  const legacy = legacyShimPath()
  if (!legacy || !existsSync(legacy)) return
  try {
    const body = await fs.readFile(legacy, 'utf8')
    // Never delete a file we did not write. The generated banner is the
    // signature; anything else at that path belongs to the user.
    if (!body.includes('Wolffish CLI launcher')) return
    await fs.rm(legacy, { force: true })
    wlog.info(TAG, `removed legacy shim ${legacy}`)
  } catch {
    // unreadable or already gone — nothing to clean
  }
}

/* ───────────────────────── the PATH entry ─────────────────────────
 *
 * Writing the shim is half the job: a folder no shell looks in is a command
 * nobody can run, and "add this line to your profile" is the step people
 * skip, mistype, or never see on a box they only reach over SSH. So the app
 * adds the entry itself, the way installers do — a marked block in the
 * shell profiles on macOS/Linux, the user PATH on Windows — idempotently, on
 * every boot, and removes exactly that on uninstall. The running terminal
 * cannot be changed from here; every NEW one has the command.
 *
 * Footprint: this is the one write outside ~/.wolffish the CLI makes, and it is
 * the one that cannot live anywhere else — PATH is read from the profile or
 * nowhere. The block carries a marker, so it is recognisably ours to remove,
 * and never touches a line the user wrote.
 */
const PROFILE_MARKER = '# Wolffish CLI — added by the app; remove with: wolffish path uninstall'
const PROFILE_LINE = 'export PATH="$HOME/.wolffish/bin:$PATH"'
const FISH_LINE = 'fish_add_path --global --prepend "$HOME/.wolffish/bin"'
/** Tests set this: no registry writes, no `powershell` — file writes still go to the (faked) home. */
const PATH_DRY_RUN = (): boolean => process.env.WOLFFISH_CLI_PATH_DRY_RUN === '1'

/** The POSIX profiles that exist, or the one for $SHELL when none does. */
function posixProfiles(): string[] {
  const home = os.homedir()
  const candidates = ['.zshrc', '.bashrc', '.bash_profile', '.profile'].map((f) =>
    path.join(home, f)
  )
  const existing = candidates.filter((f) => existsSync(f))
  if (existing.length > 0) return existing
  const shell = path.basename(process.env.SHELL ?? 'bash')
  return [path.join(home, shell === 'zsh' ? '.zshrc' : shell === 'bash' ? '.bashrc' : '.profile')]
}

/** fish keeps its PATH in conf.d, one file per tool — only when fish is set up here. */
function fishConfPath(): string | null {
  const dir = path.join(os.homedir(), '.config', 'fish')
  return existsSync(dir) ? path.join(dir, 'conf.d', 'wolffish.fish') : null
}

const BLOCK_RE = /\n?# Wolffish CLI[^\n]*\nexport PATH="\$HOME\/\.wolffish\/bin:\$PATH"\n?/g

async function windowsUserPath(): Promise<string[] | null> {
  if (PATH_DRY_RUN()) return null
  try {
    const { stdout } = await run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "[Environment]::GetEnvironmentVariable('Path', 'User')"
    ])
    return stdout
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return null
  }
}

async function setWindowsUserPath(entries: string[]): Promise<void> {
  if (PATH_DRY_RUN()) return
  const joined = entries.join(';').replace(/'/g, "''")
  await run('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `[Environment]::SetEnvironmentVariable('Path', '${joined}', 'User')`
  ])
}

/** Is the shim's folder already on PATH for new terminals? */
export async function profileHasEntry(dir = shimDir()): Promise<boolean> {
  if (process.platform === 'win32') {
    const entries = await windowsUserPath()
    return entries !== null && entries.some((entry) => samePath(entry, dir))
  }
  for (const file of posixProfiles()) {
    const body = await fs.readFile(file, 'utf8').catch(() => '')
    if (body.includes(PROFILE_MARKER)) return true
  }
  const fish = fishConfPath()
  return fish !== null && existsSync(fish)
}

/** Put the shim's folder on PATH for every new terminal. Idempotent. */
export async function ensurePathEntry(dir = shimDir()): Promise<void> {
  if (process.platform === 'win32') {
    const entries = await windowsUserPath()
    if (entries === null || entries.some((entry) => samePath(entry, dir))) return
    // First, so it wins over a package manager's link to the app binary.
    await setWindowsUserPath([dir, ...entries])
    wlog.info(TAG, 'added the shim folder to the user PATH')
    return
  }
  for (const file of posixProfiles()) {
    const body = await fs.readFile(file, 'utf8').catch(() => '')
    if (body.includes(PROFILE_MARKER)) continue
    const sep = body.length === 0 || body.endsWith('\n') ? '' : '\n'
    await fs.appendFile(file, `${sep}\n${PROFILE_MARKER}\n${PROFILE_LINE}\n`, 'utf8')
    wlog.info(TAG, `added the PATH entry to ${file}`)
  }
  const fish = fishConfPath()
  if (fish && !existsSync(fish)) {
    await fs.mkdir(path.dirname(fish), { recursive: true })
    await fs.writeFile(fish, `${PROFILE_MARKER}\n${FISH_LINE}\n`, 'utf8')
  }
}

/** Take exactly our block back out. A line the user wrote is never touched. */
export async function removePathEntry(dir = shimDir()): Promise<void> {
  if (process.platform === 'win32') {
    const entries = await windowsUserPath()
    if (entries === null || !entries.some((entry) => samePath(entry, dir))) return
    await setWindowsUserPath(entries.filter((entry) => !samePath(entry, dir)))
    return
  }
  for (const file of posixProfiles()) {
    const body = await fs.readFile(file, 'utf8').catch(() => null)
    if (body === null || !body.includes(PROFILE_MARKER)) continue
    await fs.writeFile(file, body.replace(BLOCK_RE, '\n').replace(/\n{3,}$/, '\n\n'), 'utf8')
  }
  const fish = fishConfPath()
  if (fish) await fs.rm(fish, { force: true }).catch(() => undefined)
}

/** `wolffish-cli-darwin-arm64`, `wolffish-cli-win32-x64.exe`, … for THIS process. */
export function cliBinaryName(platform = process.platform, arch = process.arch): string {
  return `wolffish-cli-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`
}

/** The directory holding the compiled client: resources/cli, via extraResources. */
export function cliBinaryDir(resourcesPath: string): string {
  return path.join(resourcesPath, 'cli')
}

/**
 * What the shim runs.
 *
 * Packaged: the compiled client for this platform and arch. In dev: the
 * client's SOURCE entry, `src/cli/index.ts`, which the shim runs under Bun —
 * Bun transpiles the TypeScript and the Solid JSX at launch, so every
 * `wolffish` typed while `npm run dev` is up runs the code as it is on disk,
 * with no build step and nothing to go stale. The compiled binary is the
 * production artifact only (`npm run cli:build`, and CI's beforePack).
 */
export function cliEntryPath(isDev: boolean, appPath: string, resourcesPath: string): string {
  return isDev
    ? path.join(appPath, 'src', 'cli', 'index.ts')
    : path.join(cliBinaryDir(resourcesPath), cliBinaryName())
}

/** True for a source entry (dev): the shim must run it under Bun. */
export function isSourceEntry(entry: string): boolean {
  return entry.endsWith('.ts')
}

/**
 * Bun, and the Solid JSX transform it has to preload, for a source entry.
 * Both live under the repo's node_modules (`bun` is a devDependency; the
 * transform ships with @opentui/solid under src/cli), so a fresh clone has
 * them after `npm install`.
 */
function devRuntime(entry: string): { bun: string; preload: string } {
  const cliDir = path.dirname(entry)
  const repo = path.resolve(cliDir, '..', '..')
  return {
    // The bun npm package names its binary bun.exe on every platform.
    bun: path.join(repo, 'node_modules', 'bun', 'bin', 'bun.exe'),
    preload: path.join(cliDir, 'node_modules', '@opentui', 'solid', 'scripts', 'preload.js')
  }
}

/** A NAME=VALUE as a shell command prefix, or nothing at all. */
function prefixed(env: string | null): string {
  return env ? `${env} ` : ''
}

function posixShim(execPath: string, entry: string): string {
  if (isSourceEntry(entry)) {
    const { bun, preload } = devRuntime(entry)
    return `#!/bin/sh
# Wolffish CLI launcher — generated by the app, safe to regenerate.
# DEV: runs the client from source under Bun, so it is always the code on
# disk. The installed app rewrites this file on its next boot.
export WOLFFISH_EXEC="${execPath}"
export WOLFFISH_DEV=1
exec "${bun}" --preload "${preload}" "${entry}" "$@"
`
  }
  // `entry` is the binary for the arch this process runs as, and the shim is
  // rewritten on every boot, so it is normally right. The fallback covers a
  // universal app whose other slice is somehow the one on disk.
  const dir = path.dirname(entry)
  return `#!/bin/sh
# Wolffish CLI launcher — generated by the app, safe to regenerate.
# Runs the compiled client and tells it where the app is, so a daemon that is
# not running can be started without a window ever opening.
export WOLFFISH_EXEC="${execPath}"
bin="${entry}"
if [ ! -x "$bin" ]; then
  dir="${dir}"
  arch="$(uname -m)"
  case "$arch" in x86_64|amd64) arch=x64;; arm64|aarch64) arch=arm64;; esac
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$os" in darwin) os=darwin;; *) os=linux;; esac
  bin="$dir/wolffish-cli-$os-$arch"
fi
${prefixed(appImageLaunchEnv())}exec "$bin" "$@"
`
}

/**
 * Git Bash resolves `wolffish` through MSYS's own lookup, which does not
 * consider `.cmd`, so Windows gets an extensionless `#!` shim beside the
 * `.cmd` one. See bashShimPath.
 */
function bashShimPath(): string | null {
  if (process.platform !== 'win32') return null
  return path.join(shimDir(), 'wolffish')
}

/** Windows path as MSYS wants it — backslashes are escapes in a shell string. */
function toPosixPath(target: string): string {
  return target.replace(/\\/g, '/')
}

function gitBashShim(execPath: string, entry: string): string {
  // mintty (Git Bash's default terminal) is a pty proxied over pipes, not a
  // Windows console; winpty bridges that for an interactive run. Gated on both
  // stdin and stdout being terminals so pipes and redirects keep their handles.
  const dev = isSourceEntry(entry) ? devRuntime(entry) : null
  const command = dev
    ? `'${toPosixPath(dev.bun)}' --preload '${toPosixPath(dev.preload)}' '${toPosixPath(entry)}'`
    : `'${toPosixPath(entry)}'`
  return `#!/bin/sh
# Wolffish CLI launcher — generated by the app, safe to regenerate.
# This is the Git Bash half of the Windows CLI; cmd.exe uses wolffish.cmd
# beside it. See src/main/autostart/cli-path.ts.
export WOLFFISH_EXEC='${toPosixPath(execPath)}'${dev ? '\nexport WOLFFISH_DEV=1' : ''}
if [ -t 0 ] && [ -t 1 ] && command -v winpty >/dev/null 2>&1; then
  exec winpty ${command} "$@"
fi
exec ${command} "$@"
`
}

function windowsShim(execPath: string, entry: string): string {
  // Plain ASCII on purpose: a .cmd is read by cmd.exe under whatever codepage
  // the console happens to be on, and a stray em dash would render as mojibake.
  const head =
    '@echo off\r\nrem Wolffish CLI launcher - generated by the app, safe to regenerate.\r\n'
  const dev = isSourceEntry(entry) ? devRuntime(entry) : null
  const command = dev
    ? `set "WOLFFISH_DEV=1"\r\n"${dev.bun}" --preload "${dev.preload}" "${entry}"`
    : `"${entry}"`
  return `${head}set "WOLFFISH_EXEC=${execPath}"\r\n${command} %*\r\nexit /b %ERRORLEVEL%\r\n`
}

/** cmd.exe's executable extensions, in the order it tries them. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * Windows' answer to `command -v`, walked by hand rather than shelled out to
 * `where`.
 *
 * `where.exe` searches the CURRENT DIRECTORY before it searches PATH. The app's
 * shortcut sets its working directory to the install root, and the packaged
 * binary living there is called `wolffish.exe` — so `where wolffish` answered
 * with the 200 MB GUI app, `isWolffishCli` refused to read something that size,
 * and every Windows machine was told a stranger had taken the name. The shim
 * was on PATH and working the entire time. POSIX never saw it because
 * `command -v` does not consult the cwd and the packaged binary there is named
 * `wolffish-app`.
 *
 * Walking PATH ourselves also lets the CALLER's PATH decide, which is the same
 * correction `onPath` makes and for the same reason: a terminal that launched
 * after the installer's PATH broadcast knows something this long-running
 * process's frozen environment block does not.
 */
function whichOnWindows(callerPath?: string | null): string | null {
  const dirs = (callerPath ?? process.env.PATH ?? '').split(';').filter(Boolean)
  const exts = (process.env.PATHEXT || DEFAULT_PATHEXT).split(';').filter(Boolean)
  for (const dir of dirs) {
    // One listing per directory, matched case-insensitively: cmd.exe does not
    // care about case, PATHEXT is conventionally uppercase, and the name on
    // disk is neither — so the match is by folded name and the REAL name is
    // what gets handed back (it is printed at the user). Folding here rather
    // than probing `existsSync` per extension also makes the walk behave the
    // same on a case-sensitive host filesystem, where the tests run it.
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    const onDisk = new Map(entries.map((entry) => [entry.toLowerCase(), entry]))
    for (const ext of exts) {
      const actual = onDisk.get(`wolffish${ext}`.toLowerCase())
      if (actual) return path.join(dir, actual)
    }
  }
  return null
}

/** What `wolffish` resolves to right now, if anything. */
async function whichWolffish(callerPath?: string | null): Promise<string | null> {
  try {
    if (process.platform === 'win32') return whichOnWindows(callerPath)
    const { stdout } = await run('sh', ['-lc', 'command -v wolffish'])
    const line = stdout.trim()
    return line.length > 0 ? line : null
  } catch {
    return null
  }
}

/**
 * Compare two paths the way the HOST does. Windows filesystems are
 * case-insensitive and its PATH separator is `;`; Linux is case-SENSITIVE, so
 * folding case there would call `/home/Ann/bin` a match for `/home/ann/bin`
 * and report a command as findable when the shell cannot find it. macOS is
 * usually case-insensitive but can be formatted either way — comparing
 * exactly is the safe direction, since a false "not installed" only offers a
 * reinstall that is already idempotent.
 */
function samePath(a: string, b: string): boolean {
  const left = path.resolve(a)
  const right = path.resolve(b)
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase()
  return left === right
}

/**
 * True when `dir` is on a PATH — the CALLER's when it sends one, this
 * process's otherwise.
 *
 * The distinction is the whole point. This runs in the daemon, and a daemon
 * started by systemd or launchd inherits a minimal PATH that has nothing to do
 * with the user's shell. Reading its own environment therefore reported "on
 * PATH: no" on every service-managed install — a confident wrong answer that
 * sent people to reinstall a shim that was already working — and reported
 * "yes" for a desktop launch that happened to inherit a login shell. The
 * terminal knows the answer for certain, because it IS the shell; it just had
 * no way to say so.
 */
function onPath(dir: string, callerPath?: string | null): boolean {
  const sep = process.platform === 'win32' ? ';' : ':'
  const entries = (callerPath ?? process.env.PATH ?? '').split(sep).filter(Boolean)
  return entries.some((entry) => samePath(entry, dir))
}

/**
 * The one line that fixes a missing PATH entry, for the shell the user is
 * actually in. `$HOME`-relative rather than expanded: this gets pasted into a
 * profile that may be synced between machines with different usernames.
 *
 * The same directory carries `gog`, `ffmpeg` and the voice engines, so adding
 * it once covers every wolffish-managed binary — and google.ts already writes
 * this exact export when it installs gogcli, which is why the hint matches its
 * wording instead of inventing a second convention.
 */
function profileHintFor(dir: string): string {
  const home = os.homedir()
  const portable = dir.startsWith(home) ? dir.replace(home, '$HOME') : dir
  if (process.platform === 'win32') {
    return `setx PATH "%PATH%;%USERPROFILE%\\.wolffish\\bin"`
  }
  const shell = path.basename(process.env.SHELL ?? 'bash')
  if (shell === 'fish') return `fish_add_path ${dir}`
  const rc = shell === 'zsh' ? '~/.zshrc' : '~/.bashrc'
  return `echo 'export PATH="${portable}:$PATH"' >> ${rc}`
}

/**
 * Is the file `wolffish` resolves to one of ours?
 *
 * Both launchers carry the same banner — the shim this module writes, and the
 * `/usr/bin/wolffish` the .deb and .rpm ship — so one read answers it. The size
 * guard is not a micro-optimization: `resolved` is whatever happens to own that
 * name on this machine, and reading an arbitrary binary in as a UTF-8 string
 * would mean a several-hundred-megabyte allocation on every status check.
 */
async function isWolffishCli(file: string): Promise<boolean> {
  try {
    const { size } = await fs.stat(file)
    if (size > 8192) return false
    return (await fs.readFile(file, 'utf8')).includes('Wolffish CLI launcher')
  } catch {
    return false
  }
}

export async function cliPathStatus(callerPath?: string | null): Promise<CliPathStatus> {
  const target = shimPath()
  const dir = shimDir()
  const present = existsSync(target)
  const resolved = await whichWolffish(callerPath)
  const dirOnPath = onPath(dir, callerPath)

  // Resolving to something that is NOT our shim is the confusing case: the
  // command "works" and does the wrong thing. On Linux that is usually the
  // package's own /usr/bin/wolffish-app symlink to the GUI binary, which will
  // open a window instead of a prompt.
  //
  // The exception is the package's `/usr/bin/wolffish`, which IS this client —
  // installed system-wide so the command works before the app has ever run.
  // Reporting that as a conflict, and telling the user to fix a PATH that needs
  // no fixing, is crying wolf about the thing working exactly as designed.
  const elsewhere = resolved !== null && !samePath(resolved, target)
  const packaged = elsewhere && (await isWolffishCli(resolved as string))
  const resolvedElsewhere = elsewhere && !packaged
  // Read from the profile itself, whatever this caller's PATH says: the two
  // answer different questions (this shell now vs. every new shell).
  const inProfile = dirOnPath || (await profileHasEntry(dir))

  return {
    installed: packaged || (present && dirOnPath && !resolvedElsewhere),
    present,
    target,
    resolved,
    needsPathEntry: !packaged && present && !dirOnPath,
    profileHasEntry: inProfile,
    // The manual line only when the app could not do it itself.
    profileHint: packaged || dirOnPath || inProfile ? null : profileHintFor(dir),
    shadowedBy: resolvedElsewhere ? resolved : null,
    error: null
  }
}

/**
 * Write (or rewrite) the shim. Idempotent — running it after an app update is
 * the intended way to re-point it at the new binary.
 */
export async function installCliPath(execPath: string, entry: string): Promise<CliPathStatus> {
  const target = shimPath()
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    // Both paths, not just the binary: under an AppImage the caller's execPath
    // and entry are inside a mount that dies with this process, and a shim is
    // read long after. No-ops for every other kind of install.
    const [exec, cli] = [stableExecPath(execPath), await stableCliEntry(entry)]
    const body = process.platform === 'win32' ? windowsShim(exec, cli) : posixShim(exec, cli)
    await fs.writeFile(target, body, 'utf8')
    if (process.platform !== 'win32') await fs.chmod(target, 0o755)

    // Windows gets a second, extensionless shim so Git Bash can find the
    // command at all. Written with LF and a `#!` line: MSYS decides a file is
    // executable by that magic, not by a mode bit NTFS does not really have.
    const bashShim = bashShimPath()
    if (bashShim) await fs.writeFile(bashShim, gitBashShim(exec, cli), 'utf8')

    await removeLegacyShim()
    // The folder on PATH for every new terminal — see "the PATH entry" above.
    // Best-effort: a profile that cannot be written leaves the manual hint up.
    await ensurePathEntry(path.dirname(target)).catch((err) =>
      wlog.warn(TAG, `PATH entry not written: ${err instanceof Error ? err.message : err}`)
    )
    wlog.info(TAG, `installed ${target}`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    wlog.warn(TAG, `install failed: ${detail}`)
    return { ...(await cliPathStatus()), error: detail }
  }
  return cliPathStatus()
}

export async function uninstallCliPath(): Promise<CliPathStatus> {
  await fs.rm(shimPath(), { force: true }).catch(() => undefined)
  await removePathEntry(shimDir()).catch(() => undefined)
  // Both, or Remove leaves the command still working in Git Bash and only
  // appears to have done nothing.
  const bashShim = bashShimPath()
  if (bashShim) await fs.rm(bashShim, { force: true }).catch(() => undefined)
  return cliPathStatus()
}
