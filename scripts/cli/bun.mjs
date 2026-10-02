/**
 * Locate the Bun binary, relinking it first when its install left a stub.
 *
 * The `bun` package ships `bin/bun.exe` as a few hundred bytes of placeholder
 * shell and swaps in the real binary from its `@oven/bun-<platform>` optional
 * dependency in a postinstall. npm 12 does not run dependency install scripts
 * unless they are approved (`allow-scripts`), and neither does pnpm or any
 * `--ignore-scripts` install, so what is left on disk is the placeholder —
 * which on Windows fails to spawn with a bare `UNKNOWN`, since it is not a PE
 * image.
 *
 * Re-running Bun's own installer is the repair: it copies the binary into
 * place and relinks node_modules/.bin, so a plain `bun` works from npm scripts
 * too. It is a no-op once linked, so this is cheap to call on every build.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const bunDir = path.join(repoRoot, 'node_modules', 'bun')
// The real binary, not npm's .bin shim (a .cmd on Windows that execFileSync
// cannot run without a shell). The bun package names it bun.exe everywhere.
export const bunBinary = path.join(bunDir, 'bin', 'bun.exe')

// The placeholder is well under a kilobyte; the linked binary is ~90 MB.
const isLinked = () => existsSync(bunBinary) && statSync(bunBinary).size > 1024 * 1024

/**
 * Path to a runnable bun, or null when the package is absent or unrepairable.
 *
 * Absence is left unreported: it is the expected state of an `--omit=dev`
 * install, and each caller says what it means for them. A broken install is
 * always worth a line, since nothing else explains the failure that follows.
 */
export function resolveBun() {
  if (!existsSync(bunBinary)) return null
  if (isLinked()) return bunBinary

  console.log('[cli] bun ships unlinked (its install script did not run) — linking it now')
  try {
    execFileSync(process.execPath, [path.join(bunDir, 'install.js')], {
      cwd: bunDir,
      stdio: 'inherit'
    })
  } catch (error) {
    console.log(`[cli] could not link the bun binary: ${error?.message ?? error}`)
    return null
  }
  if (!isLinked()) {
    console.log('[cli] the bun installer ran but left no binary behind')
    return null
  }
  return bunBinary
}
