import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * SudoSession holds the user's admin (sudo) password in main-process memory
 * for the lifetime of the app, so privileged commands prompt for it ONCE
 * rather than on every invocation.
 *
 * Why this exists: the shell/package-manager plugins used to delegate the
 * credential entirely to sudo's own timestamp cache (/var/db/sudo, ~5 min,
 * per-tty via tty_tickets). Every shell_exec is a fresh `/bin/sh -c` spawn
 * with no controlling tty, so once that timestamp went cold the SUDO_ASKPASS
 * helper re-fired the password dialog — a prompt for "every single one."
 * Plugins are dynamic-import()-ed into the main process and cached for the
 * app's lifetime, so a main-process singleton is the natural place to hold the
 * credential for exactly as long as the app runs.
 *
 * Mechanism: we capture the password once via a native dialog (macOS:
 * osascript; Linux: zenity → kdialog → ssh-askpass), validate it with
 * `sudo -A -v`, and cache it in this module's heap. Elevated commands get an
 * env fragment from getElevatedEnv() — a SUDO_ASKPASS helper plus the password
 * in WF_SUDO_PASSWORD. The helper is a secret-free echo
 * (`printf '%s' "$WF_SUDO_PASSWORD"`), so the password never touches disk. We
 * keep the `-A` askpass approach (rather than piping via `sudo -S`) because it
 * leaves the command's stdin free — chained sudos (`sudo a && sudo b`), piped
 * sudos (`echo x | sudo tee f`), and stdin-reading commands all keep working.
 *
 * Localization: the user-facing dialog text and macOS buttons follow the app
 * locale (set via setLocale; en/ar, English fallback). The error strings
 * returned to callers stay English on purpose — they're machine signals (motor
 * classifies "operation not permitted" as non-retryable), not user-facing copy.
 *
 * Security tradeoff (deliberate, per product decision): the password lives
 * in (a) this module's heap and (b) the environment of *elevated* child
 * processes (transient, same-user-only via `ps eww`). It is never written
 * to disk and never placed on the global process.env — only on the
 * per-command env of elevated spawns. JS strings are immutable, so clear()
 * drops the reference for GC rather than zeroing memory.
 *
 * Fallback contract: ensurePassword() returns { unsupported: true } when it
 * cannot even attempt capture on this host (Windows, Linux with no GUI
 * password tool, or an unexpected infra failure). Callers treat that as the
 * signal to fall back to their own legacy elevation path, so this session is
 * purely additive and never regresses prior behavior. A { cancelled } or
 * { error } result means it DID attempt — callers surface those rather than
 * re-prompting via the fallback.
 */

export type EnsurePasswordResult = {
  ok?: boolean
  cancelled?: boolean
  unsupported?: boolean
  error?: string
}

export interface SudoSession {
  /**
   * Ensure a valid admin password is cached. Shows the native password dialog
   * only when nothing usable is cached. `messageKey` selects which localized
   * prompt to show ('default' or 'installHomebrew'); unknown keys fall back to
   * the default. Returns:
   *  - { ok: true }                 — a validated password is cached
   *  - { cancelled: true, error }   — user dismissed the dialog
   *  - { error }                    — attempted but failed (wrong pw / not in sudoers)
   *  - { unsupported: true, error } — could not attempt; caller should fall
   *                                   back to its own legacy elevation path
   */
  ensurePassword(messageKey?: string): Promise<EnsurePasswordResult>
  /**
   * Env fragment to merge into an elevated child's env so its `sudo -A`
   * calls authenticate silently. Empty object when no password is cached
   * (safe to spread — a no-op).
   */
  getElevatedEnv(): Record<string, string>
  /** Forget the cached password (e.g. a future "Forget admin password" control). */
  clear(): void
  /** Remove the on-disk askpass helper. Best-effort; called on shutdown. */
  destroy(): Promise<void>
}

/** Control surface used by the main process (not exposed to plugins). */
export interface SudoSessionControl extends SudoSession {
  /** Set the dialog language. Unknown values fall back to English. */
  setLocale(locale: string): void
}

