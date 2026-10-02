import fs from 'node:fs/promises'

/**
 * Copy a file, reporting byte progress while it runs.
 *
 * `fs.copyFile` reports nothing until it resolves, so we poll the
 * destination's size against the known source size instead of replacing the
 * copy with a stream pipeline. That keeps the fast paths intact — on APFS a
 * same-volume copy is a clone and finishes before the first poll even fires,
 * so the caller just sees a jump to 100% — while a genuinely slow copy (an
 * external drive, a network volume, a multi-GB video) reports real bytes.
 *
 * The polling is read-only and best-effort: a stat that fails (destination
 * not created yet) is ignored, and reported bytes are monotonic so a late
 * stat can never walk a progress bar backwards. `onProgress` always ends on
 * a final `totalBytes` call, so callers never have to synthesize completion.
 */
export async function copyFileWithProgress(
  source: string,
  dest: string,
  totalBytes: number,
  onProgress?: (copiedBytes: number) => void,
  pollMs = 150
): Promise<void> {
  if (!onProgress) {
    await fs.copyFile(source, dest)
    return
  }

  let finished = false
  let reported = 0
  const timer = setInterval(() => {
    if (finished) return
    void fs
      .stat(dest)
      .then((st) => {
        if (finished) return
        const copied = Math.min(st.size, totalBytes)
        if (copied > reported) {
          reported = copied
          onProgress(copied)
        }
      })
      .catch(() => undefined)
  }, pollMs)

  try {
    await fs.copyFile(source, dest)
  } finally {
    finished = true
    clearInterval(timer)
  }
  onProgress(totalBytes)
}
