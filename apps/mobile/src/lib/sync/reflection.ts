import { markOutboxEdited, settleOutboxKey } from '@/lib/sync/outbox'
import { tunnelClient } from '@/lib/tunnel/client'
import { Rpc } from '@/lib/tunnel/protocol'
import { refreshConfigSnapshot, useDemoConfig, type DemoConfigValues } from '@/state/demoConfig'

/**
 * Write-through for the Knowledge screen's reflection controls.
 *
 * Reflection has its own RPC rather than riding the generic configSet path
 * because its answer is richer: the desktop replies with the complete config
 * it actually persisted — the same contract its own settings panel gets from
 * the reflection IPC — and this module writes THAT into the store. The row
 * moves under the finger optimistically (the caller's setConfigValue), and
 * the desktop's answer replaces the optimism with the persisted truth, so the
 * two screens can only ever disagree for the length of one round trip.
 *
 * Sends are immediate, one-in-flight, and merged: a second edit made while
 * one is flying folds into a pending patch that flies next, and a stale
 * answer is never applied over a newer local edit. The outbox's dirty/epoch
 * bookkeeping guards the same window against snapshot refreshes. Failures
 * follow the outbox contract — no retries; drop the claim, re-pull desktop
 * truth, and let the row honestly snap back.
 */

/** The wire patch — mirrors the desktop's ReflectionPatch. */
export type ReflectionPatch = {
  hour?: number
  quietHours?: number
}

/** The desktop's answer: its complete post-write reflection config. */
type ReflectionAnswer = {
  hour?: unknown
  quietHours?: unknown
}

/** Every flat store key a reflection answer settles. */
const REFLECTION_KEYS: ReadonlyArray<keyof DemoConfigValues> = [
  'reflectionHour',
  'reflectionQuietHours'
]

/** The flat store keys one patch touches — what to mark dirty for it. */
function patchKeys(patch: ReflectionPatch): Array<keyof DemoConfigValues> {
  const keys: Array<keyof DemoConfigValues> = []
  if (patch.hour !== undefined) keys.push('reflectionHour')
  if (patch.quietHours !== undefined) keys.push('reflectionQuietHours')
  return keys
}

/** Fold `next` over `base` — later edits win field by field. */
function mergePatch(base: ReflectionPatch, next: ReflectionPatch): ReflectionPatch {
  return {
    ...base,
    ...(next.hour !== undefined ? { hour: next.hour } : {}),
    ...(next.quietHours !== undefined ? { quietHours: next.quietHours } : {})
  }
}

/** The desktop's persisted config, written over the optimistic values. */
function applyAnswer(answer: ReflectionAnswer): void {
  const { setValue } = useDemoConfig.getState()
  if (typeof answer.hour === 'number') setValue('reflectionHour', answer.hour)
  if (typeof answer.quietHours === 'number') setValue('reflectionQuietHours', answer.quietHours)
}

let pending: ReflectionPatch | null = null
let sending = false

/**
 * Queue a reflection edit for the desktop. Call after the optimistic local
 * set; a no-op when nothing is connected (demo mode, paired-but-offline —
 * the read-only guard upstream already refused the edit there).
 */
export function pushReflectionConfig(patch: ReflectionPatch): void {
  if (!tunnelClient.connected) return
  for (const key of patchKeys(patch)) markOutboxEdited(key)
  pending = pending ? mergePatch(pending, patch) : patch
  void flush()
}

async function flush(): Promise<void> {
  if (sending) return
  const batch = pending
  if (!batch) return
  pending = null

  const tunnel = tunnelClient.active
  if (!tunnel || !tunnel.connected) {
    // The link is gone, and settings flip read-only with it. Offline edits
    // do not exist — reconnect reconciles from the desktop.
    for (const key of REFLECTION_KEYS) settleOutboxKey(key)
    return
  }

  sending = true
  let answer: ReflectionAnswer | null = null
  let failed = false
  try {
    answer = (await tunnel.rpc(Rpc.setReflectionConfig, batch)) as ReflectionAnswer
  } catch (error) {
    failed = true
    tunnelClient.reportRpcFailure(error)
  } finally {
    sending = false
  }

  if (failed) {
    // No retry — drop the claim and re-pull the desktop's truth so the row
    // snaps back rather than keep showing an edit that never happened.
    pending = null
    for (const key of REFLECTION_KEYS) settleOutboxKey(key)
    await refreshConfigSnapshot().catch(() => undefined)
    return
  }

  if (pending) {
    // Edits continued while this one flew. The answer is already stale
    // against them — don't let it stomp the newer optimism; the next flush's
    // answer carries the final truth.
    void flush()
    return
  }

  if (answer) applyAnswer(answer)
  for (const key of REFLECTION_KEYS) settleOutboxKey(key)
}

/**
 * Start a reflection job on the desktop — the phone's Run-now. Answers the
 * brainstem's own state ('coalesced' = already running or queued), or null
 * when the link is down or the desktop refused; callers toast accordingly.
 */
export async function runReflectionJob(
  kind: 'reflection' | 'deepClean'
): Promise<'running' | 'queued' | 'coalesced' | null> {
  const tunnel = tunnelClient.active
  if (!tunnel || !tunnel.connected) return null
  try {
    const answer = (await tunnel.rpc(Rpc.runReflection, { kind })) as { result?: unknown }
    if (answer?.result === 'coalesced') return 'coalesced'
    if (answer?.result === 'running') return 'running'
    return 'queued'
  } catch (error) {
    tunnelClient.reportRpcFailure(error)
    return null
  }
}

/** Tests only — this module is a singleton and jest reuses the process. */
export function resetReflectionOutboxForTests(): void {
  pending = null
  sending = false
}
