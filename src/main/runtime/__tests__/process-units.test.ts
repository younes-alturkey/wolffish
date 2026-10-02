/**
 * Per-process login units (src/main/processes/service-units.ts) under
 * WOLFFISH_AUTOSTART_DRY_RUN — the unit FILES for all three platforms are
 * written with the right command, cwd, env, log path and restart mapping,
 * and removed again, without ever touching a live service manager. The
 * HOME is faked; the dry-run gate is what keeps launchctl/systemctl out of
 * the picture (see the incident note in autostart.ts).
 *
 * Run:
 *   WOLFFISH_AUTOSTART_DRY_RUN=1 TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/process-units.test.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let passed = 0
let failed = 0
function ok(name: string, cond: unknown, detail?: unknown): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}`)
    if (detail !== undefined)
      console.log('    ', typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
}

async function main(): Promise<void> {
  if (process.env.WOLFFISH_AUTOSTART_DRY_RUN !== '1') {
    console.log(
      'refusing to run without WOLFFISH_AUTOSTART_DRY_RUN=1 (would touch the live service manager)'
    )
    process.exit(1)
  }
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-units-'))
  process.env.HOME = HOME
  process.env.USERPROFILE = HOME
  const units = await import('../../processes/service-units')
  const { emptyRun } = await import('../../processes/types')
  const record = {
    id: 'x',
    name: 'web-dev',
    command: 'npm run dev -- --port {port} --strictPort',
    cwd: '/Users/me/proj',
    env: { NODE_ENV: 'development' },
    port: { mode: 'wolffish' as const },
    ready: {},
    restart: 'on-failure' as const,
    onQuit: 'keep' as const,
    autostart: 'system' as const,
    origin: { conversationId: null, kind: 'started' as const },
    createdAt: 0,
    updatedAt: 0,
    run: { ...emptyRun(), port: 20347 }
  }
  const logPath = '/tmp/wolffish/files/processes/web-dev/current.log'

  console.log('\n— macOS plist')
  const plist = units.launchdPlist(record, logPath)
  ok('label', plist.includes('<string>sh.wolffi.process.web-dev</string>'))
  ok(
    'login shell with resolved port',
    plist.includes('<string>-lc</string>') &&
      plist.includes('npm run dev -- --port 20347 --strictPort')
  )
  ok('cwd', plist.includes('<string>/Users/me/proj</string>'))
  ok(
    'env carries PORT and NODE_ENV',
    plist.includes('<key>PORT</key>') &&
      plist.includes('<string>20347</string>') &&
      plist.includes('<key>NODE_ENV</key>')
  )
  ok(
    'on-failure maps to SuccessfulExit false',
    plist.includes('<key>SuccessfulExit</key>') && plist.includes('<false/>')
  )
  ok('log path', plist.includes(`<string>${logPath}</string>`))
  ok(
    'always maps to KeepAlive true',
    units
      .launchdPlist({ ...record, restart: 'always' }, logPath)
      .includes('<key>KeepAlive</key>\n  <true/>')
  )
  ok(
    'never maps to KeepAlive false',
    units
      .launchdPlist({ ...record, restart: 'never' }, logPath)
      .includes('<key>KeepAlive</key>\n  <false/>')
  )
  const stateD = await units.installUnit(record, logPath, 'darwin')
  const plistPath = path.join(HOME, 'Library', 'LaunchAgents', 'sh.wolffi.process.web-dev.plist')
  ok('plist written under the faked HOME', fs.existsSync(plistPath), plistPath)
  ok('dry-run state reports installed', stateD.installed && stateD.active)
  await units.removeUnit('web-dev', 'darwin')
  ok('plist removed', !fs.existsSync(plistPath))

  console.log('\n— Linux unit')
  const unit = units.systemdUnit(record, logPath)
  ok(
    'ExecStart via login shell',
    unit.includes("ExecStart=/bin/sh -lc 'npm run dev -- --port 20347 --strictPort'")
  )
  ok('Restart=on-failure', unit.includes('Restart=on-failure'))
  ok(
    'Restart=always',
    units.systemdUnit({ ...record, restart: 'always' }, logPath).includes('Restart=always')
  )
  ok(
    'Restart=no',
    units.systemdUnit({ ...record, restart: 'never' }, logPath).includes('Restart=no')
  )
  ok('StandardOutput append', unit.includes(`StandardOutput=append:${logPath}`))
  ok('WantedBy default.target', unit.includes('WantedBy=default.target'))
  ok(
    'Environment lines',
    unit.includes('Environment="PORT=20347"') && unit.includes('Environment="NODE_ENV=development"')
  )
  const stateL = await units.installUnit(record, logPath, 'linux')
  const unitPath = path.join(HOME, '.config', 'systemd', 'user', 'wolffish-process-web-dev.service')
  ok('unit written under the faked HOME', fs.existsSync(unitPath), unitPath)
  ok('dry-run state reports installed', stateL.installed)
  await units.removeUnit('web-dev', 'linux')
  ok('unit removed', !fs.existsSync(unitPath))

  console.log('\n— Windows logon task')
  const winLog = 'C:\\wolffish\\files\\processes\\web-dev\\current.log'
  const command = units.windowsUnitCommand(record, winLog)
  ok(
    'cd, set env, run, append log',
    /^cd \/d ".*" && set "NO_COLOR=1" && .*set "PORT=20347" && npm run dev -- --port 20347 --strictPort >> ".*current\.log" 2>&1$/.test(
      command
    ),
    command
  )
  const filesRoot = path.join(HOME, 'custom-workspace', 'files', 'processes')
  units.setProcessFilesRoot(filesRoot)
  const stateW = await units.installUnit(record, winLog, 'win32')
  const vbs = units.unitScriptPath('web-dev')
  ok(
    'launcher written under the configured files root',
    vbs.startsWith(filesRoot) && fs.existsSync(vbs),
    vbs
  )
  const launcher = fs.existsSync(vbs) ? fs.readFileSync(vbs, 'utf8') : ''
  ok(
    'launcher runs cmd hidden and waits, with every quote doubled',
    launcher.includes('sh.Run "cmd.exe /d /s /c ""cd /d ""') &&
      launcher.includes('"", 0, True') &&
      launcher.includes('set ""PORT=20347""'),
    launcher
  )
  ok('dry-run state reports installed', stateW.installed)
  ok('label', units.unitLabel('web-dev', 'win32') === 'Wolffish\\process-web-dev')
  await units.removeUnit('web-dev', 'win32')
  ok('launcher removed', !fs.existsSync(vbs))

  fs.rmSync(HOME, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
