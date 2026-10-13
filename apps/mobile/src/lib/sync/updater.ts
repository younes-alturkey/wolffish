import { tunnelClient } from '@/lib/tunnel/client'
import {
  Rpc,
  UPDATER_PHASES,
  type UpdaterWireError,
  type UpdaterWirePhase,
  type UpdaterWireState
} from '@/lib/tunnel/protocol'
import { create } from 'zustand'

/**
 * The paired desktop's self-updater, mirrored — the same phase machine its
 * own Updates panel renders (idle / checking / downloading / verifying /
 * ready / installing / error), now also driven from this phone. A check or
 * install sent from here lands on the SAME registered handlers a click on
 * the desktop or a CLI command invokes, so the acts cannot drift.
 *
 * IN MEMORY ONLY, and cleared the moment the tunnel drops, for the overlay
 * rule: every phase claims something is happening right now on a machine
 * this one cannot see. During an install that is literally true — the
 * desktop is down restarting — and the reconnect plus the fresh snapshot it
 * brings are what report the outcome: a new version on the Updates screen.
 *
 * State arrives as `updater.state` pushes, so a phone connecting mid-download
 * has missed every announcement; `seedDesktopUpdater()` closes that window
 * once per connection, exactly like the overlay seed.
 *
 * `state: null` means nothing is known — not connected, or a desktop too old
 * (or unable) to serve the updater RPCs. The Updates screen keeps its check
 * row then but disables the button: there is no desktop to ask.
 */

type DesktopUpdaterStore = { state: UpdaterWireState | null }

export const useDesktopUpdater = create<DesktopUpdaterStore>()(() => ({ state: null }))

// ------------------------------------------------------------------ reading

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/**
 * A wire state read tolerantly, or null if the payload carries none — which
 * is also what a desktop without an updater answers on the seed. An unknown
 * phase (a newer desktop) reads as 'idle' rather than a card this build
 * cannot mean; percent is clamped to what a progress bar can show.
 */
export function readUpdaterState(payload: unknown): UpdaterWireState | null {
  const source = (payload as { state?: unknown } | null)?.state as
    Partial<UpdaterWireState> | null | undefined
  if (!source || typeof source !== 'object') return null
  const rawError = source.error as Partial<UpdaterWireError> | null | undefined
  const error: UpdaterWireError | null =
    rawError && typeof rawError === 'object'
      ? {
          code: text(rawError.code) ?? 'unknown',
          message: text(rawError.message) ?? '',
          detail: text(rawError.detail)
        }
      : null
  const percent =
    typeof source.percent === 'number' && Number.isFinite(source.percent) ? source.percent : 0
  return {
    phase: UPDATER_PHASES.includes(source.phase as UpdaterWirePhase)
      ? (source.phase as UpdaterWirePhase)
      : 'idle',
    version: text(source.version),
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    error
  }
}

// ------------------------------------------------------------------ writing

/**
 * Bumped by everything that writes newer knowledge than a seed in flight —
 * a push, an armed install, or the tunnel dropping. See seedDesktopUpdater.
 */
let revision = 0

/**
 * Fold an `updater.state` push. The push carries the whole machine, so it IS
 * the state. A malformed payload (null off the reader) changes nothing —
 * keeping the last known state beats clearing it on a frame this build
 * cannot parse.
 */
export function applyUpdaterPush(state: UpdaterWireState | null): void {
  if (!state) return
  revision += 1
  useDesktopUpdater.setState({ state })
}

/** Nothing is knowable once the tunnel is gone. See the file doc. */
export function clearDesktopUpdater(): void {
  revision += 1
  useDesktopUpdater.setState({ state: null })
}

/**
 * Ask the desktop where its updater stands, once per connection.
 *
 * Discarded if anything else wrote while it was in flight — same contract as
 * the overlay seed, for the same race: the seed is issued on the edge that
 * attaches the push handlers, and an answer describing a world a push has
 * since moved on from must not put the old phase back.
 *
 * Never throws: a desktop too old to answer leaves the check button
 * disabled, exactly as if the tunnel were down.
 */
export async function seedDesktopUpdater(): Promise<void> {
  const tunnel = tunnelClient.active
  if (!tunnel || !tunnelClient.connected) return
  const issued = revision
  try {
    const answer = await tunnel.rpc(Rpc.updaterState)
    if (revision !== issued) return
    useDesktopUpdater.setState({ state: readUpdaterState(answer) })
  } catch {
    // Deliberately silent, and deliberately NOT reportRpcFailure: an
    // unsupported method is not a sick tunnel, and nothing the user asked
    // for has failed.
  }
}

// ------------------------------------------------------------------ actions

export type DesktopUpdateCheck =
  | { outcome: 'upToDate' }
  | { outcome: 'found'; version: string }
  | { outcome: 'failed' }
  | { outcome: 'offline' }

/**
 * Ask the desktop to check for updates — its own `updater:check`, guards
 * included: a check during an active download is a safe no-op that answers
 * the in-flight version. `found` needs no follow-up from the caller; the
 * desktop auto-downloads and the phase pushes narrate the rest.
 */
export async function checkDesktopUpdate(): Promise<DesktopUpdateCheck> {
  const tunnel = tunnelClient.active
  if (!tunnel || !tunnelClient.connected) return { outcome: 'offline' }
  try {
    const result = (await tunnel.rpc(Rpc.updaterCheck)) as {
      ok?: unknown
      version?: unknown
    } | null
    if (result?.ok !== true) return { outcome: 'failed' }
    const version = text(result.version)
    return version ? { outcome: 'found', version } : { outcome: 'upToDate' }
  } catch {
    return { outcome: 'failed' }
  }
}

export type DesktopInstallResult = 'armed' | 'refused' | 'unknown' | 'offline'

/**
 * Ask the desktop to install the downloaded update and restart.
 *
 * The desktop answers BEFORE it begins shutting down, so `armed` normally
 * arrives on the still-open tunnel; the phase flips to 'installing' here the
 * moment it does, without waiting for the push racing the restart. A
 * transport error after the ask is the one genuinely ambiguous outcome — the
 * answer may have died with the connection the restart closed — reported as
 * 'unknown', never 'refused': the caller says "if the update began, the
 * desktop reconnects shortly" rather than claiming a failure it cannot know.
 */
export async function installDesktopUpdate(): Promise<DesktopInstallResult> {
  const tunnel = tunnelClient.active
  if (!tunnel || !tunnelClient.connected) return 'offline'
  try {
    const result = (await tunnel.rpc(Rpc.updaterInstall)) as { ok?: unknown } | null
    if (result?.ok !== true) return 'refused'
    const current = useDesktopUpdater.getState().state
    if (current) {
      revision += 1
      useDesktopUpdater.setState({ state: { ...current, phase: 'installing' } })
    }
    return 'armed'
  } catch {
    return 'unknown'
  }
}
