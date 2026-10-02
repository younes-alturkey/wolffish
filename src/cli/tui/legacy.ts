/**
 * Escape hatch to the classic line-mode flows.
 *
 * Every interactive menu the old CLI shipped (settings actions, pairing,
 * workspace editors) reads stdin through `question()` in lib/ui.mjs, which
 * falls back to raw stdin when no line reader is registered. That means they
 * still work if the TUI steps out of the way: suspend the renderer (raw mode
 * off, alternate screen left), run the flow on the plain terminal, then
 * resume and repaint. Exactly how the external-editor handoff works.
 *
 * Native dialogs replace the most-used flows; this keeps the long tail
 * reachable from day one, so nothing the app can do is missing here.
 */
import type { CliRenderer } from '@opentui/core'

let suspended = false

export async function withSuspendedRenderer<T>(
  renderer: CliRenderer,
  run: () => Promise<T>
): Promise<T> {
  if (suspended) return run()
  suspended = true
  renderer.suspend()
  // Give the terminal a clean line to start on.
  process.stdout.write('\n')
  try {
    return await run()
  } finally {
    suspended = false
    // A flow may have left stdin paused or in a different mode; the renderer
    // re-applies its own state on resume.
    try {
      process.stdin.resume()
    } catch {
      /* not resumable */
    }
    renderer.resume()
  }
}

/**
 * Pause on the plain terminal until Enter, so the output of a classic flow
 * can be read before the screen is repainted.
 */
export async function pressEnter(message = 'Press Enter to return'): Promise<void> {
  process.stdout.write(`\n${message} `)
  await new Promise<void>((resolve) => {
    const onData = (chunk: Buffer) => {
      if (chunk.includes(13) || chunk.includes(10)) {
        process.stdin.removeListener('data', onData)
        process.stdin.pause()
        resolve()
      }
    }
    process.stdin.resume()
    process.stdin.on('data', onData)
  })
}
