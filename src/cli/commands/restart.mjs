/**
 * `wolffish restart` — the Settings rail's Restart Wolffish, without the window.
 *
 * The daemon answers before it goes down, so the terminal sees "restarting"
 * rather than a dropped socket, and then this waits for a daemon with a NEW
 * pid to answer — the old one answering a moment longer is not "back".
 */
import { c, confirm, err, icon, interactive, out, spinner } from '../lib/ui.mjs'
import { connect } from '../lib/client.mjs'

const RETURN_TIMEOUT_MS = 60_000
const RETURN_POLL_MS = 500

export async function restart(client, flags = {}) {
  if (!flags.yes) {
    if (!interactive()) {
      err(c.red('refusing to restart without a terminal to confirm on — pass --yes'))
      return 2
    }
    const ok = await confirm('Restart Wolffish? Anything running right now is stopped.')
    if (!ok) {
      out(c.gray('  not restarting'))
      return 1
    }
  }

  const before = client.hello?.pid ?? null
  const result = await client.invoke('app:restart').catch((error) => {
    err(c.red(error?.message ?? String(error)))
    return null
  })
  if (!result) return 1
  if (!result.scheduled) {
    out(c.yellow('  a restart, reboot or update is already in progress'))
    return 1
  }
  out(`${icon.ok()} restarting${before ? c.gray(` (pid ${before})`) : ''}`)
  client.close()

  if (flags.json) return 0

  const spin = spinner('waiting for Wolffish to come back')
  const deadline = Date.now() + RETURN_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RETURN_POLL_MS))
    const fresh = await connect({ autostart: false, quiet: true }).catch(() => null)
    if (!fresh) continue
    const pid = fresh.hello?.pid ?? null
    fresh.close()
    if (pid !== null && pid === before) continue
    spin.stop()
    out(`${icon.ok()} back${pid ? c.gray(` (pid ${pid})`) : ''}`)
    return 0
  }
  spin.stop()
  err(c.yellow('  it has not come back yet — check: wolffish status · wolffish service logs'))
  return 1
}
