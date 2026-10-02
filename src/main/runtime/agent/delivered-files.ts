/**
 * Delivered-file note — the in-context record of files the MODEL delivered
 * this turn, so it never re-sends the same file twice in one turn.
 *
 * Detection is MARKER-ONLY by design: the `[wolffish-output: <path> (type)]`
 * marker is emitted exclusively by deliberate delivery tools (send_file's
 * contract) — i.e., by the model's own explicit act. The old bare
 * `{path}` / `{files:[{path}]}` JSON detection is gone along with harness
 * auto-delivery: generating a file no longer counts as delivering it, and
 * nothing here may ever talk the model out of sending its output. Delivery
 * is 100% the model's job; this module only remembers what it already sent.
 *
 * LINE-ANCHORED: a real marker stands on its own line (send_file emits it as
 * the whole output; older delivery tools appended it on its own line). Tool
 * output can QUOTE the marker template mid-line — a grep/cat over code or
 * docs that mention it — and a quoted template is not a delivery.
 */

const MARKER_RE =
  /^[ \t]*\[wolffish-output:[ \t]*([^\]\n]+?)[ \t]+\((?:image|audio|video|document|file|chart)\)\][ \t]*$/gm

function basename(p: string): string {
  const cleaned = p.trim().replace(/[/\\]+$/, '')
  const cut = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return cut >= 0 ? cleaned.slice(cut + 1) : cleaned
}

/**
 * The file names a tool result explicitly delivered to the user (via the
 * send_file marker), in order, deduped. Empty when no marker is present.
 */
export function deliveredFileNames(output: string): string[] {
  if (!output) return []
  const names = new Set<string>()

  MARKER_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MARKER_RE.exec(output)) !== null) {
    const name = basename(m[1])
    if (name) names.add(name)
  }

  return [...names]
}

/**
 * One-line reminder listing the files already delivered this turn, or null when
 * none. Rides the outbound VOLATILE TAIL (formatRuntimeStatus) / the legacy
 * `<runtime>` block — both rendered strictly AFTER every cache breakpoint, so
 * this per-iteration fact never perturbs the cached prefix. Turn-scoped: the
 * caller accumulates names across the turn and resets each turn, so a later
 * turn starts clean (a fresh "send me that again" is never suppressed by a
 * stale note). This is why the reminder is NOT appended to tool-result messages
 * — that would sit inside the cached history and force a cross-turn cache miss.
 */
export function deliveredFilesReminder(names: string[]): string | null {
  if (names.length === 0) return null
  const list = names.join(', ')
  const one = names.length === 1
  return (
    `Files already delivered to the user THIS turn (shown in the conversation): ${list}. ` +
    `This applies ONLY to ${one ? 'that file' : 'those files'}: don't re-send ${one ? 'it' : 'them'} this turn unless you've edited ${one ? 'it' : 'them'} since ` +
    `(if changed, re-send the updated version). ALWAYS call send_file for any OTHER new, edited, or not-yet-shown file — delivering the file is the default.`
  )
}
