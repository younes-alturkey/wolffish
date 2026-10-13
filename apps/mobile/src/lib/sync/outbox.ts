import { tunnelClient } from '@/lib/tunnel/client'
import { Rpc } from '@/lib/tunnel/protocol'
import type { DemoVariable } from '@/state/demoConfig'

/**
 * Outbound edits — the phone-owned half of settings sync.
 *
 * The config store is a mirror of the desktop's snapshot, and every refresh
 * overwrites it wholesale. The moment the phone can *edit* a setting, that
 * refresh becomes a hazard: a snapshot fetched an instant before the edit can
 * land an instant after it and silently put the old value back under the
 * user's thumb. This module is the guard against exactly that.
 *
 * Two ideas, both deliberately generic so every phone-editable key can share
 * them:
 *
 * - A key is DIRTY from its first unsent local edit until the desktop has
 *   acknowledged the latest one. While dirty, snapshots must not overwrite it.
 * - Every key carries an EPOCH that moves on every local edit and every
 *   settlement. A refresh captures the epochs before fetching and compares
 *   after: any movement means the snapshot raced a write and cannot be trusted
 *   for that key — local stays. The next quiet refresh reapplies desktop
 *   truth, which by then includes the write.
 *
 * Sends are whole-value, debounced, and one-in-flight: a typing burst
 * coalesces into few RPCs, each carrying the complete latest value, so the
 * desktop's arrival order is the only order there is and the last write wins
 * on both screens identically. There are no retries by design — resending an
 * old array after a timeout could overwrite a newer edit made elsewhere, so a
 * failed send abandons the local claim and asks for a refresh instead: the
 * desktop is the source of truth, and honest reversion beats silent
 * divergence.
 */

/** Epoch per phone-edited key — moves on every edit and every settlement. */
const epochs = new Map<string, number>()
/** Keys with local edits the desktop has not acknowledged yet. */
const dirtyKeys = new Set<string>()

/**
 * How long a burst of edits settles before the value flies. Below the
 * desktop's own 300 ms config-push coalescing, so one continuous edit
 * gesture lands as few writes, not one per keystroke.
 */
const PUSH_DEBOUNCE_MS = 350

/** Mark a key locally edited: dirty until settled, epoch moved either way. */
export function markOutboxEdited(key: string): void {
  dirtyKeys.add(key)
  epochs.set(key, (epochs.get(key) ?? 0) + 1)
}

/**
 * The desktop's answer (or the decision to stop waiting for one) closes the
 * key's dirty window. The epoch moves again so a refresh that was already in
 * flight across the settlement still reads as raced — only a fetch that both
 * starts and finishes in a quiet window may overwrite the key.
 */
export function settleOutboxKey(key: string): void {
  dirtyKeys.delete(key)
  epochs.set(key, (epochs.get(key) ?? 0) + 1)
}

/** Epochs as they stand — capture BEFORE fetching a snapshot. */
export function captureOutboxState(): ReadonlyMap<string, number> {
  return new Map(epochs)
}

/**
 * Does this key hold local edits the desktop has not acknowledged? The
 * instantaneous form of the guard, for pushes that arrive WITH their payload:
 * no fetch window to bracket, so dirty-right-now is the whole question — a
 * push landing mid-edit loses to the edit, and the ack that settles it is
 * what lets the next push (or refresh) land desktop truth.
 */
export function outboxIsDirty(key: string): boolean {
  return dirtyKeys.has(key)
}

/**
 * Which keys the snapshot fetched after `before` must NOT overwrite: keys
 * still dirty, plus keys whose epoch moved while the fetch was in the air.
 */
export function outboxKeysToKeepLocal(before: ReadonlyMap<string, number>): string[] {
  const keep = new Set<string>(dirtyKeys)
  for (const [key, epoch] of epochs) {
    if (before.get(key) !== epoch) keep.add(key)
  }
  return [...keep]
}

/**
 * A failed send leaves local and desktop disagreeing; whoever registers here
 * gets asked to fetch a snapshot and re-align. sync.ts hands in its debounced
 * config refresh so this module never has to import it (demoConfig imports
 * this file, sync imports demoConfig — a runtime import back into sync would
 * close that loop).
 */
let refreshHook: (() => void) | null = null

export function setOutboxRefreshHook(hook: (() => void) | null): void {
  refreshHook = hook
}

// ------------------------------------------------------------------ variables

/**
 * Rows without a name are drafts still being composed — the desktop's own
 * panel cannot save one, so the phone keeps them local until they earn a
 * name. Named rows travel exactly as typed.
 */
function syncableVariables(variables: DemoVariable[]): DemoVariable[] {
  return variables.filter((variable) => variable.name.trim().length > 0)
}

let variablesSeq = 0
let variablesLatest: { seq: number; variables: DemoVariable[] } | null = null
let variablesTimer: ReturnType<typeof setTimeout> | null = null
let variablesSending = false

