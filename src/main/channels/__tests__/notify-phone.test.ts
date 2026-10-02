/**
 * The notify_phone pipeline, model side down: what the TOOL refuses or
 * repairs before anything is built (untrusted model input), what the CHANNEL
 * stamps that the model must never control (phoneId, a fresh ULID, ttl from
 * phase), and how the relay's notify_result answers the tool call.
 *
 * These pins are the security posture of the feature: the model chooses
 * words; the harness chooses identity, routing and rate. If one of these
 * assertions has to change, the design constraint changed with it.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/notify-phone.test.ts
 */
import Module from 'node:module'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// workspaceRoot() reads os.homedir() at module import — override first.
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-notify-phone-'))
process.env.HOME = SANDBOX

// Shim `electron` so the channel's import graph loads outside an Electron process.
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() },
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

const ULID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/

async function run(): Promise<void> {
  const { buildMobileCapability, mintNotificationId, TTL_BY_PHASE } =
    await import('@main/channels/mobile/tools')
  const { MobileChannel } = await import('@main/channels/mobile/channel')
  const { turnScope } = await import('@main/runtime/corpus')
  type NotifyResultFrame = import('@main/tunnel/protocol').NotifyResultFrame
  type NotifyPhoneRequest = import('@main/channels/mobile/tools').NotifyPhoneRequest

  // ---------------------------------------------------------------- tool layer

  {
    const sent: NotifyPhoneRequest[] = []
    let nextRoute: NotifyResultFrame['route'] = 'inband'
    const { capability, plugin } = buildMobileCapability({
      notify: async (request) => {
        sent.push(request)
        return {
          v: 1,
          type: 'notify_result',
          notificationId: mintNotificationId(),
          route: nextRoute,
          ...(nextRoute === 'dropped' ? { reason: 'phone is offline' } : {})
        }
      }
    })
    ok('capability is the in-process phone channel', capability.name === 'phone')
    ok(
      'the single tool is notify_phone',
      plugin.tools.length === 1 && plugin.tools[0].name === 'notify_phone'
    )

    // Missing/empty title and body are refused before anything is sent.
    const noTitle = await plugin.execute('notify_phone', { body: 'b' })
    ok('missing title refused', !noTitle.success && sent.length === 0)
    const noBody = await plugin.execute('notify_phone', { title: 't' })
    ok('missing body refused', !noBody.success && sent.length === 0)

    // A deeplink outside the app scheme is refused, not repaired.
    const badLink = await plugin.execute('notify_phone', {
      title: 't',
      body: 'b',
      deeplink: 'https://evil.example/x'
    })
    ok(
      'foreign-scheme deeplink refused',
      !badLink.success && (badLink.error ?? '').includes('wolffish://') && sent.length === 0
    )

    // A link inside the scheme but naming a screen the app does not have is
    // refused too — it would otherwise reach the phone and dump the user on
    // the home screen, which is indistinguishable from a broken notification.
    // The refusal has to teach: it lists what does exist.
    const noSuchPage = await plugin.execute('notify_phone', {
      title: 't',
      body: 'b',
      deeplink: 'wolffish://runs/1'
    })
    ok(
      'unknown screen refused with the list of real ones',
      !noSuchPage.success &&
        (noSuchPage.error ?? '').includes('wolffish://settings/automations') &&
        sent.length === 0
    )

    // Model text is sanitized: newlines/controls stripped from the title, the
    // title clamped to its one-line ceiling, the body left whole because the
    // phone renders it in full, enums fall back to defaults.
    // The deeplink is normalized to one canonical shape on the way out —
    // extra slashes and unknown query parameters do not travel.
    const messy = await plugin.execute('notify_phone', {
      title: '  line one\nline two\x07  ' + 'x'.repeat(80),
      body: 'keep\nthe\nnewlines ' + 'y'.repeat(300),
      phase: 'not-a-phase',
      urgency: 'shout',
      deeplink: 'wolffish:///settings/usage/?from=notify'
    })
    ok('sanitized send succeeds', messy.success === true && sent.length === 1)
    const frame = sent[0]
    ok('title is one line', !frame.title.includes('\n') && !frame.title.includes('\x07'))
    ok('title clamped to 60', frame.title.length <= 60)
    ok('body keeps newlines', frame.body.includes('\n'))
    ok('body is not clamped', frame.body.length > 180)
    ok('unknown phase defaults to info', frame.phase === 'info')
    ok('unknown urgency defaults to normal', frame.urgency === 'normal')
    ok('sloppy deeplink normalized', frame.deeplink === 'wolffish://settings/usage')
    ok('runId stamped from harness scope, not the model', frame.runId === 'untracked')

    // NOTHING here rate-limits, counts, or deduplicates. Whether a moment is
    // worth interrupting the user for is the model's judgement, and the harness
    // does not overrule it: it carries the message and reports honestly what
    // happened to it. Every assertion below used to be a refusal.
    await turnScope.run({ turnId: 'turn_open_1', conversationId: null, autonomous: false }, () =>
      (async () => {
        nextRoute = 'inband'
        const before = sent.length
        // The same phase, the same words, over and over. Once refused by a
        // per-phase cap, then by a 5-per-run cap, then by a fingerprint.
        for (let i = 1; i <= 8; i += 1) {
          const one = await plugin.execute('notify_phone', {
            title: 't',
            body: 'b',
            phase: 'completed'
          })
          ok(`identical call ${i} of 8 is delivered, not refused`, one.success === true, one.error)
        }
        ok(
          'eight calls in one run put eight frames on the wire',
          sent.length === before + 8,
          `${sent.length - before} frames`
        )
      })()
    )

    // A delivery the relay never confirmed is reported as UNKNOWN rather than
    // failed — the model needs that difference to judge what to do next — and
    // it takes nothing away from the run: the next call still goes.
    await turnScope.run({ turnId: 'turn_open_2', conversationId: null, autonomous: false }, () =>
      (async () => {
        nextRoute = 'dropped'
        const before = sent.length
        const dropped = await plugin.execute('notify_phone', {
          title: 't',
          body: 'b',
          phase: 'completed'
        })
        ok(
          'an unconfirmed delivery says so, and names the reason',
          !dropped.success &&
            (dropped.error ?? '').includes('UNCONFIRMED') &&
            (dropped.error ?? '').includes('phone is offline')
        )
        ok(
          'the model is told it may already be on the phone, and left to judge',
          !dropped.success && (dropped.error ?? '').includes('Your call')
        )
        // The one rule that IS enforced, and it binds the HARNESS, not the
        // model: motor may not re-fire a send the model made once. Every
        // failure this tool returns carries the flag that stops it.
        ok(
          'the failure is flagged non-retryable so motor cannot re-fire it',
          (dropped as { retryable?: boolean }).retryable === false
        )
        nextRoute = 'push'
        const next = await plugin.execute('notify_phone', {
          title: 't',
          body: 'b',
          phase: 'completed'
        })
        ok('an unconfirmed attempt costs the run nothing', next.success === true)
        ok('push route is reported to the model', (next.output ?? '').includes('push notification'))
        ok('both reached the wire', sent.length === before + 2, `${sent.length - before} frames`)
      })()
    )

    // The refusals that remain are arguments that cannot be delivered as
    // written. Not policy — a malformed call, answered with an error that
    // teaches, so the model can fix it and call again.
    await turnScope.run({ turnId: 'turn_open_3', conversationId: null, autonomous: false }, () =>
      (async () => {
        const before = sent.length
        const bad = await plugin.execute('notify_phone', {
          title: 't',
          body: 'b',
          deeplink: 'wolffish://nowhere'
        })
        ok(
          'an undeliverable deeplink is still refused, with the real list',
          !bad.success && (bad.error ?? '').includes('wolffish://history')
        )
        ok('and nothing was sent', sent.length === before)
      })()
    )
  }

  // -------------------------------------------- deeplinks are model-led only

  {
    const sent: NotifyPhoneRequest[] = []
    const { plugin } = buildMobileCapability({
      notify: async (request) => {
        sent.push(request)
        return {
          v: 1,
          type: 'notify_result',
          notificationId: mintNotificationId(),
          route: 'push'
        }
      }
    })

    // 100% model-led: even inside a turn with a conversation, an omitted
    // deeplink stays null — a tap just opens the app. The harness never
    // invents a destination the model didn't name.
    await turnScope.run(
      { turnId: 'turn_dl_1', conversationId: 'conv-2026-08-05_10-00-00', autonomous: false },
      () => plugin.execute('notify_phone', { title: 't', body: 'b', phase: 'completed' })
    )
    ok('omitted deeplink stays null — no auto destination', sent[0]?.deeplink === null)

    // A deeplink the model names explicitly passes through untouched.
    await turnScope.run(
      { turnId: 'turn_dl_2', conversationId: 'conv-2026-08-05_10-00-00', autonomous: false },
      () =>
        plugin.execute('notify_phone', {
          title: 't',
          body: 'b',
          phase: 'completed',
          deeplink: 'wolffish://chat?id=2026-08-05_10-00-00'
        })
    )
    ok(
      'explicit conversation deeplink passes through',
      sent[1]?.deeplink === 'wolffish://chat?id=2026-08-05_10-00-00'
    )

    // …and `current` is the one thing the harness fills in: the id comes from
    // the turn scope, exactly like runId, because the model does not reliably
    // know which conversation it is running in and a guess opens the wrong
    // transcript on someone's phone.
    await turnScope.run(
      { turnId: 'turn_dl_3', conversationId: '2026-08-05_10-00-00', autonomous: false },
      () =>
        plugin.execute('notify_phone', {
          title: 't',
          body: 'b',
          phase: 'completed',
          deeplink: 'wolffish://chat?id=current'
        })
    )
    ok(
      'id=current resolves to the run own conversation',
      sent[2]?.deeplink === 'wolffish://chat?id=2026-08-05_10-00-00'
    )

    // WHICH CONVERSATION RAISED IT is a different question from where a tap
    // goes, and it is stamped on every frame regardless — harness identity,
    // like runId. Reading the badge off the deeplink instead is what made a
    // conversation that had sent five notifications wear a 2: the ones sent
    // without a deeplink (which the tool deliberately allows, above) named no
    // conversation, so the phone had nothing to count them against.
    ok(
      'a notification with no deeplink still names the conversation it came from',
      sent[0]?.conversationId === 'conv-2026-08-05_10-00-00'
    )
    ok(
      'and so does one that deep-links somewhere else entirely',
      sent[1]?.conversationId === 'conv-2026-08-05_10-00-00'
    )

    // No conversation in scope: refused rather than sending the literal word
    // `current`, which the phone would open as a conversation that isn't one.
    const orphan = await turnScope.run(
      { turnId: 'turn_dl_4', conversationId: null, autonomous: true },
      () =>
        plugin.execute('notify_phone', {
          title: 't',
          body: 'b',
          phase: 'completed',
          deeplink: 'wolffish://chat?id=current'
        })
    )
    ok('id=current with no conversation in scope is refused', !orphan.success && sent.length === 3)

    // An id that could not be a conversation id (a title, a sentence) never
    // becomes a link — the phone would open a chat that never fills in.
    const titleAsId = await turnScope.run(
      { turnId: 'turn_dl_5', conversationId: '2026-08-05_10-00-00', autonomous: false },
      () =>
        plugin.execute('notify_phone', {
          title: 't',
          body: 'b',
          phase: 'started',
          deeplink: 'wolffish://chat?id=my%20morning%20digest'
        })
    )
    ok('a non-id conversation reference is refused', !titleAsId.success && sent.length === 3)

    // Last, because the two refusals above assert on `sent.length`: a run with
    // no conversation of its own stamps null, and the phone falls back to
    // reading the deeplink exactly as it did before the field existed.
    await turnScope.run({ turnId: 'turn_dl_6', conversationId: null, autonomous: true }, () =>
      plugin.execute('notify_phone', { title: 't', body: 'b', phase: 'info' })
    )
    ok('a run with no conversation stamps null', sent[3]?.conversationId === null)
  }

  // ------------------------------------------------------------ channel layer

  {
    const registered: string[] = []
    const unregistered: string[] = []
    const channel = new MobileChannel({
      agent: {
        cerebellum: {
          registerInProcessCapability: (cap: { name: string }) => registered.push(cap.name),
          unregisterInProcessCapability: (name: string) => unregistered.push(name)
        }
      } as never,
      runner: { send: () => ({ turnId: 't', controller: new AbortController() }) } as never,
      serializeCapabilities: async () => [],
      loadNotificationsEnabled: async () => true
    } as never)
    await channel.start()
    // Presence of the tool IS the availability signal: nothing is paired in
    // this sandbox, so the capability must NOT be registered.
    ok('no pairing → notify_phone not exposed', !registered.includes('phone'))

    type ChannelInternals = {
      pairing: Record<string, unknown> | null
      tunnel: { sendControl: (frame: Record<string, unknown>) => void } | null
      onNotifyResult: (raw: Record<string, unknown>) => void
      syncPhoneCapability: () => void
    }
    const internals = channel as unknown as ChannelInternals

    const request: NotifyPhoneRequest = {
      title: 'Run finished',
      body: 'All done.',
      phase: 'needs_input',
      urgency: 'high',
      deeplink: null,
      conversationId: '2026-08-05_10-00-00',
      runId: 'turn_abc'
    }

    // No pairing at all → a clear refusal (defense in depth below the gate).
    const unpaired = await channel.notifyPhone(request).catch((error: Error) => error)
    ok('unpaired refusal', unpaired instanceof Error && unpaired.message.includes('no phone'))

    // Paired, but the phone predates deviceId → still hidden, still refused.
    internals.pairing = {
      secret: 'AAAA',
      peerPublicKey: 'ab'.repeat(32),
      method: 'qr',
      pairedAt: Date.now(),
      lastSeenAt: null,
      deviceName: 'Test phone'
    }
    internals.syncPhoneCapability()
    ok('paired without phoneId → still not exposed', !registered.includes('phone'))
    const noId = await channel.notifyPhone(request).catch((error: Error) => error)
    ok('missing phoneId refusal', noId instanceof Error && noId.message.includes('identified'))

    // The phone identifies itself (hello carries deviceId) → the tool appears.
    internals.pairing.phoneId = 'phone-device-123456'
    internals.syncPhoneCapability()
    ok('phoneId learned → notify_phone exposed', registered.includes('phone'))

    const wire: Record<string, unknown>[] = []
    internals.tunnel = {
      sendControl: (frame) => {
        wire.push(frame)
        // The relay answers immediately; simulate its result arriving back.
        setTimeout(
          () =>
            internals.onNotifyResult({
              v: 1,
              type: 'notify_result',
              notificationId: frame.notificationId,
              route: 'inband'
            }),
          0
        )
      }
    }
    const result = await channel.notifyPhone(request)
    ok('result resolves with the relay route', result.route === 'inband')
    const sentFrame = wire[0]
    ok('frame is a v1 notify', sentFrame.v === 1 && sentFrame.type === 'notify')
    ok('notificationId is a ULID', ULID_SHAPE.test(String(sentFrame.notificationId)))
    ok('phoneId comes from the pairing record', sentFrame.phoneId === 'phone-device-123456')
    ok('ttl derived from phase (needs_input=300)', sentFrame.ttl === TTL_BY_PHASE.needs_input)
    ok('runId travels with the frame', sentFrame.runId === 'turn_abc')
    // …and so does the conversation it came out of, which is what the phone
    // badges. Separate from the deeplink (null here) on purpose.
    ok(
      'the raising conversation travels with the frame',
      sentFrame.conversationId === '2026-08-05_10-00-00' && sentFrame.deeplink === null
    )
    ok('result id matches the frame id', result.notificationId === sentFrame.notificationId)

    // The user switch both withdraws the tool and kills the direct path.
    await channel.setNotificationsEnabled(false)
    ok('toggle off → notify_phone withdrawn', unregistered.includes('phone'))
    const off = await channel.notifyPhone(request).catch((error: Error) => error)
    ok(
      'disabled setting refuses before sending',
      off instanceof Error && off.message.includes('disabled') && wire.length === 1
    )

    // Toggling back on restores the tool without a restart.
    const before = registered.length
    await channel.setNotificationsEnabled(true)
    ok('toggle on → notify_phone re-exposed', registered.length === before + 1)
  }

  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void run()
