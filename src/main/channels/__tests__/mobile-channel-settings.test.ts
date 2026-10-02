/**
 * The two Mobile-channel settings that are edited from BOTH devices — the
 * notify_phone gate and the phone's feed verbosity.
 *
 * They are the panel's only stateful switches, and they are now also rows on
 * the phone's own Channels screen, which makes two things load-bearing that
 * were not before. First, they have to survive a restart: a switch that
 * silently reverted to its default on launch would have the phone and the
 * panel disagreeing about a setting neither of them touched — and `verbose`
 * did exactly that, held in memory and never written. Second, the snapshot
 * the phone renders has to CARRY them, with the desktop's own defaults for a
 * config that predates the section (notifications on, feed clean); a phone
 * that guessed the other way would show the agent as unable to reach it while
 * the agent kept notifying.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/mobile-channel-settings.test.ts
 */
import Module from 'node:module'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// workspaceRoot() reads os.homedir() at module import — override first.
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-mobile-settings-'))
process.env.HOME = SANDBOX

// Shim `electron` so the channel's import graph loads outside an Electron process.
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => os.tmpdir(),
        getVersion: () => '0.0.0-test'
      },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (s: string) => Buffer.from(s),
        decryptString: (b: Buffer) => b.toString()
      }
    }
  }
  return origLoad.apply(this, args)
}

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

