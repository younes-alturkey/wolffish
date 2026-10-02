/**
 * electron-builder beforePack hook.
 *
 * Builds the terminal client for the platform being packed. Hooked here rather
 * than onto an npm script because CI calls `npx electron-builder --win` and
 * friends directly (see .github/workflows/release.yml) — anything hung off an
 * npm script would simply not run on a release build, and that failure is
 * invisible: the installer packs fine and `wolffish` is missing on the user's
 * machine.
 *
 * Runs once per arch pass; the build is idempotent and stages every slice the
 * platform needs (both macOS arches for the universal app).
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export default async function beforePack(context) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const platform = context.electronPlatformName
  execFileSync(
    process.execPath,
    [path.join(repo, 'scripts', 'cli', 'build.mjs'), '--platform', platform],
    {
      cwd: repo,
      stdio: 'inherit'
    }
  )
  console.log(`  • built terminal client for ${platform}`)
}
