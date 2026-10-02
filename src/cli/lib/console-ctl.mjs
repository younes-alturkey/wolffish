/**
 * Asking the Windows launcher to stop echoing what the user types.
 *
 * Only ever does anything under wolffish-cli.exe. There, the CLI runs on the
 * far side of a pipe and the CONSOLE is what echoes keystrokes — so the two
 * ways this codebase masks a secret both stop working. `setRawMode` is
 * unavailable (a pipe has no raw mode), and muting readline's `_writeToOutput`
 * mutes something that is not doing the echoing. Neither fails loudly; a bot
 * token simply appears in the scrollback.
 *
 * Echo belongs to whoever owns the console, which is the launcher, so the
 * launcher is asked. It publishes a named pipe and its path in
 * WOLFFISH_CONSOLE_CTL; see build/win-cli-launcher/wolffish-cli.cs.
 *
 * Every function here reports whether it actually worked, and callers are
 * expected to warn rather than assume. Silently believing input is hidden is
 * the failure this whole file exists to prevent.
 */
import net from 'node:net'

let socket = null
let pending = null

/** Connect once and keep it; null when there is no launcher listening. */
function channel() {
  const address = process.env.WOLFFISH_CONSOLE_CTL
  if (!address) return Promise.resolve(null)
  if (socket) return Promise.resolve(socket)
  if (pending) return pending

  pending = new Promise((resolve) => {
    const attempt = net.createConnection(address)
    // unref so a live control socket can never be the reason the CLI refuses
    // to exit — this is a side channel, not work.
    attempt.unref()
    attempt.once('connect', () => {
      socket = attempt
      resolve(attempt)
    })
    attempt.once('error', () => {
      pending = null
      resolve(null)
    })
  })
  return pending
}

/**
 * Turn console echo off (or back on).
 *
 * @returns {Promise<boolean>} true when the launcher acknowledged the write.
 *   false means nothing was masked — say so rather than pretending.
 */
export async function setConsoleEcho(on) {
  const pipe = await channel()
  if (!pipe) return false
  return new Promise((resolve) => {
    pipe.write(on ? 'echo 1\n' : 'echo 0\n', (err) => resolve(!err))
  })
}

/** True when a secret can actually be hidden by asking the launcher. */
export function canMaskViaConsole() {
  return typeof process.env.WOLFFISH_CONSOLE_CTL === 'string'
}