async function run(): Promise<void> {
  const { MobileChannel } = await import('@main/channels/mobile/channel')
  const { buildConfigSnapshot } = await import('@main/channels/mobile/snapshot')
  const { getMobileChannelConfig, setMobileChannelConfig } =
    await import('@main/workspace/workspace')

  // ------------------------------------------------ persistence, both switches

  // The deps index.ts wires, verbatim in shape: config is the store, and the
  // channel is the only thing that reads or writes it.
  const channelDeps = {
    agent: {
      cerebellum: {
        registerInProcessCapability: () => undefined,
        unregisterInProcessCapability: () => undefined
      }
    },
    runner: { send: () => ({ turnId: 't', controller: new AbortController() }) },
    serializeCapabilities: async () => [],
    loadNotificationsEnabled: async () => (await getMobileChannelConfig()).notifications !== false,
    saveNotificationsEnabled: async (enabled: boolean) => {
      await setMobileChannelConfig({ notifications: enabled })
    },
    loadVerbose: async () => (await getMobileChannelConfig()).verbose === true,
    saveVerbose: async (verbose: boolean) => {
      await setMobileChannelConfig({ verbose })
    }
  }

  {
    const channel = new MobileChannel(channelDeps as never)
    await channel.start()
    const fresh = channel.getStatus()
    ok('a fresh workspace notifies by default', fresh.notificationsEnabled === true)
    ok('a fresh workspace keeps the feed clean', fresh.verbose === false)

    const afterVerbose = await channel.setVerbose(true)
    ok('setVerbose answers the updated status', afterVerbose.verbose === true)
    const afterNotifications = await channel.setNotificationsEnabled(false)
    ok(
      'setNotificationsEnabled answers the updated status',
      afterNotifications.notificationsEnabled === false
    )

    // Written where the panel, the snapshot and the next launch all read it —
    // not held in the instance that happened to make the change.
    const stored = await getMobileChannelConfig()
    ok('verbose reached config.json', stored.verbose === true)
    ok('notifications reached config.json', stored.notifications === false)
  }

  {
    // The restart. A second channel over the same workspace must come up on
    // the values the first one was left on.
    const restarted = new MobileChannel(channelDeps as never)
    await restarted.start()
    const status = restarted.getStatus()
    ok('verbose survives a restart', status.verbose === true)
    ok('notifications survives a restart', status.notificationsEnabled === false)

    // And one setter must never carry the other back to its default — they
    // share a config section, which is exactly where that goes wrong.
    await restarted.setVerbose(false)
    const both = await getMobileChannelConfig()
    ok('writing verbose leaves notifications alone', both.notifications === false)
    ok('verbose is back off', both.verbose === false)
  }

  // -------------------------------------------------- what the phone receives

  {
    const snapshot = (await buildConfigSnapshot({
      agent: {},
      serializeCapabilities: async () => []
    } as never)) as {
      channels: {
        mobile?: { notifications?: boolean; verbose?: boolean }
        inapp?: { verbose?: boolean }
      }
    }
    ok(
      'the snapshot carries the phone channel',
      snapshot.channels.mobile !== undefined,
      JSON.stringify(snapshot.channels.mobile)
    )
    // Left at notifications:false / verbose:false by the block above.
    ok('snapshot mirrors the stored gate', snapshot.channels.mobile?.notifications === false)
    ok('snapshot mirrors the stored feed setting', snapshot.channels.mobile?.verbose === false)
  }

  {
    // The pre-section config: neither key present. The phone renders these
    // directly, so the fallbacks have to be the desktop's own, not `false`
    // twice because that is what an absent boolean coerces to.
    const { patchConfig } = await import('@main/workspace/workspace')
    await patchConfig((c) => ({ ...c, mobile: undefined }))
    const snapshot = (await buildConfigSnapshot({
      agent: {},
      serializeCapabilities: async () => []
    } as never)) as {
      channels: {
        mobile?: { notifications?: boolean; verbose?: boolean }
        inapp?: { verbose?: boolean }
      }
    }
    ok('absent section still notifies', snapshot.channels.mobile?.notifications === true)
    ok('absent section still means a clean feed', snapshot.channels.mobile?.verbose === false)
  }

  // ------------------------------------------------------ the terminal channel

  /**
   * The CLI card on the phone. `verbose` is an ordinary config mirror like the
   * two above; the other three are PROBES of this machine (a PATH walk, an
   * autostart query) and they are the interesting case, because both are
   * allowed to fail.
   *
   * The rule being pinned is that a failed probe OMITS its field. The phone
   * turns an absent field into `null` and prints "Unknown"; if the builder
   * emitted `false` instead, a laptop whose launchctl query timed out would
   * tell its owner the `wolffish` command is not installed — a confident lie
   * about a machine they cannot see to check. Nothing here shells out: every
   * probe is a stub, exactly as the sandbox rule requires.
   */
  {
    type CliSection = {
      verbose?: boolean
      runMode?: string
      pathInstalled?: boolean
      serviceActive?: boolean
      mechanism?: string
    }
    const read = async (sources: Record<string, unknown>): Promise<CliSection> =>
      (
        (await buildConfigSnapshot({
          agent: {},
          serializeCapabilities: async () => [],
          ...sources
        } as never)) as { channels: { cli?: CliSection } }
      ).channels.cli ?? {}

    const answered = await read({
      cliPathInstalled: async () => true,
      launchAtStartupActive: async () => true,
      cliMechanism: async () => 'launchd'
    })
    ok('the snapshot carries the terminal channel', answered.runMode === 'gui')
    ok('a fresh workspace keeps the terminal feed clean', answered.verbose === false)
    ok('the PATH probe reaches the phone', answered.pathInstalled === true)
    ok('the autostart probe reaches the phone', answered.serviceActive === true)
    ok('the mechanism is named, not generic', answered.mechanism === 'launchd')

    const refused = await read({
      cliPathInstalled: async () => {
        throw new Error('command -v failed')
      },
      launchAtStartupActive: async () => {
        throw new Error('launchctl failed')
      },
      cliMechanism: async () => {
        throw new Error('no mechanism')
      }
    })
    ok('a failed PATH probe omits the field', !('pathInstalled' in refused))
    ok('a failed autostart probe omits the field', !('serviceActive' in refused))
    ok('a failed mechanism probe omits the field', !('mechanism' in refused))
    // The two that never depend on a probe still have to arrive, or the card
    // loses its only editable row along with the failure.
    ok('the feed setting survives a failed probe', refused.verbose === false)
    ok('the run mode survives a failed probe', refused.runMode === 'gui')

    // A desktop registered as a background service says so, and the phone's
    // "Start it as" row is the only place that fact is visible from here.
    const { setCliConfig } = await import('@main/workspace/workspace')
    await setCliConfig({ runMode: 'headless', verbose: true })
    const headless = await read({ cliMechanism: async () => 'systemd' })
    ok('the run mode mirrors config.json', headless.runMode === 'headless')
    ok('the terminal feed setting mirrors config.json', headless.verbose === true)
    ok('an unsupplied probe is simply absent', !('pathInstalled' in headless))
  }

  // ------------------------------------------------ the allow-list round trip

  /**
   * The Telegram/WhatsApp allow-lists travel to the phone as one comma-joined
   * line and come back through configSet as the same line. Snapshot join and
   * apply-side parse live in one file (snapshot.ts) precisely so this holds;
   * what the test pins is the round trip itself — stored list → snapshot
   * string → parsed list, byte for byte — plus the parsers' leniency, because
   * the string arrives straight off a phone keyboard.
   */
  {
    const { parseAllowedNumbers, parseAllowedUserIds, THINKING_MODES } =
      await import('@main/channels/mobile/snapshot')
    const { setTelegramConfig, setWhatsAppConfig } = await import('@main/workspace/workspace')

    ok(
      'user IDs parse back to numbers',
      JSON.stringify(parseAllowedUserIds('429753549, 1001')) === '[429753549,1001]'
    )
    ok(
      'a junk entry costs itself, not the list',
      JSON.stringify(parseAllowedUserIds(' 12a, , 7 ')) === '[7]'
    )
    ok(
      'phone numbers keep their plus and inner spacing',
      JSON.stringify(parseAllowedNumbers('+966501234567, +1 202 5550')) ===
        '["+966501234567","+1 202 5550"]'
    )

    await setTelegramConfig({ allowedUserIds: [429753549, 1001] })
    await setWhatsAppConfig({ allowedPhoneNumbers: ['+966501234567'] })
    const snapshot = (await buildConfigSnapshot({
      agent: {},
      serializeCapabilities: async () => []
    } as never)) as {
      channels: { telegram: { allowedUserIds: string }; whatsapp: { allowedNumbers: string } }
    }
    ok(
      'the joined Telegram line parses back to the stored list',
      JSON.stringify(parseAllowedUserIds(snapshot.channels.telegram.allowedUserIds)) ===
        '[429753549,1001]'
    )
    ok(
      'the joined WhatsApp line parses back to the stored list',
      JSON.stringify(parseAllowedNumbers(snapshot.channels.whatsapp.allowedNumbers)) ===
        '["+966501234567"]'
    )
    ok(
      'thinking modes are the four the phone renders',
      [...THINKING_MODES].join(',') === 'off,on,high,max'
    )
  }

  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void run()