// ---------------------------------------------------------------------------
// Localization — only the user-facing DIALOG strings. Mirrors the app's
// supported locales (en, ar); anything else falls back to English. Kept as a
// small self-contained table because the main process has no access to the
// renderer's i18n bundle. Error strings below stay English by design.
// ---------------------------------------------------------------------------

type DialogStrings = {
  title: string
  prompt: string
  installHomebrew: string
  retry: string
  authorize: string
  cancel: string
}

// Arabic renders the brand as "وولفيش" — matches the app's existing ar.json
// convention (which never uses the Latin "Wolffish").
const STRINGS: Record<'en' | 'ar', DialogStrings> = {
  en: {
    title: 'Wolffish',
    prompt: 'Wolffish needs your administrator password to run a privileged command.',
    installHomebrew: 'Wolffish needs administrator access to install Homebrew on your Mac.',
    retry: 'Incorrect password. Please try again.',
    authorize: 'Authorize',
    cancel: 'Cancel'
  },
  ar: {
    title: 'وولفيش',
    prompt: 'يحتاج وولفيش إلى كلمة مرور المسؤول لتنفيذ أمر يتطلب صلاحيات إدارية.',
    installHomebrew: 'يحتاج وولفيش إلى صلاحيات المسؤول لتثبيت هوم برو على جهاز ماك.',
    retry: 'كلمة المرور غير صحيحة. يرجى المحاولة مرة أخرى.',
    authorize: 'تخويل',
    cancel: 'إلغاء'
  }
}

let currentLocale: 'en' | 'ar' = 'en'

function strings(): DialogStrings {
  return STRINGS[currentLocale] ?? STRINGS.en
}

/** Resolve a message key to the localized prompt (unknown key → default). */
function messageFor(key?: string): string {
  const s = strings()
  return key === 'installHomebrew' ? s.installHomebrew : s.prompt
}

// ---------------------------------------------------------------------------
// Error strings — returned to callers / the model, NOT shown in the dialog.
// Must stay English: motor.ts classifies "operation not permitted" as a
// non-retryable permission error, which is what stops the retry loop.
// ---------------------------------------------------------------------------

const CANCEL_COOLDOWN_MS = 30_000
const MAX_DIALOG_ATTEMPTS = 3

const CANCEL_ERROR =
  'operation not permitted (user cancelled the password dialog). ' +
  'Admin access is required to run this command. Try again when ready, ' +
  'or ask the user to run it in their terminal.'
const NOT_IN_SUDOERS_ERROR =
  'operation not permitted (this account is not in the sudoers file, so it cannot run sudo). ' +
  'Ask the user to run the command from an admin account or in their terminal.'
// The next two are only ever returned alongside { unsupported }, so callers
// fall back to their legacy path rather than surfacing them — but we still give
// a sensible message in case a caller chooses to show it.
const NO_GUI_ERROR =
  'operation not permitted (no GUI password tool found; tried zenity, kdialog, ssh-askpass).'
const UNSUPPORTED_PLATFORM_ERROR =
  'operation not permitted (in-memory sudo session is not supported on this platform).'

// ---------------------------------------------------------------------------
// Module-level state — the singleton's heap. Lives for the app's lifetime.
// ---------------------------------------------------------------------------

let cachedPassword: string | null = null
let helperDir: string | null = null
let helperPath: string | null = null
// De-dupe concurrent first-time elevations (e.g. the UI and Telegram both
// firing a sudo command at once) so the user sees a single dialog.
let inflight: Promise<EnsurePasswordResult> | null = null
// Set once when sudo reports the account isn't in sudoers — re-prompting is
// useless, so we fail fast forever after.
let sudoersBlocked = false
let cancelCooldownUntil = 0

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

type CollectResult = { code: number; stdout: string; stderr: string }

/** Spawn a command, collect stdout/stderr, never reject. */
function runCollect(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<CollectResult> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString()
    })
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString()
    })
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.on('error', (err) =>
      resolve({ code: -1, stdout, stderr: err instanceof Error ? err.message : String(err) })
    )
  })
}

/** True if `cmd` resolves on PATH. */
async function commandExists(cmd: string): Promise<boolean> {
  const r = await runCollect('which', [cmd], process.env)
  return r.code === 0 && r.stdout.trim().length > 0
}

