/**
 * Proactive access check: what this machine lets Wolffish see and touch,
 * per operating system, stated BEFORE a session starts rather than
 * discovered as a cryptic tool error in the middle of one.
 *
 * `accessReport` takes probes (so tests can inject them) and returns one
 * structured status plus the human-readable lines the tool prints. Each
 * missing item names what it blocks, the exact settings path or command,
 * and whether a restart is needed.
 */

import fs from 'node:fs/promises'

export const MAC_SETTINGS = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'
}

/** Pure: build the report from probe results. */
export function buildAccessReport({ platform, driver, mac, linux, windows, overlayAvailable }) {
  const items = []
  const add = (item) => items.push(item)

  if (platform === 'darwin') {
    add({
      key: 'accessibility',
      label: 'Accessibility',
      state: mac?.accessibility === true ? 'ok' : mac?.accessibility === false ? 'missing' : 'unknown',
      blocks: 'every mouse and keyboard action',
      fix: 'System Settings → Privacy & Security → Accessibility → enable Wolffish',
      settingsUrl: MAC_SETTINGS.accessibility,
      restart: false
    })
    add({
      key: 'screenRecording',
      label: 'Screen Recording',
      state: mac?.screenRecording === true ? 'ok' : mac?.screenRecording === false ? 'missing' : 'unknown',
      blocks: 'screenshots, zooms, window captures and the element tree of other apps',
      fix: 'System Settings → Privacy & Security → Screen Recording → enable Wolffish, then restart Wolffish',
      settingsUrl: MAC_SETTINGS.screenRecording,
      restart: true
    })
  } else if (platform === 'linux') {
    const session = linux?.sessionType ?? 'unknown'
    add({
      key: 'displayServer',
      label: session === 'wayland' ? 'Wayland session' : session === 'x11' ? 'X11 session' : 'Display server',
      state: session === 'x11' ? 'ok' : session === 'wayland' ? 'partial' : 'unknown',
      blocks:
        session === 'wayland'
          ? 'background (pointer-free) input on most compositors; foreground input and captures still work through XWayland or the desktop portal'
          : 'nothing',
      fix:
        session === 'wayland'
          ? `Compositor: ${linux?.desktop ?? 'unknown'}. GNOME 47+ and KDE 6+ can grant remote-desktop access through the portal prompt; otherwise Wolffish uses foreground input (your pointer moves briefly).`
          : 'none needed',
      restart: false
    })
    add({
      key: 'uinput',
      label: 'Virtual input device (/dev/uinput)',
      state: linux?.uinput === true ? 'ok' : linux?.uinput === false ? 'partial' : 'unknown',
      blocks: 'a second, independent pointer for background clicks on X11',
      fix: 'add your user to the input group or a udev rule granting write access to /dev/uinput, then log out and in',
      restart: false
    })
    add({
      key: 'atspi',
      label: 'Accessibility bus (AT-SPI)',
      state: linux?.atspi === true ? 'ok' : linux?.atspi === false ? 'partial' : 'unknown',
      blocks: 'finding elements by name and reading fields; pixels still work',
      fix: 'install at-spi2-core and make sure the accessibility bus runs in your session',
      restart: false
    })
  } else if (platform === 'win32') {
    add({
      key: 'elevation',
      label: 'Elevated (administrator) windows',
      state: windows?.elevated === true ? 'ok' : 'partial',
      blocks: 'input into windows that run as administrator when Wolffish does not (Windows blocks lower-integrity senders)',
      fix: 'run Wolffish as administrator only if you need to drive an elevated app; everything else works as is',
      restart: false
    })
  }

  add({
    key: 'driver',
    label: 'Background input driver',
    state: driver?.available ? 'ok' : 'partial',
    blocks: driver?.available
      ? 'nothing'
      : 'pointer-free input and window captures; Wolffish falls back to moving your real pointer for every action',
    fix: driver?.available
      ? 'none needed'
      : `the native driver could not load${driver?.error ? ` (${driver.error})` : ''}; it installs with the capability on first use and needs network access once`,
    restart: false
  })

  add({
    key: 'indicator',
    label: 'Screen indicator (glow and shadow cursor)',
    state: overlayAvailable === false ? 'partial' : 'ok',
    blocks: overlayAvailable === false ? 'the visible indicator only; capture and input still work' : 'nothing',
    fix: overlayAvailable === false ? 'the overlay window could not be created on this display; the model tells the user when that happens' : 'none needed',
    restart: false
  })

  const missing = items.filter((i) => i.state === 'missing')
  const partial = items.filter((i) => i.state === 'partial')
  const ok = missing.length === 0
  const lines = []
  lines.push(
    ok
      ? `Computer use is ready on ${platformName(platform)}${partial.length > 0 ? ' with limits' : ''}.`
      : `Computer use is BLOCKED on ${platformName(platform)}: ${missing.map((m) => m.label).join(', ')} not granted.`
  )
  for (const i of items) {
    const mark = i.state === 'ok' ? 'granted' : i.state === 'missing' ? 'MISSING' : i.state === 'partial' ? 'limited' : 'unknown'
    let line = `- ${i.label}: ${mark}.`
    if (i.state !== 'ok') {
      line += ` Blocks: ${i.blocks}. Fix: ${i.fix}.`
      if (i.restart) line += ' Restart Wolffish after granting it.'
    }
    lines.push(line)
  }
  if (!ok) {
    lines.push(
      'Do not retry capture or input tools until the missing grant is in place — they fail the same way every time. ' +
        'Tell the user exactly which setting to enable (use ask_user so they can say when it is done), finish any part of the task that does not need the screen, then continue.'
    )
  }
  return { ok, platform, items, text: lines.join('\n') }
}

export function platformName(platform) {
  return platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : platform
}

/** Live probes. Never throws. */
export async function probeAccess({ electron, driverStatus, macPermissions }) {
  const platform = process.platform
  const out = { platform, driver: driverStatus, mac: null, linux: null, windows: null }
  if (platform === 'darwin') {
    let accessibility = null
    let screenRecording = null
    try {
      accessibility = electron?.systemPreferences?.isTrustedAccessibilityClient?.(false) ?? null
      const status = electron?.systemPreferences?.getMediaAccessStatus?.('screen')
      screenRecording = status ? status === 'granted' : null
    } catch {
      // Not in Electron.
    }
    if ((accessibility == null || screenRecording == null) && macPermissions) {
      accessibility = accessibility ?? macPermissions.accessibility ?? null
      screenRecording = screenRecording ?? macPermissions.screenRecording ?? null
    }
    out.mac = { accessibility, screenRecording }
  } else if (platform === 'linux') {
    const env = process.env
    const sessionType = env.WAYLAND_DISPLAY ? 'wayland' : env.DISPLAY ? 'x11' : env.XDG_SESSION_TYPE ?? 'unknown'
    let uinput = null
    try {
      await fs.access('/dev/uinput', fs.constants?.W_OK ?? 2)
      uinput = true
    } catch {
      uinput = false
    }
    let atspi = null
    try {
      atspi = !!(env.AT_SPI_BUS_ADDRESS || env.DBUS_SESSION_BUS_ADDRESS)
    } catch {
      atspi = null
    }
    out.linux = { sessionType, desktop: env.XDG_CURRENT_DESKTOP ?? env.DESKTOP_SESSION ?? null, uinput, atspi }
  } else if (platform === 'win32') {
    out.windows = { elevated: null }
  }
  return out
}
