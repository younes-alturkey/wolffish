/**
 * No-progress guard — it OBSERVES and REPORTS tool-call repetition; it never
 * caps, aborts, or kills anything.
 *
 * The agent loop has no numeric iteration/tool-call cap by design (see Agent.ts
 * "loop detection is the model's responsibility, informed by the <runtime>
 * block"). That single point of failure has one blind spot: a cloud model that
 * stays productively BUSY — a tool call every iteration, every call succeeding —
 * while making no actual progress, re-issuing the same call over and over
 * (observed: a research subagent that read two pages ~130× in a switch→read→
 * switch→read loop, 411 tool calls, 23M tokens, and never concluded). Nothing
 * told it the one fact it was missing: "you keep making the same call and it
 * isn't returning anything new."
 *
 * This guard supplies exactly that fact, the same way the loop already surfaces
 * `toolsCalled` — as a line in the runtime tail (cache-safe, after every cache
 * breakpoint). The model reads it and DECIDES what to do: conclude with partial
 * results, change approach, or — if the repetition is genuinely productive —
 * ignore it and continue. A workflow master reads a stronger form of the same
 * signal (see the MASTER threshold) to manage a spinning subagent it spawned.
 *
 * Nothing here enforces. Every decision stays with a model.
 */

/** Rolling window (most-recent tool calls) the signal is computed over. */
export const NO_PROGRESS_WINDOW = 24

/**
 * A single identical call (same tool + same salient args) repeated at least
 * this many times within the window surfaces the WORKER notice. Tight on
 * purpose: issuing the byte-identical tool call 6× in the last 24 is deeply
 * abnormal for productive work, so the false-positive rate is near zero — and
 * even a false positive only costs one dismissible line, never an action.
 */
export const NO_PROGRESS_WORKER_REPEATS = 6

/**
 * The stronger bar at which a SUBAGENT's repetition is escalated to its master
 * (the master gets woken from agents_await to decide: cancel, steer, or wait).
 * Higher than the worker bar because waking the master is more disruptive than
 * a self-addressed line, so it should fire only on a clearer runaway.
 */
export const NO_PROGRESS_MASTER_REPEATS = 10

export type NoProgressSignal = {
  /** Occurrences of the single most-repeated call signature in the window. */
  repeats: number
  /** Readable label of that dominant call, e.g. `ext_read_page format=markdown`. */
  label: string
  /** Distinct signatures currently in the window (telemetry / tuning context). */
  distinct: number
  /** Calls actually considered (≤ NO_PROGRESS_WINDOW). */
  windowSize: number
}

/** Compact, bounded rendering of one arg value — enough to tell calls apart. */
function compactValue(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v.slice(0, 120)
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v).slice(0, 120)
    } catch {
      return '[object]'
    }
  }
  return String(v).slice(0, 120)
}

/** Stable, key-sorted, length-bounded rendering of a call's args. */
function stableArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return ''
  try {
    return Object.keys(args)
      .sort()
      .map((k) => `${k}=${compactValue(args[k])}`)
      .join('&')
      .slice(0, 300)
  } catch {
    return ''
  }
}

/**
 * The repetition key: same tool + same salient args ⇒ same signature. Two
 * byte-identical `ext_read_page {format:"markdown"}` calls collapse to one key;
 * a read of a different page (different args) is a different key. This is what
 * lets "the same call, again" be counted as no new information.
 */
export function toolCallSignature(name: string, args: Record<string, unknown> | undefined): string {
  return `${name}|${stableArgs(args)}`
}

/** Short human label naming the dominant repeated call in the notice. */
function toolCallLabel(name: string, args: Record<string, unknown> | undefined): string {
  const a = stableArgs(args)
  return a ? `${name} ${a.slice(0, 80)}` : name
}

/**
 * Per-turn rolling tracker. One instance lives for the length of a single
 * respond() tool loop (loop-scoped, like the empty-turn nudge counter) and is
 * fed every tool call the model makes.
 */
export class NoProgressTracker {
  private readonly window: Array<{ sig: string; label: string }> = []

  /** Record one tool call the model issued (any outcome — a denied retry loop counts too). */
  record(name: string, args: Record<string, unknown> | undefined): void {
    this.window.push({ sig: toolCallSignature(name, args), label: toolCallLabel(name, args) })
    if (this.window.length > NO_PROGRESS_WINDOW) this.window.shift()
  }

  /**
   * The current dominant-repetition signal, or null when nothing repeats. Pure
   * observation: returns the most-repeated signature's count + label regardless
   * of any threshold — callers apply the worker/master bars to it.
   */
  signal(): NoProgressSignal | null {
    if (this.window.length === 0) return null
    const counts = new Map<string, { n: number; label: string }>()
    for (const e of this.window) {
      const c = counts.get(e.sig)
      if (c) c.n += 1
      else counts.set(e.sig, { n: 1, label: e.label })
    }
    let top: { n: number; label: string } = { n: 0, label: '' }
    for (const c of counts.values()) if (c.n > top.n) top = c
    if (top.n < 2) return null
    return {
      repeats: top.n,
      label: top.label,
      distinct: counts.size,
      windowSize: this.window.length
    }
  }
}

/**
 * The runtime-tail notice for the WORKER, or null below the worker bar. Rides
 * the same volatile vehicle as `toolsCalled` — never the cached prompt prefix.
 * Phrased as automated telemetry that gives the model both exits and defers to
 * its judgment, matching the runtime tail's own voice.
 */
export function noProgressNotice(signal: NoProgressSignal | null): string | null {
  if (!signal || signal.repeats < NO_PROGRESS_WORKER_REPEATS) return null
  return (
    `NO-PROGRESS SIGNAL: you have issued the same tool call — \`${signal.label}\` — ` +
    `${signal.repeats} times recently, and it is returning nothing new. ` +
    `If you are not making real progress toward the goal, STOP repeating it: ` +
    `report what you have so far (partial findings are far more useful than looping) ` +
    `or take a materially different approach. If this repetition is genuinely ` +
    `productive, disregard this and continue.`
  )
}
