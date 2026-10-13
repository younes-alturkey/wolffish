/**
 * `wolffish reboot` — the Settings rail's Reboot device: the whole machine,
 * not just Wolffish (that is `wolffish restart`).
 *
 * The daemon checks it may reboot before it stops anything, so a refusal is
 * printed here rather than discovered as a stopped app. Nothing waits for the
 * return: the machine going down takes this terminal's session with it.
 */
import { c, confirm, err, icon, interactive, out } from '../lib/ui.mjs'

const REFUSALS = {
  permission:
    'Wolffish is not allowed to reboot this machine — run it as root or allow passwordless sudo (Linux), or let it control System Events (macOS)',
  unsupported: 'rebooting is not supported on this system',
  busy: 'a restart, reboot or update is already in progress'
}

export async function reboot(client, flags = {}) {
  if (!flags.yes) {
    if (!interactive()) {
      err(c.red('refusing to reboot without a terminal to confirm on — pass --yes'))
      return 2
    }
    const ok = await confirm(
      'Reboot this device? Wolffish saves what is in flight, then the whole machine restarts.'
    )
    if (!ok) {
      out(c.gray('  not rebooting'))
      return 1
    }
  }

  const result = await client.invoke('app:rebootDevice').catch((error) => {
    err(c.red(error?.message ?? String(error)))
    return null
  })
  if (!result) return 1
  if (!result.scheduled) {
    err(c.yellow(`  ${REFUSALS[result.error] ?? 'could not reboot'}`))
    return 1
  }
  out(`${icon.ok()} rebooting the device`)
  client.close()
  return 0
}