/** Escape a string for safe interpolation into an AppleScript string literal. */
function escapeOsa(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

type DialogResult = { cancelled?: true; unsupported?: true; password?: string }

/**
 * Show the native password dialog and return the entered password.
 *  - macOS: osascript. Buttons follow the app locale; an explicit
 *    `cancel button` ensures the (possibly translated) Cancel still raises the
 *    user-cancelled error → non-zero exit.
 *  - Linux: the first available of zenity → kdialog → ssh-askpass (the same
 *    tools the legacy shell askpass used). Their OK/Cancel buttons are
 *    localized by the toolkit; we pass the localized prompt text. Cancel →
 *    non-zero exit. None installed → { unsupported } so the caller falls back.
 *  - Windows/other: { unsupported } (no sudo).
 * The tool prints the password to stdout with a trailing newline, which we
 * strip without trimming the password itself.
 */
async function runPasswordDialog(message: string): Promise<DialogResult> {
  if (process.platform === 'darwin') {
    const s = strings()
    const dialog =
      `display dialog "${escapeOsa(message)}" default answer "" with hidden answer ` +
      `with title "${escapeOsa(s.title)}" buttons {"${escapeOsa(s.cancel)}", "${escapeOsa(s.authorize)}"} ` +
      `default button "${escapeOsa(s.authorize)}" cancel button "${escapeOsa(s.cancel)}"`
    const r = await runCollect(
      'osascript',
      [
        '-e',
        'tell application "System Events" to activate',
        '-e',
        dialog,
        '-e',
        'text returned of result'
      ],
      process.env
    )
    if (r.code !== 0) return { cancelled: true }
    return { password: r.stdout.replace(/\r?\n$/, '') }
  }

  if (process.platform === 'linux') {
    const s = strings()
    const candidates: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }> = [
      { cmd: 'zenity', args: ['--password', `--title=${s.title}`, `--text=${message}`] },
      { cmd: 'kdialog', args: ['--password', message, '--title', s.title] },
      { cmd: 'ssh-askpass', args: [message], env: { ...process.env, SSH_ASKPASS_REQUIRE: 'force' } }
    ]
    for (const c of candidates) {
      if (!(await commandExists(c.cmd))) continue
      const r = await runCollect(c.cmd, c.args, c.env ?? process.env)
      if (r.code !== 0) return { cancelled: true }
      return { password: r.stdout.replace(/\r?\n$/, '') }
    }
    return { unsupported: true } // no GUI password tool installed
  }

  return { unsupported: true } // Windows / other — no sudo
}

/** Write the secret-free askpass helper once per session. */
async function ensureHelper(): Promise<string> {
  if (helperPath) return helperPath
  helperDir = await mkdtemp(path.join(tmpdir(), 'wolffish-sudo-'))
  const p = path.join(helperDir, 'askpass.sh')
  // Contains NO secret — it just echoes the password the parent passes in
  // WF_SUDO_PASSWORD. POSIX `#!/bin/sh` + `printf '%s'` works on macOS and any
  // Linux, and preserves the value exactly (no shell re-parsing), so passwords
  // with quotes, $, spaces, etc. pass through untouched.
  await writeFile(p, '#!/bin/sh\nprintf \'%s\' "$WF_SUDO_PASSWORD"\n', 'utf8')
  await chmod(p, 0o700)
  helperPath = p
  return p
}

type ValidateResult = { ok?: true; wrongPassword?: true; notInSudoers?: true; error?: string }

/**
 * Validate a candidate password via `sudo -A -v` using the askpass helper.
 * `force` runs `sudo -k` first to invalidate any warm timestamp, so we test
 * the password itself rather than a lingering cache — used right after the
 * user types a password. The cached re-check passes force=false so a still-warm
 * timestamp short-circuits (no askpass call at all).
 */
