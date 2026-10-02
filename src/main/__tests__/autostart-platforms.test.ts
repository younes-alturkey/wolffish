/**
 * Autostart + CLI-shim behaviour on all three platforms, from one machine.
 *
 * The interesting failures here are platform-shaped and none of them throw:
 * a mechanism chosen for the wrong OS, a unit file the service manager will
 * not parse, a shim whose quoting breaks on a path with a space. So this
 * exercises the real modules with `process.platform` and `os.homedir()`
 * swapped, writes into a temp HOME, and asserts on the ARTIFACTS — the exact
 * bytes systemd, launchd, Task Scheduler and the shell will read.
 *
 * Runs with WOLFFISH_AUTOSTART_DRY_RUN=1, so it writes files and never invokes
 * a service manager. Faking os.homedir() is not enough on its own: launchctl,
 * systemctl and schtasks address the REAL user domain whatever path you hand
 * them, so without the flag this test registers things on the machine running
 * it.
 *
 * What it cannot cover, and what still needs a real box: whether systemd
 * actually starts the unit, whether launchd honours the plist, and whether
 * schtasks accepts the /tr string. Those are asserted structurally here and
 * flagged as unverified.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *        src/main/__tests__/autostart-platforms.test.ts
 */
// Set BEFORE the modules load: the flag is read at import time, and without
// it this test talks to the real launchctl/systemctl/schtasks. It did once —
// bootstrapping a KeepAlive LaunchAgent into the live user domain from a temp
// HOME, which then relaunched the installed app on every quit and outlived the
// temp plist, so nothing on disk explained the behaviour.
process.env.WOLFFISH_AUTOSTART_DRY_RUN = '1'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let passed = 0
let failed = 0

