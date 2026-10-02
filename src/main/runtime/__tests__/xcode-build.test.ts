/**
 * The xcode capability's contract (src/defaults/workspace/brain/cerebellum/
 * xcode/plugin/index.mjs), driven through the real plugin with a fake process
 * executor so no xcodebuild / simctl ever runs: the build-output parser (the
 * three error shapes, the linker line, dedupe, warning counting, exit-code-
 * decides-success), per-conversation defaults and the MISSING_DEFAULTS text,
 * xcode_run naming its failing step, the argv shape (derived data under the
 * workspace, id= vs name= destinations), and xcode_discover on a fixture tree.
 *
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/xcode-build.test.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

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

type Result = {
  success: boolean
  output?: string
  error?: string
  retryable?: boolean
  meta?: { exitCode?: number | null; durationMs?: number; label?: string }
}
type Args = Record<string, unknown>
type Plugin = {
  init: (ctx: unknown) => Promise<void>
  execute: (name: string, args: Args, signal?: AbortSignal) => Promise<Result>
  isReadOnlyCall: (name: string, args: Args) => boolean
  describeAction: (
    name: string,
    args: Args
  ) => { title: string; description: string; risk: string } | null
}
type FakeResult = { code: number | null; out: string; err: string }
type Call = { cmd: string; args: string[]; opts: Record<string, unknown> }
type Executor = (cmd: string, args: string[], opts: Record<string, unknown>) => Promise<FakeResult>
type PluginModule = {
  default: Plugin
  __setExecutor: (fn: Executor) => void
  __resetExecutor: () => void
  createOutputParser: (mode: 'build' | 'test') => {
    feed: (chunk: string) => void
    end: () => {
      errors: { location: string; message: string }[]
      warningCount: number
      tests: { passed: number; failed: number; skipped: number }
      failures: { suite: string; test: string; message: string; location: string }[]
      totals: { executed: number; failed: number } | null
    }
  }
}

const SIMCTL_LIST = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
      {
        name: 'iPhone 17 Pro',
        udid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
        state: 'Shutdown',
        isAvailable: true
      },
      {
        name: 'iPhone 17',
        udid: '11111111-2222-3333-4444-555555555555',
        state: 'Booted',
        isAvailable: true
      }
    ]
  }
})

async function main(): Promise<void> {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-xcode-'))
  const ROOT = fs.realpathSync(TMP)
  const WORKSPACE = path.join(ROOT, 'workspace')
  const PROJECT_DIR = path.join(ROOT, 'app')
  const PROJECT = path.join(PROJECT_DIR, 'Foo.xcodeproj')
  fs.mkdirSync(WORKSPACE, { recursive: true })
  fs.mkdirSync(PROJECT, { recursive: true })

  const mod = (await import(
    pathToFileURL(
      path.join(process.cwd(), 'src/defaults/workspace/brain/cerebellum/xcode/plugin/index.mjs')
    ).href
  )) as PluginModule
  const plugin = mod.default
  let conversationId: string | null = 'conv-1'
  await plugin.init({
    pluginDir: ROOT,
    workspaceRoot: WORKSPACE,
    getCurrentConversationId: () => conversationId,
    getWorkingFolders: () => [PROJECT_DIR]
  })

  // A scripted executor: each call is recorded; replies come from `script`
  // keyed by the first distinctive argv token (the xcodebuild action, the
  // simctl subcommand), defaulting to success with empty output.
  const calls: Call[] = []
  let script: Record<string, FakeResult | ((call: Call) => FakeResult)> = {}
  const keyOf = (cmd: string, args: string[]): string => {
    if (cmd === 'xcodebuild') {
      if (args.includes('-list')) return 'list'
      if (args.includes('-showBuildSettings')) return 'settings'
      if (args[args.length - 1] === 'test') return 'test'
      return 'build'
    }
    if (cmd === 'xcrun' && args[0] === 'simctl') return `simctl ${args[1]}`
    return cmd
  }
  mod.__setExecutor(async (cmd, args, opts) => {
    const call = { cmd, args, opts }
    calls.push(call)
    const entry = script[keyOf(cmd, args)]
    if (typeof entry === 'function') return entry(call)
    return entry ?? { code: 0, out: '', err: '' }
  })
  const reset = (): void => {
    calls.length = 0
    script = {}
  }
  const run = (name: string, args: Args = {}, signal?: AbortSignal): Promise<Result> =>
    plugin.execute(name, args, signal)
  const buildCalls = (): Call[] => calls.filter((c) => keyOf(c.cmd, c.args) === 'build')
  const flag = (call: Call, name: string): string | undefined =>
    call.args[call.args.indexOf(name) + 1]

  const productsDir = path.join(
    WORKSPACE,
    'files',
    'derived-data',
    'Foo',
    'Build',
    'Products',
    'Debug-iphonesimulator'
  )
  const APP = path.join(productsDir, 'Foo.app')
  const makeApp = (): void => {
    fs.mkdirSync(APP, { recursive: true })
  }

  console.log('parser')
  {
    const p = mod.createOutputParser('build')
    p.feed(
      [
        'CompileSwift normal arm64 /Users/x/App/Foo.swift',
        "/Users/x/App/Foo.swift:12:5: error: cannot find 'bar' in scope",
        "/Users/x/App/Foo.swift:12:5: error: cannot find 'bar' in scope",
        "/Users/x/App/Foo.swift:12:5: ERROR: Cannot find 'bar' in scope",
        '/Users/x/App/Foo.xcodeproj: error: No signing certificate "iOS Development" found',
        'xcodebuild: error: Unable to find a destination matching the provided destination specifier',
        "error: no such module 'Alamofire'",
        'ld: symbol(s) not found for architecture arm64',
        'ld: warning: directory not found for option',
        '/Users/x/App/Baz.swift:3:1: warning: unused variable',
        '/Users/x/App/Baz.swift:3:1: warning: unused variable',
        'warning: this is a prefixed warning',
        'clang: error: linker command failed with exit code 1 (use -v to see invocation)',
        '** BUILD FAILED **',
        ''
      ].join('\n')
    )
    const s = p.end()
    const rendered = s.errors.map((e) => (e.location ? `${e.location}: ${e.message}` : e.message))
    ok(
      'file:line:col error → file:line',
      rendered[0] === "/Users/x/App/Foo.swift:12: cannot find 'bar' in scope",
      rendered
    )
    ok(
      'identical error seen twice (and case-different) is deduped',
      rendered.filter((r) => r.includes('Foo.swift:12')).length === 1,
      rendered
    )
    ok(
      '/abs/path: error: shape keeps the path as location',
      rendered.includes(
        '/Users/x/App/Foo.xcodeproj: No signing certificate "iOS Development" found'
      ),
      rendered
    )
    ok(
      'xcodebuild: error: prefix drops the prefix',
      rendered.includes('Unable to find a destination matching the provided destination specifier'),
      rendered
    )
    ok('bare error: line is kept', rendered.includes("no such module 'Alamofire'"), rendered)
    ok(
      'ld: line is an error, ld: warning: is not',
      rendered.includes('ld: symbol(s) not found for architecture arm64') &&
        !rendered.some((r) => r.includes('directory not found')),
      rendered
    )
    ok(
      'clang: error: linker line is kept',
      rendered.some((r) => r.startsWith('linker command failed')),
      rendered
    )
    ok(
      'warnings are counted and deduped (2 unique + ld: warning)',
      s.warningCount === 3,
      s.warningCount
    )
    ok(
      'BUILD FAILED banner is not an error',
      !rendered.some((r) => r.includes('BUILD FAILED')),
      rendered
    )
    ok('exactly 6 unique errors', s.errors.length === 6, s.errors.length)

    const t = mod.createOutputParser('test')
    t.feed(
      [
        "Test Case '-[FooTests.LoginTests testEmpty]' started.",
        '/Users/x/App/FooTests/LoginTests.swift:20: error: -[FooTests.LoginTests testEmpty] : XCTAssertEqual failed: ("1") is not equal to ("2") - wrong count',
        "Test Case '-[FooTests.LoginTests testEmpty]' failed (0.012 seconds).",
        "Test Case '-[FooTests.LoginTests testFull]' passed (0.001 seconds).",
        "Test case 'LoginTests.testSkipped()' skipped on 'iPhone 17' (0.000 seconds)",
        '✘ Test "adds numbers" recorded an issue at MathTests.swift:9:5: Expectation failed: (a + b → 3) == 4',
        '✘ Test "adds numbers" failed after 0.002 seconds with 1 issue.',
        '✔ Test example() passed after 0.001 seconds.',
        'Executed 3 tests, with 1 failure (1 unexpected) in 0.013 (0.020) seconds',
        ''
      ].join('\n')
    )
    const ts = t.end()
    ok(
      'test cases counted across XCTest and Swift Testing shapes',
      ts.tests.passed === 2 && ts.tests.failed === 2 && ts.tests.skipped === 1,
      ts.tests
    )
    ok(
      'XCTest failure parsed as Suite.test: message (file:line)',
      ts.failures.some(
        (f) =>
          f.suite === 'LoginTests' &&
          f.test === 'testEmpty' &&
          f.location === '/Users/x/App/FooTests/LoginTests.swift:20' &&
          f.message.startsWith('XCTAssertEqual failed')
      ),
      ts.failures
    )
    ok(
      'Swift Testing issue parsed with its location',
      ts.failures.some((f) => f.test === 'adds numbers' && f.location === 'MathTests.swift:9'),
      ts.failures
    )
    ok('totals line parsed', ts.totals?.executed === 3 && ts.totals?.failed === 1, ts.totals)
    ok(
      'the XCTest failure line is not double-counted as a build error',
      ts.errors.length === 0,
      ts.errors
    )
  }

  console.log('xcode_defaults')
  {
    reset()
    const show = await run('xcode_defaults')
    ok(
      'no defaults → readable "none set" message',
      show.success && /No Xcode defaults/.test(show.output ?? ''),
      show
    )
    ok(
      'xcode_defaults with no args is read-only',
      plugin.isReadOnlyCall('xcode_defaults', {}) === true
    )
    ok(
      'xcode_defaults with args is not read-only',
      plugin.isReadOnlyCall('xcode_defaults', { scheme: 'Foo' }) === false
    )
    const noScheme = await run('xcode_build', { project: PROJECT })
    ok(
      'build without a scheme fails with the MISSING_DEFAULTS text, not retryable',
      !noScheme.success &&
        noScheme.retryable === false &&
        noScheme.error ===
          'MISSING_DEFAULTS: scheme is unknown — set it with xcode_defaults {scheme: "..."} or pass scheme. xcode_schemes lists them.',
      noScheme
    )
    const noProject = await run('xcode_build', { scheme: 'Foo' })
    ok(
      'build without a project names project',
      !noProject.success && /^MISSING_DEFAULTS: project is unknown/.test(noProject.error ?? ''),
      noProject
    )
    ok(
      'no xcodebuild was spawned for a MISSING_DEFAULTS failure',
      buildCalls().length === 0,
      calls.length
    )
    const bad = await run('xcode_defaults', { scheme: 'Foo; rm -rf /' })
    ok(
      'scheme is validated against /^[\\w .-]+$/',
      !bad.success && /unsupported characters/.test(bad.error ?? ''),
      bad
    )
    const missingProject = await run('xcode_defaults', {
      project: path.join(ROOT, 'Nope.xcodeproj')
    })
    ok(
      'project path must exist',
      !missingProject.success && /does not exist/.test(missingProject.error ?? ''),
      missingProject
    )
    const set = await run('xcode_defaults', {
      project: PROJECT,
      scheme: 'Foo',
      device: 'iPhone 17 Pro'
    })
    ok(
      'setting defaults echoes them',
      set.success &&
        /scheme: Foo/.test(set.output ?? '') &&
        /device: iPhone 17 Pro/.test(set.output ?? ''),
      set
    )
    const shown = await run('xcode_defaults')
    ok(
      'show after set lists project, scheme, device and an unset configuration',
      /project: .*Foo\.xcodeproj/.test(shown.output ?? '') &&
        /configuration: \(unset\)/.test(shown.output ?? ''),
      shown
    )
    conversationId = 'conv-2'
    const other = await run('xcode_defaults')
    ok('defaults are per conversation', /No Xcode defaults/.test(other.output ?? ''), other)
    conversationId = 'conv-1'
    const cleared = await run('xcode_defaults', { clear: true })
    const afterClear = await run('xcode_defaults')
    ok(
      'clear forgets them',
      cleared.success && /No Xcode defaults/.test(afterClear.output ?? ''),
      afterClear
    )
    ok(
      'describeAction labels a build with the scheme',
      plugin.describeAction('xcode_build', { scheme: 'Foo' })?.description === 'Build Foo'
    )
    ok(
      'describeAction is null for read-only tools',
      plugin.describeAction('xcode_schemes', {}) === null
    )
  }

  console.log('xcode_build: exit code decides')
  {
    reset()
    makeApp()
    script.build = {
      code: 65,
      out: 'CompileSwift\n/Users/x/A.swift:1:1: error: boom\n** BUILD SUCCEEDED **\n',
      err: ''
    }
    const r = await run('xcode_build', { project: PROJECT, scheme: 'Foo' })
    ok(
      'exit 65 is a failure even though the log says BUILD SUCCEEDED',
      !r.success &&
        r.retryable === false &&
        /^BUILD_FAILED: xcodebuild exited 65/.test(r.error ?? ''),
      r
    )
    ok(
      'failure lists the parsed error as file:line: message',
      /\/Users\/x\/A\.swift:1: boom/.test(r.error ?? ''),
      r.error
    )
    ok(
      'failure carries warnings count and the log path',
      /Warnings: 0/.test(r.error ?? '') &&
        /Log: .*files\/xcode\/logs\/build-Foo-\d+\.log/.test(r.error ?? ''),
      r.error
    )
    const logPath = (r.error ?? '').match(/Log: (.+)$/m)?.[1] ?? ''
    ok(
      'the log file holds the raw xcodebuild output',
      logPath !== '' && fs.readFileSync(logPath, 'utf8').includes('** BUILD SUCCEEDED **'),
      logPath
    )

    reset()
    script.build = {
      code: 0,
      out: 'CompileSwift\n/Users/x/A.swift:2:1: warning: meh\n** BUILD FAILED **\n',
      err: ''
    }
    const s = await run('xcode_build', { project: PROJECT, scheme: 'Foo', device: 'iPhone 17 Pro' })
    ok(
      'exit 0 is a success even though the log says BUILD FAILED',
      s.success && /^Built Foo \(Debug\) for iPhone 17 Pro in \d+s\./.test(s.output ?? ''),
      s
    )
    ok(
      'success reports the .app path, the warning count and a next step',
      (s.output ?? '').includes(`App: ${APP}`) &&
        /Warnings: 1/.test(s.output ?? '') &&
        /Next: xcode_run/.test(s.output ?? ''),
      s.output
    )
    ok(
      'meta carries label, duration and exit code',
      s.meta?.label === 'Build' && typeof s.meta?.durationMs === 'number' && s.meta?.exitCode === 0,
      s.meta
    )

    reset()
    script.build = {
      code: 65,
      out:
        'CompileSwift\n' +
        '/Users/x/B.swift:1:1: error: dup\n'.repeat(5) +
        '/Users/x/B.swift:1:1: error: dup\r\n',
      err: ''
    }
    const d = await run('xcode_build', { project: PROJECT, scheme: 'Foo' })
    ok(
      'the same error five times is reported once',
      ((d.error ?? '').match(/B\.swift:1: dup/g) ?? []).length === 1 &&
        /Errors \(1\)/.test(d.error ?? ''),
      d.error
    )

    reset()
    script.build = {
      code: 65,
      out: 'CompileSwift\nld: symbol(s) not found for architecture arm64\nclang: error: linker command failed with exit code 1\n',
      err: ''
    }
    const l = await run('xcode_build', { project: PROJECT, scheme: 'Foo' })
    ok(
      'linker failure shows the ld: line',
      /ld: symbol\(s\) not found for architecture arm64/.test(l.error ?? '') &&
        /linker command failed/.test(l.error ?? ''),
      l.error
    )

    reset()
    const ctl = new AbortController()
    script.build = (call) => {
      const signal = call.opts.signal as AbortSignal | undefined
      return { code: null, out: '', err: signal?.aborted ? 'aborted' : '' }
    }
    ctl.abort()
    const a = await run('xcode_build', { project: PROJECT, scheme: 'Foo' }, ctl.signal)
    ok('the abort signal is handed to the executor', buildCalls()[0]?.opts.signal === ctl.signal)
    ok('an exit code of null is never a success', !a.success, a)
  }

  console.log('xcode_build: argv')
  {
    reset()
    makeApp()
    await run('xcode_build', {
      project: PROJECT,
      scheme: 'Foo',
      device: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'
    })
    const c = buildCalls()[0]
    ok(
      'spawns xcodebuild with an argv array, cwd = project folder',
      c?.cmd === 'xcodebuild' && Array.isArray(c.args) && c.opts.cwd === PROJECT_DIR,
      c
    )
    ok(
      '-project for a .xcodeproj',
      flag(c, '-project') === PROJECT && !c.args.includes('-workspace'),
      c.args
    )
    ok(
      '-derivedDataPath lives under the workspace files/derived-data/<scheme>',
      flag(c, '-derivedDataPath') === path.join(WORKSPACE, 'files', 'derived-data', 'Foo'),
      c.args
    )
    ok(
      'a UUID device becomes id=',
      flag(c, '-destination') === 'platform=iOS Simulator,id=AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      c.args
    )
    ok(
      'macro validation skipped, index store off, action last',
      c.args.includes('-skipMacroValidation') &&
        c.args.includes('COMPILER_INDEX_STORE_ENABLE=NO') &&
        c.args[c.args.length - 1] === 'build',
      c.args
    )
    ok(
      'build has the 20 minute cap and the 5 minute stall watchdog',
      c.opts.timeout === 20 * 60_000 && c.opts.stallTimeout === 5 * 60_000,
      c.opts
    )

    reset()
    await run('xcode_build', {
      project: PROJECT,
      scheme: 'Foo',
      device: 'iPhone 17 Pro',
      clean: true,
      configuration: 'Release'
    })
    const n = buildCalls()[0]
    ok(
      'a device name becomes name=',
      flag(n, '-destination') === 'platform=iOS Simulator,name=iPhone 17 Pro',
      n.args
    )
    ok('clean=true runs clean build', n.args.slice(-2).join(' ') === 'clean build', n.args)
    ok('configuration is passed through', flag(n, '-configuration') === 'Release', n.args)

    reset()
    await run('xcode_build', { project: PROJECT, scheme: 'Foo' })
    ok(
      'no device → generic simulator destination',
      flag(buildCalls()[0], '-destination') === 'generic/platform=iOS Simulator',
      buildCalls()[0]?.args
    )

    reset()
    const ws = path.join(PROJECT_DIR, 'Foo.xcworkspace')
    fs.mkdirSync(ws, { recursive: true })
    await run('xcode_build', { project: ws, scheme: 'Foo' })
    ok(
      '-workspace for a .xcworkspace',
      flag(buildCalls()[0], '-workspace') === ws && !buildCalls()[0].args.includes('-project'),
      buildCalls()[0]?.args
    )

    reset()
    script.build = { code: 0, out: '', err: '' }
    script.test = {
      code: 0,
      out: "Test Case '-[FooTests.A testB]' passed (0.001 seconds).\nExecuted 1 test, with 0 failures (0 unexpected) in 0.001 (0.002) seconds\n",
      err: ''
    }
    const t = await run('xcode_test', {
      project: PROJECT,
      scheme: 'Foo',
      only: 'FooTests/A/testB,FooTests/C',
      skip: 'FooTests/D'
    })
    const tc = calls.find((c) => c.args[c.args.length - 1] === 'test')
    ok(
      'xcode_test passes -only-testing and -skip-testing selectors and the 30 minute cap',
      tc !== undefined &&
        tc.args.includes('-only-testing:FooTests/A/testB') &&
        tc.args.includes('-only-testing:FooTests/C') &&
        tc.args.includes('-skip-testing:FooTests/D') &&
        tc.opts.timeout === 30 * 60_000,
      tc?.args
    )
    ok(
      'xcode_test reports counts on success',
      t.success && /1 passed, 0 failed, 0 skipped/.test(t.output ?? ''),
      t
    )
    reset()
    script.test = {
      code: 65,
      out: "/Users/x/T.swift:5: error: -[FooTests.A testB] : XCTAssertTrue failed - nope\nTest Case '-[FooTests.A testB]' failed (0.010 seconds).\nExecuted 1 test, with 1 failure (1 unexpected) in 0.010 (0.011) seconds\n",
      err: ''
    }
    const tf = await run('xcode_test', { project: PROJECT, scheme: 'Foo' })
    ok(
      'xcode_test failure lists Suite.test: message (file:line)',
      !tf.success &&
        tf.retryable === false &&
        /A\.testB: XCTAssertTrue failed - nope \(\/Users\/x\/T\.swift:5\)/.test(tf.error ?? '') &&
        /0 passed, 1 failed/.test(tf.error ?? ''),
      tf.error
    )
  }

  console.log('xcode_run')
  {
    reset()
    makeApp()
    script['simctl list'] = { code: 0, out: SIMCTL_LIST, err: '' }
    script.build = { code: 65, out: '/Users/x/A.swift:1:1: error: boom\n', err: '' }
    const b = await run('xcode_run', { project: PROJECT, scheme: 'Foo', device: 'iPhone 17 Pro' })
    ok(
      'run names BUILD_FAILED with the parsed error',
      !b.success && /^BUILD_FAILED/.test(b.error ?? '') && /A\.swift:1: boom/.test(b.error ?? ''),
      b.error
    )
    ok(
      'a failed build never reaches install',
      !calls.some((c) => c.args[1] === 'install'),
      calls.map((c) => c.args.slice(0, 2))
    )

    reset()
    script['simctl list'] = { code: 0, out: SIMCTL_LIST, err: '' }
    script['simctl boot'] = {
      code: 1,
      out: '',
      err: 'Unable to boot device because it cannot be located'
    }
    const boot = await run('xcode_run', {
      project: PROJECT,
      scheme: 'Foo',
      device: 'iPhone 17 Pro'
    })
    ok(
      'run names BOOT_FAILED for a shutdown device that will not boot',
      !boot.success &&
        /^BOOT_FAILED: xcrun simctl boot AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE exited 1/.test(
          boot.error ?? ''
        ),
      boot.error
    )
    ok(
      'the build used the resolved udid as id=',
      flag(buildCalls()[0], '-destination') ===
        'platform=iOS Simulator,id=AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      buildCalls()[0]?.args
    )

    reset()
    script['simctl list'] = { code: 0, out: SIMCTL_LIST, err: '' }
    script.settings = {
      code: 0,
      out: JSON.stringify([
        {
          action: 'build',
          target: 'Foo',
          buildSettings: {
            PRODUCT_BUNDLE_IDENTIFIER: 'com.example.foo',
            FULL_PRODUCT_NAME: 'Foo.app'
          }
        }
      ]),
      err: ''
    }
    script['simctl install'] = {
      code: 1,
      out: '',
      err: 'An error was encountered processing the command (domain=IXUserPresentableErrorDomain, code=1)'
    }
    const inst = await run('xcode_run', { project: PROJECT, scheme: 'Foo', device: 'iPhone 17' })
    ok(
      'run names INSTALL_FAILED (booted device skips boot)',
      !inst.success &&
        /^INSTALL_FAILED/.test(inst.error ?? '') &&
        !calls.some((c) => c.args[1] === 'boot'),
      inst.error
    )
    ok(
      'install targets the booted udid and the built .app',
      calls.some(
        (c) =>
          c.args[1] === 'install' &&
          c.args[2] === '11111111-2222-3333-4444-555555555555' &&
          c.args[3] === APP
      ),
      calls.map((c) => c.args)
    )

    reset()
    script['simctl list'] = { code: 0, out: SIMCTL_LIST, err: '' }
    script['simctl launch'] = {
      code: 3,
      out: '',
      err: 'The request was denied by service delegate'
    }
    const launch = await run('xcode_run', {
      project: PROJECT,
      scheme: 'Foo',
      bundle_id: 'com.example.foo'
    })
    ok(
      'run names LAUNCH_FAILED and defaults to the booted device',
      !launch.success &&
        /^LAUNCH_FAILED: xcrun simctl launch com\.example\.foo exited 3/.test(launch.error ?? ''),
      launch.error
    )
    ok(
      'bundle id cache: no -showBuildSettings when bundle_id is passed',
      !calls.some((c) => c.args.includes('-showBuildSettings')),
      calls.map((c) => c.args[0])
    )

    reset()
    script['simctl list'] = { code: 0, out: SIMCTL_LIST, err: '' }
    script['simctl launch'] = { code: 0, out: 'com.example.foo: 4242\n', err: '' }
    const good = await run('xcode_run', { project: PROJECT, scheme: 'Foo', device: 'iPhone 17' })
    ok(
      'a full run reports pid, app, bundle id and the mobile next step',
      good.success &&
        /pid 4242/.test(good.output ?? '') &&
        (good.output ?? '').includes(`App: ${APP}`) &&
        /Bundle id: com\.example\.foo/.test(good.output ?? '') &&
        /Next: mobile_use device=11111111-2222-3333-4444-555555555555 then mobile_indicator_on/.test(
          good.output ?? ''
        ),
      good
    )
    ok(
      'bundle id came from the 10 minute cache (no second -showBuildSettings)',
      !calls.some((c) => c.args.includes('-showBuildSettings')),
      calls.map((c) => c.args[0])
    )
    ok(
      'launch terminates a running copy',
      calls.some((c) => c.args[1] === 'launch' && c.args[2] === '--terminate-running-process'),
      calls.map((c) => c.args)
    )
    ok(
      'describeAction for run names scheme and device',
      plugin.describeAction('xcode_run', { scheme: 'Foo', device: 'iPhone 17' })?.description ===
        'Run Foo on iPhone 17'
    )

    reset()
    script['simctl list'] = { code: 0, out: SIMCTL_LIST, err: '' }
    const nope = await run('xcode_run', { project: PROJECT, scheme: 'Foo', device: 'iPhone 3G' })
    ok(
      'an unknown device name fails before any build',
      !nope.success &&
        /^BOOT_FAILED: no simulator named "iPhone 3G"/.test(nope.error ?? '') &&
        buildCalls().length === 0,
      nope.error
    )
  }

  console.log('xcode_schemes + xcode_bundle_id')
  {
    reset()
    script.list = {
      code: 0,
      out: JSON.stringify({
        project: {
          name: 'Foo',
          schemes: ['Foo', 'FooTests'],
          targets: ['Foo', 'FooTests'],
          configurations: ['Debug', 'Release']
        }
      }),
      err: ''
    }
    const s = await run('xcode_schemes', { project: PROJECT })
    const lc = calls[0]
    ok(
      'xcodebuild -list -json -project <path> with a 30 s cap',
      lc.cmd === 'xcodebuild' &&
        lc.args.includes('-list') &&
        lc.args.includes('-json') &&
        flag(lc, '-project') === PROJECT &&
        lc.opts.timeout === 30_000,
      lc
    )
    ok(
      'schemes, targets and configurations are listed',
      s.success &&
        /Schemes \(2\): Foo, FooTests/.test(s.output ?? '') &&
        /Targets \(2\)/.test(s.output ?? '') &&
        /Configurations: Debug, Release/.test(s.output ?? ''),
      s.output
    )

    reset()
    script.settings = {
      code: 0,
      out: JSON.stringify([
        {
          action: 'build',
          target: 'Bar',
          buildSettings: {
            PRODUCT_BUNDLE_IDENTIFIER: 'com.example.bar',
            FULL_PRODUCT_NAME: 'Bar.app',
            TARGET_BUILD_DIR: '/tmp/x',
            BUILT_PRODUCTS_DIR: '/tmp/x'
          }
        }
      ]),
      err: ''
    }
    const b1 = await run('xcode_bundle_id', { project: PROJECT, scheme: 'Bar' })
    const sc = calls[0]
    ok(
      'showBuildSettings argv: scheme, configuration, generic simulator destination, 120 s cap',
      sc.args.includes('-showBuildSettings') &&
        flag(sc, '-scheme') === 'Bar' &&
        flag(sc, '-configuration') === 'Debug' &&
        flag(sc, '-destination') === 'generic/platform=iOS Simulator' &&
        sc.opts.timeout === 120_000,
      sc
    )
    ok(
      'bundle id, product name and dirs reported',
      b1.success &&
        /PRODUCT_BUNDLE_IDENTIFIER: com\.example\.bar/.test(b1.output ?? '') &&
        /FULL_PRODUCT_NAME: Bar\.app/.test(b1.output ?? '') &&
        /TARGET_BUILD_DIR: \/tmp\/x/.test(b1.output ?? ''),
      b1.output
    )
    const b2 = await run('xcode_bundle_id', { project: PROJECT, scheme: 'Bar' })
    ok(
      'second call is served from the cache',
      b2.success && /\(cached\)/.test(b2.output ?? '') && calls.length === 1,
      { calls: calls.length, out: b2.output }
    )
  }

  console.log('xcode_discover')
  {
    reset()
    const tree = path.join(ROOT, 'discover')
    fs.mkdirSync(path.join(tree, 'Foo.xcworkspace'), { recursive: true })
    fs.mkdirSync(path.join(tree, 'Foo.xcodeproj', 'project.xcworkspace'), { recursive: true })
    fs.mkdirSync(path.join(tree, 'flutter_app'), { recursive: true })
    fs.writeFileSync(path.join(tree, 'flutter_app', 'pubspec.yaml'), 'name: flutter_app\n')
    fs.mkdirSync(path.join(tree, 'node_modules', 'dep', 'Dep.xcodeproj'), { recursive: true })
    fs.mkdirSync(path.join(tree, 'a', 'b', 'c', 'Deep.xcodeproj'), { recursive: true })
    fs.mkdirSync(path.join(tree, 'a', 'b', 'c', 'd', 'TooDeep.xcodeproj'), { recursive: true })
    fs.mkdirSync(path.join(tree, 'android'), { recursive: true })
    fs.writeFileSync(path.join(tree, 'android', 'build.gradle.kts'), '')
    const d = await run('xcode_discover', { folder: tree })
    const out = d.output ?? ''
    ok(
      'discover succeeds and is read-only',
      d.success && plugin.isReadOnlyCall('xcode_discover', { folder: tree }),
      d
    )
    ok('finds the workspace', out.includes(path.join(tree, 'Foo.xcworkspace')), out)
    ok(
      'finds the project and marks it shadowed by the workspace',
      new RegExp(`Foo\\.xcodeproj  \\(a workspace sits next to it`).test(out),
      out
    )
    ok('excludes Foo.xcodeproj/project.xcworkspace', !out.includes('project.xcworkspace'), out)
    ok('skips node_modules', !out.includes('Dep.xcodeproj'), out)
    ok(
      'walks to depth 3 and no deeper',
      out.includes('Deep.xcodeproj') && !out.includes('TooDeep.xcodeproj'),
      out
    )
    ok(
      'detects Flutter with its run path',
      out.includes(path.join(tree, 'flutter_app')) &&
        /Flutter: `flutter run -d <udid>` via shell_exec background=true/.test(out),
      out
    )
    ok(
      'detects Gradle with its run path',
      /Gradle \(Android\) projects:/.test(out) && /\.\/gradlew assembleDebug/.test(out),
      out
    )
    ok(
      'the Xcode run path recommends the workspace',
      out.includes(`xcode_defaults {project: "${path.join(tree, 'Foo.xcworkspace')}"`) &&
        /then xcode_run/.test(out),
      out
    )
    const missing = await run('xcode_discover', { folder: path.join(ROOT, 'nope') })
    ok(
      'a missing folder is an error',
      !missing.success && /does not exist/.test(missing.error ?? ''),
      missing
    )
    ok('discover never spawned a process', calls.length === 0, calls.length)
  }

  mod.__resetExecutor()
  fs.rmSync(ROOT, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