async function validate(password: string, force: boolean): Promise<ValidateResult> {
  const helper = await ensureHelper()
  if (force) await runCollect('sudo', ['-k'], process.env)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SUDO_ASKPASS: helper,
    WF_SUDO_PASSWORD: password
  }
  const r = await runCollect('sudo', ['-A', '-v'], env)
  if (r.code === 0) return { ok: true }
  const err = (r.stderr || '').toLowerCase()
  if (/not in the sudoers file|not allowed to run sudo/.test(err)) return { notInSudoers: true }
  if (/incorrect password|sorry, try again/.test(err)) return { wrongPassword: true }
  return { error: (r.stderr || '').trim() || `sudo authentication failed (exit ${r.code})` }
}

/** Prompt (bounded), validate, and cache on success. */
async function acquire(message: string): Promise<EnsurePasswordResult> {
  for (let attempt = 1; attempt <= MAX_DIALOG_ATTEMPTS; attempt++) {
    const dlg = await runPasswordDialog(attempt === 1 ? message : strings().retry)
    if (dlg.unsupported) return { unsupported: true, error: NO_GUI_ERROR }
    if (dlg.cancelled) {
      cancelCooldownUntil = Date.now() + CANCEL_COOLDOWN_MS
      return { cancelled: true, error: CANCEL_ERROR }
    }
    const candidate = dlg.password ?? ''
    const v = await validate(candidate, true)
    if (v.ok) {
      cachedPassword = candidate
      return { ok: true }
    }
    if (v.notInSudoers) {
      sudoersBlocked = true
      return { error: NOT_IN_SUDOERS_ERROR }
    }
    if (v.wrongPassword) continue
    return { error: `operation not permitted (${v.error ?? 'sudo authentication failed'})` }
  }
  return { error: 'operation not permitted (too many incorrect password attempts).' }
}

async function ensureInternal(message: string): Promise<EnsurePasswordResult> {
  // Only macOS and Linux have sudo + a GUI capture path. Everything else
  // (Windows) reports unsupported so the caller uses its legacy guidance.
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return { unsupported: true, error: UNSUPPORTED_PLATFORM_ERROR }
  }
  if (sudoersBlocked) return { error: NOT_IN_SUDOERS_ERROR }

  // Cached fast path: re-validate silently (no dialog). A warm timestamp makes
  // this a no-op; a cold one re-feeds the cached password via the helper and
  // re-primes. Only a *wrong* password (the user changed it mid-session) drops
  // the cache and re-prompts — a cold timestamp must never trigger a dialog,
  // which is the whole point of this change.
  if (cachedPassword != null) {
    const v = await validate(cachedPassword, false)
    if (v.ok) return { ok: true }
    if (v.notInSudoers) {
      sudoersBlocked = true
      return { error: NOT_IN_SUDOERS_ERROR }
    }
    if (v.wrongPassword) {
      cachedPassword = null // stale — fall through to re-acquire
    } else {
      // Transient/unknown failure — trust the cache and let the real command
      // surface the actual error rather than nagging for a password.
      return { ok: true }
    }
  }

  if (Date.now() < cancelCooldownUntil) return { cancelled: true, error: CANCEL_ERROR }
  return acquire(message)
}

export const sudoSession: SudoSessionControl = {
  setLocale(locale: string) {
    currentLocale = locale === 'ar' ? 'ar' : 'en'
  },

  ensurePassword(messageKey?: string) {
    if (inflight) return inflight
    const p = (async () => {
      try {
        return await ensureInternal(messageFor(messageKey))
      } catch (err) {
        // Defensive: ensureInternal should resolve, not throw (runCollect never
        // rejects). But helper creation (mkdtemp/writeFile) could fail on a
        // broken temp dir. Mark it { unsupported } so the caller falls back to
        // its legacy elevation path rather than failing the command outright.
        const detail = err instanceof Error ? err.message : String(err)
        return { unsupported: true, error: `could not prepare sudo session: ${detail}` }
      } finally {
        inflight = null
      }
    })()
    inflight = p
    return p
  },

  getElevatedEnv(): Record<string, string> {
    if (cachedPassword != null && helperPath) {
      return { SUDO_ASKPASS: helperPath, WF_SUDO_PASSWORD: cachedPassword }
    }
    return {}
  },

  clear() {
    cachedPassword = null
    sudoersBlocked = false
    cancelCooldownUntil = 0
  },

  async destroy() {
    cachedPassword = null
    const dir = helperDir
    helperDir = null
    helperPath = null
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