function check(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`PASS  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Swap process.platform + os.homedir for the duration of one case.
 *
 * AWAITS the callback. An earlier version restored the platform in a
 * synchronous `finally`, which returned the real platform the moment the
 * subject hit its first `await` — so any code that re-read `process.platform`
 * after an await saw darwin regardless of what the case asked for. That is
 * exactly what `installCliPath` does (it mkdirs, then picks the shim body),
 * and the test reported PASS on a Windows case that had written a POSIX shim.
 * A harness that silently tests the wrong thing is worse than no harness.
 */
async function asPlatform<T>(
  platform: NodeJS.Platform,
  home: string,
  fn: () => T | Promise<T>
): Promise<T> {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalHome = os.homedir
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  ;(os as { homedir: () => string }).homedir = () => home
  try {
    return await fn()
  } finally {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    ;(os as { homedir: () => string }).homedir = originalHome
  }
}

// The shim install also puts its folder on PATH. File writes land in the faked
// homes below; the Windows user-PATH write (powershell) is skipped under this.
process.env.WOLFFISH_CLI_PATH_DRY_RUN = '1'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-autostart-'))

async function main(): Promise<void> {
  const autostart = await import('@main/autostart/autostart')
  const cliPath = await import('@main/autostart/cli-path')

  // ── mechanism dispatch ────────────────────────────────────────────────────
  const matrix: Array<[NodeJS.Platform, 'gui' | 'headless', string]> = [
    ['darwin', 'gui', 'loginItem'],
    ['darwin', 'headless', 'launchd'],
    ['win32', 'gui', 'loginItem'],
    ['win32', 'headless', 'schtasks'],
    ['linux', 'gui', 'xdg'],
    ['linux', 'headless', 'systemd']
  ]
  for (const [platform, mode, expected] of matrix) {
    const actual = await asPlatform(platform, TMP, () => autostart.autostartMechanism(mode))
    check(`${platform}/${mode} → ${expected}`, () => assert.equal(actual, expected))
  }

  // The GUI path on macOS/Windows must stay Electron's login item — that is
  // the behaviour that already ships and is known to work, and the whole
  // rewrite is only allowed to ADD to it.
  const guiMechanisms = await Promise.all(
    (['darwin', 'win32'] as NodeJS.Platform[]).map((platform) =>
      asPlatform(platform, TMP, () => autostart.autostartMechanism('gui'))
    )
  )
  check('gui on darwin/win32 never leaves the login item', () => {
    assert.deepEqual(guiMechanisms, ['loginItem', 'loginItem'])
  })

  // DISPLAY is a property of this process's environment, not of the machine.
  // A desktop install relaunched without it must not silently switch
  // mechanisms and orphan the registration it wrote last time.
  const savedDisplay = { d: process.env.DISPLAY, w: process.env.WAYLAND_DISPLAY }
  delete process.env.DISPLAY
  delete process.env.WAYLAND_DISPLAY
  const blindGui = await asPlatform('linux', TMP, () => autostart.autostartMechanism('gui'))
  if (savedDisplay.d !== undefined) process.env.DISPLAY = savedDisplay.d
  if (savedDisplay.w !== undefined) process.env.WAYLAND_DISPLAY = savedDisplay.w
  check('a missing DISPLAY does not flip a gui install to systemd', () => {
    assert.equal(blindGui, 'xdg')
  })

  // ── Linux: the XDG autostart entry ────────────────────────────────────────
  const linuxHome = path.join(TMP, 'linux')
  fs.mkdirSync(linuxHome, { recursive: true })
  const savedXdg = process.env.XDG_CONFIG_HOME
  delete process.env.XDG_CONFIG_HOME
  await asPlatform('linux', linuxHome, () =>
    autostart.installAutostart('gui', '/opt/Wolffish/wolffish')
  )

  const desktopFile = path.join(linuxHome, '.config', 'autostart', 'wolffish.desktop')
  check('linux desktop: writes ~/.config/autostart/wolffish.desktop', () => {
    assert.ok(fs.existsSync(desktopFile), `${desktopFile} missing`)
  })
  check('linux desktop: entry is a valid Desktop Entry', () => {
    const body = fs.readFileSync(desktopFile, 'utf8')
    assert.ok(body.startsWith('[Desktop Entry]'), 'must start with the group header')
    for (const key of ['Type=Application', 'Exec=', 'Name=Wolffish', 'Terminal=false']) {
      assert.ok(body.includes(key), `missing ${key}`)
    }
    // GNOME skips entries without this; KDE ignores it. Harmless either way.
    assert.ok(body.includes('X-GNOME-Autostart-enabled=true'))
  })
  check('linux desktop: the entry launches unsandboxed, so root can use it too', () => {
    const body = fs.readFileSync(desktopFile, 'utf8')
    const exec = body.split('\n').find((line) => line.startsWith('Exec='))
    assert.ok(exec?.includes('--no-sandbox'), `root would abort before startup: ${exec}`)
  })
  check('linux desktop: entry is executable (some sessions require it)', () => {
    assert.ok((fs.statSync(desktopFile).mode & 0o111) !== 0, 'exec bit not set')
  })
  await asPlatform('linux', linuxHome, () => autostart.uninstallAutostart('gui'))
  // Restored only now, after the UNINSTALL. Putting it back before that line
  // left the removal reading the real XDG_CONFIG_HOME on any machine that sets
  // one: the temp entry survived (so this case failed) and the delete landed on
  // the developer's own autostart entry instead.
  if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg
  check('linux desktop: uninstall removed the entry', () => {
    assert.ok(!fs.existsSync(desktopFile), 'entry survived uninstall')
  })

  // ── Linux: the systemd user unit ──────────────────────────────────────────
  const serverHome = path.join(TMP, 'server')
  fs.mkdirSync(serverHome, { recursive: true })
  // installAutostart also shells out to systemctl/loginctl; those fail on this
  // machine and are caught, which is exactly the degraded path a non-systemd
  // box takes. The FILE is what this asserts.
  await asPlatform('linux', serverHome, () =>
    autostart.installAutostart('headless', '/opt/Wolffish/wolffish')
  )
  const unitFile = path.join(serverHome, '.config', 'systemd', 'user', 'wolffish.service')
  check('linux server: writes the systemd user unit', () => {
    assert.ok(fs.existsSync(unitFile), `${unitFile} missing`)
  })
  check('linux server: unit has the three sections systemd requires', () => {
    const body = fs.readFileSync(unitFile, 'utf8')
    for (const section of ['[Unit]', '[Service]', '[Install]']) {
      assert.ok(body.includes(section), `missing ${section}`)
    }
    // --no-sandbox is load-bearing, not cosmetic: Chromium aborts as root
    // before any of the app's code runs, and a systemd unit on a VPS is
    // usually root's. Without it the unit installs, reports healthy, and the
    // service dies on every start with a FATAL only the journal sees.
    assert.ok(
      body.includes('ExecStart=/opt/Wolffish/wolffish --headless --no-sandbox'),
      `wrong ExecStart:\n${body}`
    )
    assert.ok(body.includes('Restart=always'), 'a crashed agent must come back')
    assert.ok(body.includes('WantedBy=default.target'), 'must be enable-able')
    // Without this the daemon starts with no idea it is headless.
    assert.ok(body.includes('Environment=WOLFFISH_HEADLESS=1'))
  })
  check('linux server: unit key=value lines are well formed', () => {
    const body = fs.readFileSync(unitFile, 'utf8')
    for (const line of body.split('\n')) {
      const text = line.trim()
      if (!text || text.startsWith('#') || text.startsWith('[')) continue
      assert.ok(/^[A-Za-z]+=/.test(text), `not a systemd directive: ${text}`)
    }
  })

  // ── macOS: the LaunchAgent plist ──────────────────────────────────────────
  const macHome = path.join(TMP, 'mac')
  fs.mkdirSync(macHome, { recursive: true })
  await asPlatform('darwin', macHome, () =>
    autostart.installAutostart('headless', '/Applications/Wolffish.app/Contents/MacOS/Wolffish')
  )
  const plistFile = path.join(macHome, 'Library', 'LaunchAgents', 'sh.wolffi.app.plist')
  check('macos server: writes the LaunchAgent plist', () => {
    assert.ok(fs.existsSync(plistFile), `${plistFile} missing`)
  })
  check('macos server: plist is well-formed XML with the required keys', () => {
    const body = fs.readFileSync(plistFile, 'utf8')
    assert.ok(body.startsWith('<?xml'), 'missing XML declaration')
    assert.ok(body.includes('<!DOCTYPE plist'), 'missing DOCTYPE')
    for (const key of ['Label', 'ProgramArguments', 'RunAtLoad', 'KeepAlive']) {
      assert.ok(body.includes(`<key>${key}</key>`), `missing <key>${key}</key>`)
    }
    assert.ok(body.includes('<string>--headless</string>'), 'missing the headless flag')
    // Every opened tag closed — catches a truncated or mis-nested template.
    const open = (body.match(/<(dict|array|plist)(\s[^>]*)?>/g) ?? []).length
    const close = (body.match(/<\/(dict|array|plist)>/g) ?? []).length
    assert.equal(open, close, 'unbalanced plist tags')
  })

  // ── launchd status distinguishes "written" from "loaded" ──────────────────
  // Under dry-run the file IS the answer (asking launchctl would report on the
  // real machine, not the temp one). What this asserts is that a plist which
  // was never bootstrapped does not read as active on the strength of merely
  // existing, and that removing it flips the answer back.
  const statusHome = path.join(TMP, 'launchd-status')
  fs.mkdirSync(statusHome, { recursive: true })
  const beforeInstall = await asPlatform('darwin', statusHome, () =>
    autostart.autostartStatus('headless')
  )
  check('macos: no plist → not active', () => {
    assert.equal(beforeInstall.active, false)
    assert.equal(beforeInstall.mechanism, 'launchd')
  })
  await asPlatform('darwin', statusHome, () =>
    autostart.installAutostart('headless', '/Applications/Wolffish.app/Contents/MacOS/Wolffish')
  )
  const afterInstall = await asPlatform('darwin', statusHome, () =>
    autostart.autostartStatus('headless')
  )
  check('macos: plist present → active', () => assert.equal(afterInstall.active, true))
  await asPlatform('darwin', statusHome, () => autostart.uninstallAutostart('headless'))
  const afterRemove = await asPlatform('darwin', statusHome, () =>
    autostart.autostartStatus('headless')
  )
  check('macos: uninstall removes the plist and clears active', () => {
    assert.equal(afterRemove.active, false)
    assert.ok(
      !fs.existsSync(path.join(statusHome, 'Library', 'LaunchAgents', 'sh.wolffi.app.plist')),
      'plist survived uninstall'
    )
  })

  // Switching mechanisms must be reversible on every platform — a user who
  // tries the background service has to be able to get back. Each pair
  // installs one mechanism, then the other, and asserts the first is gone:
  // two registrations racing to launch the app is the failure this rules out.
  const reversible: Array<[NodeJS.Platform, string, string]> = [
    ['darwin', 'Library/LaunchAgents/sh.wolffi.app.plist', 'login item'],
    ['linux', '.config/systemd/user/wolffish.service', '.desktop entry']
  ]
  for (const [platform, headlessArtifact] of reversible) {
    const home = path.join(TMP, `reversible-${platform}`)
    fs.mkdirSync(home, { recursive: true })
    await asPlatform(platform, home, () => autostart.installAutostart('headless', '/bin/wolffish'))
    const artifact = path.join(home, headlessArtifact)
    check(`${platform}: headless registration is written`, () => {
      assert.ok(fs.existsSync(artifact), `${artifact} missing`)
    })
    await asPlatform(platform, home, () => autostart.uninstallAutostart('headless'))
    check(`${platform}: switching away removes it — no two registrations`, () => {
      assert.ok(!fs.existsSync(artifact), `${artifact} survived — would double-launch`)
    })
  }

  // ── the CLI shim, all three platforms ─────────────────────────────────────
  // One directory on every platform: ~/.wolffish/bin, the same managed bin the
  // app already uses for gog, ffmpeg and the voice engines. Asserted per
  // platform rather than assumed, because the split it replaces (POSIX in
  // ~/.local/bin, Windows in ~/.wolffish/bin) is exactly the kind of drift
  // that reads as intentional until someone checks.
  const shimCases: Array<[NodeJS.Platform, string, string]> = [
    ['darwin', path.join(TMP, 'shim-mac'), '.wolffish/bin/wolffish'],
    ['linux', path.join(TMP, 'shim-linux'), '.wolffish/bin/wolffish'],
    ['win32', path.join(TMP, 'shim-win'), '.wolffish/bin/wolffish.cmd']
  ]
  for (const [platform, home, relative] of shimCases) {
    fs.mkdirSync(home, { recursive: true })
    await asPlatform(platform, home, () =>
      cliPath.installCliPath(
        platform === 'win32'
          ? 'C:\\Users\\a b\\AppData\\Local\\Programs\\Wolffish\\wolffish.exe'
          : '/Applications/Wolffish.app/Contents/MacOS/Wolffish',
        platform === 'win32'
          ? 'C:\\Users\\a b\\resources\\cli\\wolffish-cli-win32-x64.exe'
          : '/res/cli/wolffish-cli-darwin-arm64'
      )
    )
    const shim = path.join(home, relative)
    check(`${platform}: shim lands at ~/${relative}`, () => {
      assert.ok(fs.existsSync(shim), `${shim} missing`)
    })
    check(`${platform}: shim runs the compiled client and names the app for autostart`, () => {
      const body = fs.readFileSync(shim, 'utf8')
      assert.ok(!body.includes('ELECTRON_RUN_AS_NODE'), 'the client is its own binary now')
      assert.ok(body.includes('WOLFFISH_EXEC='), 'the client needs the app path to start a daemon')
      assert.ok(body.includes('wolffish-cli'), 'must reach the compiled client')
    })
    if (platform === 'win32') {
      check('windows: shim is a console-subsystem .cmd that preserves the exit code', () => {
        const body = fs.readFileSync(shim, 'utf8')
        assert.ok(body.startsWith('@echo off'), 'must not echo its own lines')
        assert.ok(body.includes('%*'), 'must forward arguments')
        assert.ok(body.includes('%ERRORLEVEL%'), 'must propagate the exit code for scripting')
        assert.ok(body.includes('\r\n'), 'a .cmd needs CRLF line endings')
      })
      check('windows: a path containing a space stays quoted', () => {
        const body = fs.readFileSync(shim, 'utf8')
        assert.ok(body.includes('"C:\\Users\\a b\\'), 'unquoted path with a space would break')
      })
    } else {
      check(`${platform}: shim is an executable POSIX script`, () => {
        const body = fs.readFileSync(shim, 'utf8')
        assert.ok(body.startsWith('#!/bin/sh'), 'missing shebang')
        assert.ok(body.includes('exec '), 'must exec, not fork — signals have to reach the client')
        assert.ok(body.includes('"$@"'), 'must forward arguments quoted')
        assert.ok((fs.statSync(shim).mode & 0o111) !== 0, 'not executable')
      })
    }
  }

  // ── windows: the shim runs the compiled client directly ───────────────────
  // The app binary is GUI-subsystem: a console that runs it directly gets no
  // usable stdout. The client is a console executable of its own (built with
  // Bun), so the .cmd hands over to it and never invokes the app itself.
  const launcherHome = path.join(TMP, 'launcher-home')
  const launcherInstall = path.join(TMP, 'launcher-install')
  fs.mkdirSync(launcherHome, { recursive: true })
  fs.mkdirSync(path.join(launcherInstall, 'resources', 'cli'), { recursive: true })
  const winBinary = path.join(launcherInstall, 'resources', 'cli', 'wolffish-cli-win32-x64.exe')
  fs.writeFileSync(winBinary, 'MZ')
  await asPlatform('win32', launcherHome, () =>
    cliPath.installCliPath(path.join(launcherInstall, 'wolffish.exe'), winBinary)
  )
  check('windows: shim runs wolffish-cli-win32-x64.exe, never the GUI binary', () => {
    const body = fs.readFileSync(
      path.join(launcherHome, '.wolffish', 'bin', 'wolffish.cmd'),
      'utf8'
    )
    assert.ok(body.includes('wolffish-cli-win32-x64.exe'), `never reached the client:\n${body}`)
    assert.ok(
      !body.includes('ELECTRON_RUN_AS_NODE'),
      'still starting the GUI binary itself — output would go nowhere'
    )
    assert.ok(body.includes('WOLFFISH_EXEC='), 'the client needs the app path to start a daemon')
    assert.ok(body.includes('%*'), 'must forward arguments')
    assert.ok(body.includes('%ERRORLEVEL%'), 'must propagate the exit code')
  })

  // ── windows: Git Bash needs a shim of its own ─────────────────────────────
  // PATHEXT is a cmd.exe convention. Bash looking for `wolffish` never
  // considers `wolffish.cmd`, so Git Bash users — a large share of Windows
  // developers — got "command not found" with the directory sitting on PATH.
  // Windows therefore writes BOTH: cmd resolves the .cmd and cannot execute
  // the extensionless file, bash resolves the extensionless file and never
  // looks for the .cmd.
  const bashShim = path.join(launcherHome, '.wolffish', 'bin', 'wolffish')
  check('windows: an extensionless shim is written for Git Bash', () => {
    assert.ok(fs.existsSync(bashShim), 'Git Bash would report command not found')
    assert.ok(fs.existsSync(path.join(launcherHome, '.wolffish', 'bin', 'wolffish.cmd')))
  })
  check('windows: the Git Bash shim is a sh script MSYS will execute', () => {
    const body = fs.readFileSync(bashShim, 'utf8')
    // MSYS decides a file is executable from the `#!` magic, not a mode bit
    // NTFS does not really carry — so the shebang is load-bearing here.
    assert.ok(body.startsWith('#!/bin/sh'), 'without the shebang MSYS will not run it')
    assert.ok(body.includes('"$@"'), 'must forward arguments quoted')
    assert.ok(body.includes('wolffish-cli-win32-x64.exe'), 'must reach the compiled client')
  })
  check('windows: the Git Bash shim uses forward slashes', () => {
    const body = fs.readFileSync(bashShim, 'utf8')
    const launcherLine = body
      .split('\n')
      .find((line) => line.includes('wolffish-cli-win32-x64.exe'))
    assert.ok(
      launcherLine && !launcherLine.includes('\\'),
      `a backslash is an escape inside a shell string: ${launcherLine}`
    )
  })
  check('windows: winpty is used for a terminal, never for a pipe', () => {
    const body = fs.readFileSync(bashShim, 'utf8')
    // mintty is a pty over pipes, not a Windows console, so the launcher has
    // no console to hand the child; winpty allocates one. But applying it to a
    // redirect would corrupt `wolffish -p ... | grep`, so it is gated on both
    // ends genuinely being terminals.
    assert.ok(body.includes('winpty'), 'an interactive session would lose colour and prompts')
    assert.ok(body.includes('[ -t 0 ]') && body.includes('[ -t 1 ]'), 'winpty must be gated')
    assert.ok(body.includes('command -v winpty'), 'must degrade where winpty is absent')
  })
  // Through the real uninstall, because removing only the .cmd leaves
  // `wolffish` working in Git Bash and Remove looks like a no-op.
  await asPlatform('win32', launcherHome, () => cliPath.uninstallCliPath())
  check('windows: uninstall removes BOTH shims', () => {
    assert.ok(!fs.existsSync(bashShim), 'Git Bash would still resolve the command')
    assert.ok(!fs.existsSync(path.join(launcherHome, '.wolffish', 'bin', 'wolffish.cmd')))
  })

  // ── windows: the cwd is not a PATH entry ──────────────────────────────────
  // `where.exe` searches the current directory BEFORE PATH, and the app's
  // shortcut starts it in the install root — where the packaged GUI binary is
  // called `wolffish.exe`. So every Windows install resolved the name to a
  // 200 MB executable that is obviously not the shim, and the panel accused a
  // stranger of taking the name while the shim sat on PATH working fine. The
  // cwd here is that install root, exactly as the shortcut leaves it.
  const cwdHome = path.join(TMP, 'cwd-trap')
  const installRoot = path.join(TMP, 'Programs', 'Wolffish')
  fs.mkdirSync(installRoot, { recursive: true })
  fs.mkdirSync(cwdHome, { recursive: true })
  fs.writeFileSync(path.join(installRoot, 'wolffish.exe'), Buffer.alloc(9000))
  const originalCwd = process.cwd()
  const cwdTrapStatus = await asPlatform('win32', cwdHome, async () => {
    await cliPath.installCliPath(path.join(installRoot, 'wolffish.exe'), '/res/cli.mjs')
    const binDir = path.join(cwdHome, '.wolffish', 'bin')
    process.chdir(installRoot)
    try {
      return await cliPath.cliPathStatus(binDir)
    } finally {
      process.chdir(originalCwd)
    }
  })
  check('windows: the shim wins the name even when the cwd holds wolffish.exe', () => {
    assert.equal(
      cwdTrapStatus.resolved,
      path.join(cwdHome, '.wolffish', 'bin', 'wolffish.cmd'),
      'resolved something other than the shim'
    )
    assert.equal(cwdTrapStatus.shadowedBy, null, 'cried wolf about the app shadowing its own CLI')
    assert.ok(cwdTrapStatus.installed, 'reported not-installed for a shim on the caller PATH')
  })

  // ── the footprint rule, and the upgrade sweep ─────────────────────────────
  // "uninstall must be rm -rf ~/.wolffish" is a project hard rule, so the CLI
  // install must not write a single byte outside that tree.
  for (const [platform, home] of [
    ['darwin', path.join(TMP, 'footprint-mac')],
    ['linux', path.join(TMP, 'footprint-linux')],
    ['win32', path.join(TMP, 'footprint-win')]
  ] as Array<[NodeJS.Platform, string]>) {
    fs.mkdirSync(home, { recursive: true })
    await asPlatform(platform, home, () => cliPath.installCliPath('/bin/app', '/res/cli.mjs'))
    check(`${platform}: shim install writes nothing outside ~/.wolffish but the PATH entry`, () => {
      // The one exception: PATH is read from the shell profile or nowhere, so
      // the install leaves a MARKED block there and nothing else.
      const profiles = new Set(['.zshrc', '.bashrc', '.bash_profile', '.profile'])
      const stray = fs.readdirSync(home).filter((entry) => entry !== '.wolffish')
      const other = stray.filter((entry) => !profiles.has(entry))
      assert.deepEqual(other, [], `wrote outside the footprint: ${other.join(', ')}`)
      for (const entry of stray) {
        const body = fs.readFileSync(path.join(home, entry), 'utf8')
        assert.ok(body.includes('Wolffish CLI — added by the app'), `${entry} is not ours`)
      }
    })
  }

  // ── the PATH entry: written by the app, once, removable, never the user's ──
  const savedShell = process.env.SHELL
  process.env.SHELL = '/bin/zsh'
  const entryHome = path.join(TMP, 'path-entry')
  fs.mkdirSync(path.join(entryHome, '.config', 'fish'), { recursive: true })
  fs.writeFileSync(path.join(entryHome, '.zshrc'), '# mine\nexport EDITOR=vim\n')
  const callerPath = '/usr/bin:/bin'
  const entryStatus = await asPlatform('darwin', entryHome, async () => {
    await cliPath.installCliPath('/Applications/Wolffish.app/Contents/MacOS/Wolffish', '/res/cli')
    // A second boot must not stack a second block.
    await cliPath.installCliPath('/Applications/Wolffish.app/Contents/MacOS/Wolffish', '/res/cli')
    return cliPath.cliPathStatus(callerPath)
  })
  check("path entry: the profile gets ONE marked block, after the user's own lines", () => {
    const body = fs.readFileSync(path.join(entryHome, '.zshrc'), 'utf8')
    assert.ok(body.startsWith('# mine\nexport EDITOR=vim\n'), "the user's lines moved")
    assert.equal(body.split('Wolffish CLI — added by the app').length, 2, body)
    assert.ok(body.includes('export PATH="$HOME/.wolffish/bin:$PATH"'), body)
  })
  check('path entry: fish gets its conf.d file when fish is set up', () => {
    const fish = path.join(entryHome, '.config', 'fish', 'conf.d', 'wolffish.fish')
    assert.ok(fs.existsSync(fish), 'no fish entry')
    assert.ok(fs.readFileSync(fish, 'utf8').includes('fish_add_path'))
  })
  check('path entry: status says "open a new terminal", not "add this line"', () => {
    // `resolved` comes from a real login shell, so a machine that already has
    // the command installed for real reads `installed`; either way the manual
    // line is gone and the profile is known to carry the entry.
    assert.ok(entryStatus.installed || entryStatus.needsPathEntry, JSON.stringify(entryStatus))
    assert.equal(entryStatus.profileHasEntry, true)
    assert.equal(entryStatus.profileHint, null, 'no manual line once the app did it')
  })
  const entryAfterRemove = await asPlatform('darwin', entryHome, async () => {
    await cliPath.uninstallCliPath()
    return cliPath.cliPathStatus(callerPath)
  })
  check('path entry: uninstall takes exactly the block back out', () => {
    const body = fs.readFileSync(path.join(entryHome, '.zshrc'), 'utf8')
    assert.ok(body.includes('export EDITOR=vim'), 'deleted a line the user wrote')
    assert.ok(!body.includes('Wolffish CLI'), body)
    assert.ok(!fs.existsSync(path.join(entryHome, '.config', 'fish', 'conf.d', 'wolffish.fish')))
    assert.equal(entryAfterRemove.profileHasEntry, false)
  })
  const bareHome = path.join(TMP, 'path-entry-bare')
  fs.mkdirSync(bareHome, { recursive: true })
  await asPlatform('darwin', bareHome, () =>
    cliPath.installCliPath('/Applications/Wolffish.app/Contents/MacOS/Wolffish', '/res/cli')
  )
  check('path entry: a home with no profile gets the one for $SHELL', () => {
    assert.ok(fs.existsSync(path.join(bareHome, '.zshrc')), 'no .zshrc written for zsh')
    assert.ok(
      !fs.existsSync(path.join(bareHome, '.bashrc')),
      'wrote a profile for a shell not in use'
    )
  })
  const winEntryHome = path.join(TMP, 'path-entry-win')
  fs.mkdirSync(winEntryHome, { recursive: true })
  const winEntry = await asPlatform('win32', winEntryHome, async () => {
    await cliPath.installCliPath(
      'C:\\App\\wolffish.exe',
      'C:\\App\\resources\\cli\\wolffish-cli-win32-x64.exe'
    )
    return cliPath.cliPathStatus('C:\\Windows')
  })
  check('path entry: windows goes through the user PATH, never a profile file', () => {
    const stray = fs.readdirSync(winEntryHome).filter((entry) => entry !== '.wolffish')
    assert.deepEqual(stray, [], `wrote a profile on windows: ${stray.join(', ')}`)
    // Dry run: the registry write is skipped, so the manual line stays offered.
    assert.equal(winEntry.profileHasEntry, false)
    assert.ok(winEntry.profileHint?.includes('setx PATH'), String(winEntry.profileHint))
  })
  process.env.SHELL = savedShell

  // An upgraded machine must not keep the old POSIX shim: ~/.local/bin is
  // typically EARLIER on PATH than ~/.wolffish/bin, so a leftover would keep
  // winning `command -v` and silently run a stale target forever.
  const upgradeHome = path.join(TMP, 'upgrade')
  const legacyDir = path.join(upgradeHome, '.local', 'bin')
  fs.mkdirSync(legacyDir, { recursive: true })
  fs.writeFileSync(
    path.join(legacyDir, 'wolffish'),
    '#!/bin/sh\n# Wolffish CLI launcher — generated by the app\nexec /old/path "$@"\n'
  )
  await asPlatform('darwin', upgradeHome, () =>
    cliPath.installCliPath('/Applications/Wolffish.app/Contents/MacOS/Wolffish', '/res/cli.mjs')
  )
  check('upgrade: the legacy ~/.local/bin shim is swept', () => {
    assert.ok(
      !fs.existsSync(path.join(legacyDir, 'wolffish')),
      'stale shim survived — it would shadow the new one on PATH'
    )
    assert.ok(fs.existsSync(path.join(upgradeHome, '.wolffish', 'bin', 'wolffish')))
  })

  // ...but only when it is recognisably ours. A user's own script at that
  // path is not the app's to delete.
  const foreignHome = path.join(TMP, 'foreign')
  const foreignDir = path.join(foreignHome, '.local', 'bin')
  fs.mkdirSync(foreignDir, { recursive: true })
  fs.writeFileSync(path.join(foreignDir, 'wolffish'), '#!/bin/sh\necho my own script\n')
  await asPlatform('darwin', foreignHome, () =>
    cliPath.installCliPath('/Applications/Wolffish.app/Contents/MacOS/Wolffish', '/res/cli.mjs')
  )
  check("upgrade: a user's own file at the legacy path is left alone", () => {
    assert.ok(
      fs.existsSync(path.join(foreignDir, 'wolffish')),
      'deleted a file the app did not write'
    )
  })

  // ── AppImage: recording a path that outlives the process ──────────────────
  // An AppImage runs from /tmp/.mount_WolffiXXXXXX, deleted on exit and named
  // differently on every launch. Everything written here is READ LATER — the
  // shim by a shell, the unit by systemd at next boot — so naming the mount
  // produces artifacts that are broken before they are first used, while
  // looking correct to the process that wrote them. The .AppImage is the
  // stable name, and the client has to be lifted out of the mount entirely
  // because no string outside can address a file inside it.
  const appImageHome = path.join(TMP, 'appimage')
  const mount = path.join(TMP, '.mount_Wolffi123456')
  const mountCli = path.join(mount, 'resources', 'cli')
  fs.mkdirSync(path.join(mountCli, 'lib'), { recursive: true })
  fs.mkdirSync(appImageHome, { recursive: true })
  fs.writeFileSync(path.join(mountCli, 'wolffish-cli-linux-x64'), 'ELF', { mode: 0o755 })
  fs.writeFileSync(path.join(mountCli, 'lib', 'client.mjs'), 'export const connect = () => {}\n')

  const savedAppImage = process.env.APPIMAGE
  process.env.APPIMAGE = path.join(appImageHome, '.wolffish', 'Wolffish.AppImage')

  await asPlatform('linux', appImageHome, () =>
    cliPath.installCliPath(
      path.join(mount, 'wolffish-app'),
      path.join(mountCli, 'wolffish-cli-linux-x64')
    )
  )
  const appImageShim = fs.readFileSync(
    path.join(appImageHome, '.wolffish', 'bin', 'wolffish'),
    'utf8'
  )
  check('appimage: the shim names the .AppImage, not the mount it is running from', () => {
    assert.ok(appImageShim.includes('Wolffish.AppImage'), `named nothing stable:\n${appImageShim}`)
    assert.ok(!appImageShim.includes(mount), 'recorded a path that dies with this process')
  })
  check('appimage: the client is lifted out of the mount, imports included', () => {
    const copied = path.join(appImageHome, '.wolffish', 'cli', 'wolffish-cli-linux-x64')
    assert.ok(fs.existsSync(copied), 'client not copied out')
    assert.ok(
      fs.existsSync(path.join(appImageHome, '.wolffish', 'cli', 'lib', 'client.mjs')),
      'copied the entry but not what it imports — the shim would die on first import'
    )
    assert.ok(appImageShim.includes(copied), `shim does not name the copy:\n${appImageShim}`)
  })
  check('appimage: the copy respects the rm -rf ~/.wolffish rule', () => {
    // The shell profile carries the PATH entry (see the footprint checks
    // above) — whichever one $SHELL picks on the machine running this.
    const profiles = new Set(['.zshrc', '.bashrc', '.bash_profile', '.profile'])
    const stray = fs
      .readdirSync(appImageHome)
      .filter((entry) => entry !== '.wolffish' && !profiles.has(entry))
    assert.deepEqual(stray, [], `wrote outside the footprint: ${stray.join(', ')}`)
  })
  check('appimage: a mounted launch does not make the shim self-extract', () => {
    assert.ok(
      !appImageShim.includes('APPIMAGE_EXTRACT_AND_RUN'),
      'unpacks ~600 MB on every command for a machine that can mount fine'
    )
  })

  // A box with no /dev/fuse — a container started without the device — can only
  // run an AppImage by unpacking it, and the installer bakes that into the
  // launcher it writes. The shim has to reach the same conclusion or `wolffish`
  // fails on exactly the machines the installer just got working. It does not
  // re-derive it: this process running at all is proof of a launch that worked.
  const extractHome = path.join(TMP, 'appimage-extract')
  fs.mkdirSync(extractHome, { recursive: true })
  process.env.APPIMAGE = path.join(extractHome, '.wolffish', 'Wolffish.AppImage')
  process.env.APPIMAGE_EXTRACT_AND_RUN = '1'
  await asPlatform('linux', extractHome, () =>
    cliPath.installCliPath(
      path.join(mount, 'wolffish-app'),
      path.join(mountCli, 'wolffish-cli-linux-x64')
    )
  )
  delete process.env.APPIMAGE_EXTRACT_AND_RUN
  check('appimage: a self-extracting launch is carried into the shim', () => {
    const body = fs.readFileSync(path.join(extractHome, '.wolffish', 'bin', 'wolffish'), 'utf8')
    assert.ok(
      body.includes('APPIMAGE_EXTRACT_AND_RUN=1 exec'),
      `shim would try to mount on a box that cannot:\n${body}`
    )
  })

  // The same answer has to reach the two files a service manager reads at boot,
  // in the syntax each of them speaks — or autostart registers cleanly and the
  // agent never comes back after a reboot.
  process.env.APPIMAGE_EXTRACT_AND_RUN = '1'
  const extractSvc = path.join(TMP, 'appimage-extract-svc')
  fs.mkdirSync(extractSvc, { recursive: true })
  await asPlatform('linux', extractSvc, () =>
    autostart.installAutostart('headless', path.join(mount, 'wolffish-app'))
  )
  // Faking os.homedir() is not enough for the XDG entry: xdgPath() reads
  // XDG_CONFIG_HOME first, so on a machine that sets it this case would assert
  // against a file that was never written — and would write a real autostart
  // entry, pointing at a /tmp mount, into the developer's own session.
  const savedXdgSvc = process.env.XDG_CONFIG_HOME
  delete process.env.XDG_CONFIG_HOME
  await asPlatform('linux', extractSvc, () =>
    autostart.installAutostart('gui', path.join(mount, 'wolffish-app'))
  )
  if (savedXdgSvc !== undefined) process.env.XDG_CONFIG_HOME = savedXdgSvc
  delete process.env.APPIMAGE_EXTRACT_AND_RUN
  check('appimage: the systemd unit carries the self-extract environment', () => {
    const body = fs.readFileSync(
      path.join(extractSvc, '.config', 'systemd', 'user', 'wolffish.service'),
      'utf8'
    )
    assert.ok(
      body.includes('Environment=APPIMAGE_EXTRACT_AND_RUN=1'),
      `the unit cannot mount and will fail at every boot:\n${body}`
    )
    for (const line of body.split('\n')) {
      const text = line.trim()
      if (!text || text.startsWith('#') || text.startsWith('[')) continue
      assert.ok(/^[A-Za-z]+=/.test(text), `not a systemd directive: ${text}`)
    }
  })
  check('appimage: the XDG entry carries it as env, not as a bare assignment', () => {
    const body = fs.readFileSync(
      path.join(extractSvc, '.config', 'autostart', 'wolffish.desktop'),
      'utf8'
    )
    const exec = body.split('\n').find((line) => line.startsWith('Exec='))
    assert.ok(
      exec?.startsWith('Exec=env APPIMAGE_EXTRACT_AND_RUN=1 '),
      `a NAME=VALUE prefix would be read as the program to run: ${exec}`
    )
  })

  // systemd reads this file at NEXT boot, when the mount is long gone. This is
  // the failure that registers successfully, reports itself healthy, and then
  // never starts the app again — with the reason only in the journal.
  const appImageUnitHome = path.join(TMP, 'appimage-unit')
  fs.mkdirSync(appImageUnitHome, { recursive: true })
  await asPlatform('linux', appImageUnitHome, () =>
    autostart.installAutostart('headless', path.join(mount, 'wolffish-app'))
  )
  check('appimage: the systemd unit starts the .AppImage, not the mount', () => {
    const body = fs.readFileSync(
      path.join(appImageUnitHome, '.config', 'systemd', 'user', 'wolffish.service'),
      'utf8'
    )
    assert.ok(
      body.includes(`ExecStart=${process.env.APPIMAGE} --headless --no-sandbox`),
      `wrong ExecStart:\n${body}`
    )
    assert.ok(!body.includes(mount), 'unit names a mount that will not exist at boot')
  })

  if (savedAppImage === undefined) delete process.env.APPIMAGE
  else process.env.APPIMAGE = savedAppImage

  // ...and a native install is untouched by any of it: /opt is a real
  // directory, so there is nothing to copy and nothing to redirect.
  const nativeHome = path.join(TMP, 'native')
  fs.mkdirSync(nativeHome, { recursive: true })
  await asPlatform('linux', nativeHome, () =>
    cliPath.installCliPath(
      '/opt/Wolffish/wolffish-app',
      '/opt/Wolffish/resources/cli/wolffish-cli-linux-x64'
    )
  )
  check('native install: no client copy, shim points straight into /opt', () => {
    assert.ok(
      !fs.existsSync(path.join(nativeHome, '.wolffish', 'cli')),
      'copied the client on an install whose paths are already stable'
    )
    const body = fs.readFileSync(path.join(nativeHome, '.wolffish', 'bin', 'wolffish'), 'utf8')
    assert.ok(body.includes('/opt/Wolffish/resources/cli'), body)
  })

  // ── what the CLI is allowed to believe about its own stdio ────────────────
  // On packaged Windows the CLI runs GUI-subsystem and is not attached to a
  // console, so libuv leaves every isTTY undefined even while the user is
  // typing at it. wolffish-cli.exe passes the truth in as environment; these
  // helpers are the only place that is read.
  const tty = await import('../../cli/lib/tty.mjs')
  const ttyEnvKeys = ['WOLFFISH_TTY_STDIN', 'WOLFFISH_TTY_STDOUT', 'COLUMNS']
  const savedTtyEnv: Record<string, string | undefined> = {}
  for (const key of ttyEnvKeys) {
    savedTtyEnv[key] = process.env[key]
    delete process.env[key]
  }

  check('stdio: with no launcher env, nothing is claimed to be a terminal', () => {
    // This test process is itself piped, so isTTY is false throughout.
    assert.equal(tty.stdoutIsTty(), false)
    assert.equal(tty.stdinIsTty(), false)
  })

  process.env.WOLFFISH_TTY_STDOUT = '1'
  process.env.WOLFFISH_TTY_STDIN = '1'
  process.env.COLUMNS = '137'
  check('stdio: the launcher can say what libuv cannot work out', () => {
    assert.equal(tty.stdoutIsTty(), true, 'colour and spinners would stay off')
    assert.equal(tty.stdinIsTty(), true, 'every prompt would refuse to prompt')
    assert.equal(tty.terminalColumns(), 137, 'width would fall back to a guess')
  })
  check('stdio: raw mode is never claimed — the launcher feeds a pipe', () => {
    // The distinction that keeps setRawMode from throwing: stdin is readable
    // and interactive, but it is not a TTY stream and never will be.
    assert.equal(tty.stdinIsRawCapable(), false)
  })
  for (const key of ttyEnvKeys) {
    if (savedTtyEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedTtyEnv[key]
  }

  // `type log.txt | wolffish -p "why?"` — the documented usage — dropped the
  // file on Windows and asked the model an empty question, because Node does
  // not define S_IFIFO there and so `stat.isFIFO()` is false for every pipe
  // that has ever existed. The mode bits are right on both platforms.
  check('stdio: a pipe is recognised by mode, not by the unusable isFIFO()', () => {
    assert.equal(tty.modeIsFifo(0o010000), true, 'a real cmd pipe mode')
    assert.equal(tty.modeIsFifo(0o100666), false, 'a redirected file is not a pipe')
    assert.equal(tty.modeIsFifo(0o020666), false, 'a console char device is not a pipe')
  })

  // ── no glyph may skip the transliteration chokepoint ──────────────────────
  // `safe()` and the `g` proxy exist so a legacy console never receives a byte
  // it cannot draw — but they only protect text that goes THROUGH them. A
  // literal glyph written straight to a stream, or baked into a readline
  // prompt, bypasses both silently.
  //
  // This is asserted at the source because it bit twice in one sitting: the
  // session prompt was a literal '›' (printing `ÔÇ║` as the only thing on
  // screen), and fixing the one on createInterface left two more in
  // applyPrompt — which are the ones that actually repaint.
  const cliRoot = path.join(import.meta.dirname, '..', '..', 'cli')
  function mjsFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return mjsFiles(full)
      return entry.name.endsWith('.mjs') ? [full] : []
    })
  }
  const RAW_GLYPH = [
    // a prompt handed to readline, or a direct stream write, holding a literal
    // character outside ASCII
    /(?:setPrompt|prompt:|process\.std(?:out|err)\.write)\(\s*(['"`])((?:(?!\1)[\s\S])*?)\1/g
  ]
  const offenders: string[] = []
  for (const file of mjsFiles(cliRoot)) {
    const body = fs.readFileSync(file, 'utf8')
    for (const pattern of RAW_GLYPH) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(body)) !== null) {
        // eslint-disable-next-line no-control-regex
        if (/[^\x00-\x7f]/.test(match[2])) {
          offenders.push(`${path.relative(cliRoot, file)}: ${match[0].slice(0, 60)}`)
        }
      }
    }
  }
  check('glyphs: no literal non-ASCII in a prompt or a direct stream write', () => {
    assert.deepEqual(
      offenders,
      [],
      `these bypass safe()/g and will print mojibake:\n${offenders.join('\n')}`
    )
  })

  // ── the CLI's console-capability detection ────────────────────────────────
  // Windows is the whole reason this exists: a legacy conhost on codepage 437
  // receives Node's UTF-8 and prints mojibake, and a console font without
  // braille prints boxes. The bias is toward ASCII — it always renders, and
  // mojibake never does — so anything NOT known to cope gets the ASCII set.
  const ui = await import('../../cli/lib/ui.mjs')
  const detect: Array<[NodeJS.Platform, Record<string, string>, boolean, string]> = [
    ['darwin', {}, true, 'macOS draws everything'],
    ['linux', {}, true, 'Linux draws everything'],
    ['win32', {}, false, 'plain Windows falls back to ASCII'],
    ['win32', { WT_SESSION: '1' }, true, 'Windows Terminal announces itself'],
    ['win32', { TERM_PROGRAM: 'vscode' }, true, 'the VS Code terminal copes'],
    ['win32', { WOLFFISH_UNICODE: '1' }, true, 'an explicit opt-in wins'],
    ['darwin', { WOLFFISH_UNICODE: '0' }, false, 'an explicit opt-out wins']
  ]
  for (const [platform, env, want, why] of detect) {
    const saved: Record<string, string | undefined> = {}
    for (const key of ['WT_SESSION', 'TERM_PROGRAM', 'WOLFFISH_UNICODE']) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    Object.assign(process.env, env)
    const got = await asPlatform(platform, TMP, () => {
      ui.setUnicode(ui.detectUnicodeForTest())
      return ui.unicodeOk()
    })
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    check(`glyphs: ${why}`, () => assert.equal(got, want))
  }
  ui.setUnicode(true)

  // Both wordmarks exist and each is drawable by the console it targets — the
  // ASCII one is the same hash art install.ps1 prints, so the CLI and the
  // installer look like one product on Windows too.
  check('the ASCII wordmark is pure ASCII', () => {
    ui.setUnicode(false)
    const lines = ui.wordmark()
    assert.ok(lines.length > 0)
    for (const line of lines) {
      // eslint-disable-next-line no-control-regex
      assert.ok(/^[\x00-\x7f]*$/.test(line), `non-ASCII in the fallback wordmark: ${line}`)
    }
    ui.setUnicode(true)
  })

  check('ASCII mode transliterates prose punctuation instead of dropping it', () => {
    ui.setUnicode(false)
    assert.equal(ui.safe('a \u2014 b\u2026'), 'a - b...')
    assert.equal(ui.safe('\u2018q\u2019'), "'q'")
    ui.setUnicode(true)
    assert.equal(ui.safe('a \u2014 b\u2026'), 'a \u2014 b\u2026')
  })

  // ── the packaged client entry resolves per platform ───────────────────────
  check('cli binary resolves under resources when packaged', () => {
    const entry = cliPath.cliEntryPath(false, '/app', '/res')
    assert.equal(entry, path.join('/res', 'cli', cliPath.cliBinaryName()))
  })
  check('cli entry resolves to the source tree in dev', () => {
    const entry = cliPath.cliEntryPath(true, '/repo', '/res')
    assert.equal(entry, path.join('/repo', 'src', 'cli', 'index.ts'))
  })

  // ── dev: the shim runs the source under Bun ───────────────────────────────
  const devHome = path.join(TMP, 'dev-home')
  fs.mkdirSync(devHome, { recursive: true })
  await asPlatform('darwin', devHome, () =>
    cliPath.installCliPath(
      '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      '/repo/src/cli/index.ts'
    )
  )
  check('dev: the shim runs src/cli/index.ts under the repo bun with the Solid preload', () => {
    const body = fs.readFileSync(path.join(devHome, '.wolffish', 'bin', 'wolffish'), 'utf8')
    assert.ok(body.includes('/repo/node_modules/bun/bin/bun.exe'), body)
    assert.ok(body.includes('--preload'), 'JSX needs the Solid transform preloaded')
    assert.ok(body.includes('/repo/src/cli/node_modules/@opentui/solid/scripts/preload.js'), body)
    assert.ok(body.includes('/repo/src/cli/index.ts'), body)
    assert.ok(body.includes('WOLFFISH_DEV=1'), body)
    assert.ok(body.includes('WOLFFISH_EXEC='), body)
  })
  const devWinHome = path.join(TMP, 'dev-home-win')
  fs.mkdirSync(devWinHome, { recursive: true })
  await asPlatform('win32', devWinHome, () =>
    cliPath.installCliPath(
      'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
      'C:\\repo\\src\\cli\\index.ts'
    )
  )
  check('dev windows: both shims run the source under bun.exe', () => {
    const cmd = fs.readFileSync(path.join(devWinHome, '.wolffish', 'bin', 'wolffish.cmd'), 'utf8')
    assert.ok(cmd.includes('bun.exe') && cmd.includes('--preload') && cmd.includes('index.ts'), cmd)
    const bash = fs.readFileSync(path.join(devWinHome, '.wolffish', 'bin', 'wolffish'), 'utf8')
    assert.ok(bash.includes('bun.exe') && bash.includes('index.ts'), bash)
  })

  fs.rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void main()
