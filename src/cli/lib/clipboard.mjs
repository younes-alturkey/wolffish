/**
 * Putting text on the system clipboard, from any of the three platforms this
 * CLI ships on — including the case none of them can solve natively: an SSH
 * session into a headless box, where "the clipboard" is on a laptop the
 * process cannot see.
 *
 * Native tool first, because its success is verifiable (the process exits 0):
 *   macOS    pbcopy — always present.
 *   Windows  PowerShell's Set-Clipboard, fed UTF-8 on stdin. Not clip.exe
 *            first: clip interprets stdin in the console codepage, which
 *            mangles anything beyond ASCII — an emoji in a prompt is normal
 *            here. clip.exe stays as the last resort.
 *   Linux    wl-copy on Wayland, xclip/xsel on X11 — whichever is installed.
 *
 * When no tool answers (a server, a container), OSC 52 asks the TERMINAL to
 * copy: the escape sequence rides the SSH connection and fills the clipboard
 * on the machine with the keyboard, which is exactly where the user wants the
 * text. iTerm2, Windows Terminal, kitty, WezTerm, Ghostty, foot and xterm all
 * honour it; a terminal that does not simply ignores the write. Inside tmux
 * the sequence needs tmux's passthrough wrapper or tmux itself eats it.
 */
import { spawn } from 'node:child_process'
import { stdoutIsTty } from './tty.mjs'

/** Feed `text` to a command's stdin; true only when it exits 0. */
function pipeTo(bin, args, text) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'] })
    } catch {
      resolve(false)
      return
    }
    // A tool that hangs (PowerShell without a profile can still stall on a
    // broken WinRM setup) must not hang the copy command with it.
    const timer = setTimeout(() => {
      child.kill()
      resolve(false)
    }, 15_000)
    timer.unref?.()
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
    // EPIPE from a tool that exited early is a failed copy, not a crash.
    child.stdin.on('error', () => undefined)
    child.stdin.end(text)
  })
}

/**
 * Copy `text`. Resolves `{ ok, how }` naming what actually did the copying, or
 * `{ ok: false, error }` with the one actionable next step.
 */
export async function copyToClipboard(text) {
  const value = String(text ?? '')

  if (process.platform === 'darwin') {
    if (await pipeTo('pbcopy', [], value)) return { ok: true, how: 'pbcopy' }
  } else if (process.platform === 'win32') {
    const script =
      '[Console]::InputEncoding=[System.Text.Encoding]::UTF8; ' +
      'Set-Clipboard -Value ([Console]::In.ReadToEnd())'
    if (
      await pipeTo('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], value)
    ) {
      return { ok: true, how: 'the Windows clipboard' }
    }
    if (await pipeTo('clip.exe', [], value)) return { ok: true, how: 'clip' }
  } else {
    if (process.env.WAYLAND_DISPLAY && (await pipeTo('wl-copy', [], value))) {
      return { ok: true, how: 'wl-copy' }
    }
    if (process.env.DISPLAY) {
      if (await pipeTo('xclip', ['-selection', 'clipboard'], value)) {
        return { ok: true, how: 'xclip' }
      }
      if (await pipeTo('xsel', ['--clipboard', '--input'], value)) return { ok: true, how: 'xsel' }
    }
  }

  if (stdoutIsTty()) {
    const payload = `\x1b]52;c;${Buffer.from(value, 'utf8').toString('base64')}\x07`
    // tmux consumes unknown escapes unless they are wrapped for passthrough.
    // eslint-disable-next-line no-control-regex
    const wrapped = `\x1bPtmux;${payload.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`
    process.stdout.write(process.env.TMUX ? wrapped : payload)
    return {
      ok: true,
      how: 'your terminal (OSC 52)',
      note: 'works when the terminal supports clipboard writes — iTerm2, Windows Terminal, kitty, WezTerm and Ghostty all do'
    }
  }

  return {
    ok: false,
    error:
      process.platform === 'linux'
        ? 'no clipboard tool found — install xclip or wl-clipboard'
        : 'no clipboard is reachable from here'
  }
}
