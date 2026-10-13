/**
 * The comeback after a device reboot the OS accepted and then cancelled
 * (armRebootWatchdog, armed in index.ts:rebootDeviceApp). Without it a drained
 * Wolffish sat behind the "Rebooting device" overlay forever, every restart
 * answering "busy".
 *
 * Covered here:
 *  - recover fires once, after the grace period
 *  - disarm (will-quit: the OS really is taking the app down) stops it, and
 *    disarming after it fired is harmless
 *  - the timer is unref'd, so it never holds a process up on its own
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/__tests__/device-reboot-watchdog.test.ts
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { armRebootWatchdog, REBOOT_WATCHDOG_MS } from '../device-reboot'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function main(): Promise<void> {
  assert.ok(REBOOT_WATCHDOG_MS >= 60_000, 'grace period shorter than a real shutdown takes')

  let fired = 0
  const armed = armRebootWatchdog(() => fired++, 20)
  assert.equal(fired, 0, 'fired before the grace period')
  await wait(80)
  assert.equal(fired, 1, 'did not fire exactly once')
  armed.disarm()
  await wait(40)
  assert.equal(fired, 1, 'disarm after firing changed anything')
  console.log('ok: fires once after the grace period')

  let firedDisarmed = 0
  const disarmed = armRebootWatchdog(() => firedDisarmed++, 20)
  disarmed.disarm()
  await wait(80)
  assert.equal(firedDisarmed, 0, 'fired after disarm')
  console.log('ok: disarm stops it')

  // A child that only arms a long watchdog must exit at once: nothing else
  // holds its event loop, so a ref'd timer would keep it alive for 5 s.
  const { spawnSync } = await import('node:child_process')
  const modulePath = path.join(__dirname, '..', 'device-reboot.ts')
  const started = Date.now()
  const child = spawnSync(
    process.execPath,
    // Node strips the module's types itself (22.18+); no loader needed.
    [
      '-e',
      `import(${JSON.stringify(pathToFileURL(modulePath).href)}).then((m) => { m.armRebootWatchdog(() => console.log('fired'), 5000); console.log('armed') })`
    ],
    { encoding: 'utf8', timeout: 10_000 }
  )
  assert.equal(child.status, 0, `child failed: ${child.stderr}`)
  assert.equal(child.stdout.trim(), 'armed', 'the watchdog fired or the child never armed it')
  assert.ok(Date.now() - started < 4_500, 'the armed watchdog held the process up')
  console.log('ok: timer is unref’d')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