/**
 * Queue the variables array for the desktop. Called on every local edit while
 * paired and connected; the debounce and the one-in-flight rule turn a typing
 * burst into few whole-array writes, always the newest.
 */
export function pushVariables(variables: DemoVariable[]): void {
  if (!tunnelClient.connected) return
  markOutboxEdited('variables')
  variablesLatest = { seq: ++variablesSeq, variables: syncableVariables(variables) }
  scheduleVariablesFlush()
}

function scheduleVariablesFlush(): void {
  if (variablesTimer) clearTimeout(variablesTimer)
  variablesTimer = setTimeout(() => {
    variablesTimer = null
    void flushVariables()
  }, PUSH_DEBOUNCE_MS)
}

async function flushVariables(): Promise<void> {
  // An in-flight send owns the wire; its completion re-schedules when a newer
  // array queued behind it.
  if (variablesSending) return
  const batch = variablesLatest
  if (!batch) return

  const tunnel = tunnelClient.active
  if (!tunnel || !tunnel.connected) {
    // The link is gone, and settings flip read-only with it. The unsent tail
    // is abandoned here — reconnect reconciles from the desktop, which is the
    // stated contract: offline edits do not exist.
    variablesLatest = null
    settleOutboxKey('variables')
    return
  }

  variablesSending = true
  let failed = false
  try {
    await tunnel.rpc(Rpc.variablesSet, { variables: batch.variables })
  } catch (error) {
    failed = true
    tunnelClient.reportRpcFailure(error)
  } finally {
    variablesSending = false
  }

  if (failed) {
    // No retry — see the header. Drop the claim and ask for desktop truth.
    variablesLatest = null
    settleOutboxKey('variables')
    refreshHook?.()
    return
  }

  if (variablesLatest && variablesLatest.seq !== batch.seq) {
    // Typing continued while this one flew; the newer array goes next.
    scheduleVariablesFlush()
    return
  }

  variablesLatest = null
  settleOutboxKey('variables')
}

// -------------------------------------------------------------- capabilities

/**
 * Pending toggles by capability name, newest state per name. A toggle is one
 * deliberate act, not a typing burst, so there is no debounce — the first
 * send flies immediately. The map plus the one-in-flight rule still collapse
 * a rapid double-flip into "first state out, final state next", and per name
 * the last write wins on both screens identically.
 *
 * The store write is the caller's (sync.setCapabilityEnabled owns the
 * optimistic flip); this owns the wire and the dirty window that keeps a
 * raced snapshot from reverting the switch under the user's thumb.
 */
const capabilityPending = new Map<string, boolean>()
let capabilitySending = false
/** A send in this drain answered a different state than asked (locked core,
 *  stale row) — the optimistic flip is wrong and desktop truth must land. */
let capabilityRefused = false

/** Queue one capability toggle for the desktop and send as soon as the wire
 *  is free. Called on every flip while paired and connected. */
export function pushCapability(name: string, enabled: boolean): void {
  if (!tunnelClient.connected) return
  markOutboxEdited('capabilities')
  capabilityPending.set(name, enabled)
  void flushCapabilities()
}

async function flushCapabilities(): Promise<void> {
  if (capabilitySending) return
  const head = capabilityPending.entries().next()
  if (head.done) return
  const [name, enabled] = head.value
  capabilityPending.delete(name)

  const tunnel = tunnelClient.active
  if (!tunnel || !tunnel.connected) {
    // The link is gone, and settings flip read-only with it. Offline edits
    // do not exist — reconnect reconciles from the desktop.
    capabilityPending.clear()
    capabilityRefused = false
    settleOutboxKey('capabilities')
    return
  }

  capabilitySending = true
  let failed = false
  try {
    const answer = (await tunnel.rpc(Rpc.capabilitySet, { name, enabled })) as {
      enabled?: boolean
    } | null
    if (typeof answer?.enabled === 'boolean' && answer.enabled !== enabled) {
      capabilityRefused = true
    }
  } catch (error) {
    failed = true
    tunnelClient.reportRpcFailure(error)
  } finally {
    capabilitySending = false
  }

  if (failed) {
    // No retry — see the header. Drop every claim and ask for desktop truth.
    capabilityPending.clear()
    capabilityRefused = false
    settleOutboxKey('capabilities')
    refreshHook?.()
    return
  }

  if (capabilityPending.size > 0) {
    void flushCapabilities()
    return
  }

  settleOutboxKey('capabilities')
  if (capabilityRefused) {
    // Settled first, so the corrective snapshot lands in a quiet window and
    // may overwrite the key with the state the desktop actually holds.
    capabilityRefused = false
    refreshHook?.()
  }
}

/** Tests only — this module is a singleton and jest reuses the process. */
export function resetOutboxForTests(): void {
  epochs.clear()
  dirtyKeys.clear()
  if (variablesTimer) clearTimeout(variablesTimer)
  variablesTimer = null
  variablesLatest = null
  variablesSending = false
  variablesSeq = 0
  capabilityPending.clear()
  capabilitySending = false
  capabilityRefused = false
  refreshHook = null
}
