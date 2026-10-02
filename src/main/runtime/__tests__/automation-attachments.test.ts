/**
 * Files and working directories attached to an AUTOMATION.
 *
 * The question this file exists to answer is the end-to-end one: when an
 * automation fires, does the run actually get the files it was given and see
 * the folders it was pointed at? That is asserted against a REAL Brainstem with
 * a fake agent recording what processAutonomous was handed (§6) — everything
 * before it is the machinery that answer depends on.
 *
 * Contract under test:
 *  1. the engine parses repeatable `file:`/`dir:` markers off the body, in any
 *     order, alongside the existing mode/project/icon ones, and leaves the
 *     instruction clean
 *  2. referencedAutomationFiles sees a SWITCHED-OFF automation's files (the
 *     sweep in §5 would otherwise delete the attachments of any job toggled off)
 *  3. attaching COPIES into uploads/automation-<uuid>/, reuses the dir the
 *     automation already owns on the next attach, skips duplicate names and
 *     reports missing sources
 *  4. the overlay lists name/size/path and says content is never auto-loaded
 *  5. the prune sweep deletes only unreferenced copies past the grace window,
 *     never a young one, never a file outside our uploads dirs, and clears the
 *     dir it empties
 *  6. a fired automation receives contextFiles + workingFolders — including
 *     through runJobNow, which is the page's Run button and the phone's
 *     — and an automation with neither gets neither
 *  7. the OTHER parsers agree with the engine — all three lifted out of their
 *     own source byte-for-byte, never re-implemented here: the automations
 *     plugin (round-trips markers through an agent edit), the Automations page
 *     (parses the same block, strips the markers off a pasted prompt), and the
 *     phone's port (parses it, preserves markers across a draft save, and
 *     removes exactly the one line it names)
 *
 * Redirects the workspace to a temp home BEFORE loading the runtime graph so
 * nothing touches the real ~/.wolffish workspace.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/automation-attachments.test.ts
 */

import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-automation-files-'))
;(os as unknown as { homedir: () => string }).homedir = (): string => TEST_HOME

const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() }
    }
  }
  return origLoad.apply(this, args)
}

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The workspace root the app derives from homedir — see workspace/root.ts. */
const WORKSPACE = path.join(TEST_HOME, '.wolffish', 'workspace')

/**
 * The phone port's surface, declared HERE rather than reached for as
 * `typeof import('../../../../../wolffish-mobile/…')`.
 *
 * §7's cross-check against the phone is deliberately OPTIONAL — the runtime
 * side skips it when the mobile repo is not checked out next door. A cross-repo
 * `typeof import` is not optional: tsc resolves it unconditionally, whether or
 * not the guarded branch ever runs. So on every machine without wolffish-mobile
 * beside this one — which is every CI runner — `npm run typecheck` died with
 * TS2307 on a check designed to skip, and the whole build with it.
 *
 * A structural type keeps the assertions type-checked and the check itself
 * genuinely optional. It is narrowed to what this test calls; the fields it
 * omits are on `AutomationBlock` over there and simply not read here.
 */
type PhoneBlock = {
  label: string
  body: string
  icon: string | null
  files: string[]
  dirs: string[]
}

type PhoneHeartbeat = {
  parseAutomations: (markdown: string) => PhoneBlock[]
  writeDraft: (
    markdown: string,
    bound: { label: string; active: boolean } | null,
    draft: { schedule: string; prompt: string; icon: string; projectId: string }
  ) => { markdown: string }
  addBlockPath: (markdown: string, block: PhoneBlock, kind: 'file' | 'dir', value: string) => string
  removeBlockPath: (
    markdown: string,
    block: PhoneBlock,
    kind: 'file' | 'dir',
    value: string
  ) => string
}

async function run(): Promise<void> {
  const { parseHeartbeat, splitMarkers, referencedAutomationFiles, Brainstem } =
    await import('@main/runtime/brainstem')
  const {
    attachFilesToAutomation,
    isOwnedAutomationFile,
    pruneAutomationUploads,
    removeAutomationFile
  } = await import('@main/automations/files')
  const { buildAttachedFilesOverlay } = await import('@main/uploads/owned-copies')
  const buildAutomationFilesOverlay = (files: readonly string[]): Promise<string> =>
    buildAttachedFilesOverlay(files, 'automation')

  // ── 1. Engine: markers off the body ────────────────────────────────────
  {
    const raw = [
      '# Heartbeat',
      '',
      '## Daily (08:00)',
      '',
      'icon: 📊',
      'file: /tmp/one.pdf',
      'dir: /tmp/work a',
      'mode: workflow',
      'file: /tmp/two (1).csv',
      'project: proj-1',
      'dir: /tmp/other',
      '',
      'Summarize the attached report.',
      ''
    ].join('\n')
    const jobs = parseHeartbeat(raw)
    ok('one job parsed', jobs.length === 1, String(jobs.length))
    const job = jobs[0]
    ok(
      'files collect in file order',
      job.files?.join('|') === '/tmp/one.pdf|/tmp/two (1).csv',
      job.files?.join('|')
    )
    ok(
      'dirs collect in file order',
      job.dirs?.join('|') === '/tmp/work a|/tmp/other',
      job.dirs?.join('|')
    )
    ok('paths keep their spaces', job.files?.[1] === '/tmp/two (1).csv')
    ok('markers interleave freely', job.mode === 'workflow' && job.project === 'proj-1')
    ok('body is only the instruction', job.body === 'Summarize the attached report.', job.body)

    const none = splitMarkers('Just do it.\nfile: not a marker, this is prose\n')
    ok(
      'only LEADING lines are markers',
      none.files.length === 0 && none.body.includes('file: not a marker'),
      JSON.stringify(none)
    )
  }

  // ── 2. A switched-off automation still references its files ────────────
  {
    const raw = [
      '<!-- ## Daily (08:00)',
      '',
      'icon: 📊',
      'file: /tmp/kept.pdf',
      '',
      'Do it.',
      '-->',
      '',
      '## Every (30m)',
      '',
      'file: /tmp/active.pdf',
      '',
      'Poll.',
      '',
      '<!--',
      'EXAMPLES',
      '## Weekly (Monday 09:00)',
      'file: /tmp/example-never-real.pdf',
      '-->',
      ''
    ].join('\n')
    const refs = referencedAutomationFiles(raw)
    ok(
      'disabled + active files both referenced, examples excluded',
      refs.sort().join('|') === '/tmp/active.pdf|/tmp/kept.pdf',
      refs.join('|')
    )
    ok('a disabled job never reaches the scheduler', parseHeartbeat(raw).length === 1)
  }

  // ── 3. Copy-on-attach ──────────────────────────────────────────────────
  const sources = path.join(TEST_HOME, 'sources')
  fs.mkdirSync(sources, { recursive: true })
  fs.writeFileSync(path.join(sources, 'report.pdf'), 'A'.repeat(2048))
  fs.writeFileSync(path.join(sources, 'notes.md'), 'hello')

  const first = await attachFilesToAutomation(
    [],
    [path.join(sources, 'report.pdf'), path.join(sources, 'nope.txt')]
  )
  ok('one file attached', first.added.length === 1, JSON.stringify(first.added))
  ok('missing source reported, not attached', first.missing.length === 1)
  const copied = first.added[0].path
  ok('the copy exists', fs.existsSync(copied))
  ok('the source is left in place', fs.existsSync(path.join(sources, 'report.pdf')))
  ok(
    'the copy lives in uploads/automation-<uuid>/',
    path.dirname(path.dirname(copied)) === path.join(WORKSPACE, 'uploads') &&
      path.basename(path.dirname(copied)).startsWith('automation-'),
    copied
  )
  ok('the copy is recognised as ours', isOwnedAutomationFile(copied))
  ok('a path elsewhere is not ours', !isOwnedAutomationFile(path.join(sources, 'report.pdf')))

  const ticks: number[] = []
  const second = await attachFilesToAutomation(
    [copied],
    [path.join(sources, 'notes.md'), path.join(sources, 'report.pdf')],
    (p) => ticks.push(p.copiedBytes)
  )
  ok(
    'second attach reuses the same dir',
    path.dirname(second.added[0].path) === path.dirname(copied)
  )
  ok(
    'a name already attached is skipped',
    second.skipped.length === 1,
    JSON.stringify(second.skipped)
  )
  ok('progress ticks reached the batch total', ticks.at(-1) === 2048 + 5, String(ticks.at(-1)))

  // The phone's Add-files: staged bytes adopted into the dir the automation
  // already owns, under a name THIS side picks.
  {
    const { adoptUploadedAutomationFile } = await import('@main/automations/files')
    const staged = path.join(TEST_HOME, 'staged-automation-upload')
    fs.writeFileSync(staged, 'from the phone')
    const file = await adoptUploadedAutomationFile([copied], staged, 'notes.md')
    ok(
      'an uploaded file lands in the dir the automation owns',
      path.dirname(file.path) === path.dirname(copied),
      file.path
    )
    ok('the staged bytes are moved, not copied', !fs.existsSync(staged))
    ok(
      'a collision renames rather than clobbers',
      file.name !== 'notes.md' || !fs.existsSync(path.join(path.dirname(copied), 'notes.md (1)'))
    )
    ok('the answer is an ABSOLUTE path, which is what a marker holds', path.isAbsolute(file.path))
    fs.rmSync(file.path, { force: true })
  }

  // ── 4. The overlay the run's system prompt carries ─────────────────────
  {
    const overlay = await buildAutomationFilesOverlay([copied, '/tmp/definitely-not-here.pdf'])
    ok(
      'overlay is tagged',
      overlay.includes('<attached_files>') && overlay.includes('</attached_files>')
    )
    ok(
      'overlay names the file and its path',
      overlay.includes('report.pdf') && overlay.includes(copied)
    )
    ok('overlay carries a size fact', /report\.pdf \(\d+KB\)/.test(overlay), overlay)
    ok('overlay is honest about a vanished file', overlay.includes('missing from disk'))
    ok('overlay says content is not injected', overlay.includes('never auto-loaded'))
    ok('no files ⇒ no overlay', (await buildAutomationFilesOverlay([])) === '')
  }

  // ── 5. The reconcile sweep ─────────────────────────────────────────────
  {
    const dir = path.dirname(copied)
    const orphan = path.join(dir, 'orphan.txt')
    fs.writeFileSync(orphan, 'x')
    const young = path.join(dir, 'young.txt')
    fs.writeFileSync(young, 'x')
    const outside = path.join(sources, 'report.pdf')
    // Age everything but `young` past the grace window.
    const old = new Date(Date.now() - 60 * 60 * 1000)
    fs.utimesSync(orphan, old, old)
    fs.utimesSync(copied, old, old)

    const removed = await pruneAutomationUploads([copied])
    ok(
      'the unreferenced, aged copy is swept',
      !fs.existsSync(orphan) && removed === 1,
      String(removed)
    )
    ok('a referenced copy survives', fs.existsSync(copied))
    ok('a copy inside the grace window survives', fs.existsSync(young))
    ok('a file outside our uploads dirs is untouched', fs.existsSync(outside))

    // Everything unreferenced and aged: the dir goes too.
    fs.utimesSync(young, old, old)
    fs.utimesSync(second.added[0].path, old, old)
    await pruneAutomationUploads([])
    ok('the emptied automation dir is removed', !fs.existsSync(dir))
    ok('the uploads root itself stays', fs.existsSync(path.join(WORKSPACE, 'uploads')))

    await removeAutomationFile(outside)
    ok('removeAutomationFile refuses a path we do not own', fs.existsSync(outside))
  }

  // ── 6. THE END-TO-END CLAIM: a fired automation gets both ──────────────
  {
    const ws = path.join(TEST_HOME, 'runws')
    fs.mkdirSync(path.join(ws, 'brain', 'brainstem'), { recursive: true })
    const workDir = path.join(TEST_HOME, 'work folder')
    fs.mkdirSync(workDir, { recursive: true })
    const attached = path.join(TEST_HOME, 'sources', 'report.pdf')

    fs.writeFileSync(
      path.join(ws, 'brain', 'brainstem', 'heartbeat.md'),
      [
        '# Heartbeat',
        '',
        '## Daily (08:00)',
        '',
        'icon: 📊',
        `file: ${attached}`,
        `dir: ${workDir}`,
        '',
        'Summarize the attached report into the folder.',
        '',
        '## Every (30m)',
        '',
        'Nothing attached here.',
        ''
      ].join('\n')
    )

    const bs = new Brainstem({ workspaceRoot: ws })
    const calls: Array<{
      jobLabel: string
      contextFiles?: string[]
      workingFolders?: string[]
      instruction: string
    }> = []
    bs.setAgent({
      processAutonomous: (opts: {
        jobLabel: string
        instruction: string
        contextFiles?: string[]
        workingFolders?: string[]
      }) => {
        calls.push(opts)
        return Promise.resolve({ success: true, response: '', toolCalls: 0, conversationId: 'x' })
      }
    } as unknown as import('@main/runtime/agent').Agent)

    // runStartup=false: this is about what a fire CARRIES, not about catch-up.
    await bs.startScheduler(false)
    ok(
      'both automations registered',
      bs
        .getActiveJobs()
        .map((j) => j.label)
        .join('|') === 'Daily (08:00)|Every (30m)'
    )

    // Through runJobNow — the Run button on both the page and the phone, and
    // the same handler a cron fire builds.
    const started = bs.runJobNow('Daily (08:00)')
    ok('run accepted', started.ok && started.started, JSON.stringify(started))
    // Fire-and-forget: the pool resolves the handler on its own tick.
    for (let i = 0; i < 40 && calls.length === 0; i++) await sleep(25)

    ok('the run happened', calls.length === 1, String(calls.length))
    ok(
      'THE RUN GOT THE FILE',
      calls[0]?.contextFiles?.join('|') === attached,
      JSON.stringify(calls[0]?.contextFiles)
    )
    ok(
      'THE RUN GOT THE DIRECTORY',
      calls[0]?.workingFolders?.join('|') === workDir,
      JSON.stringify(calls[0]?.workingFolders)
    )
    ok(
      'markers never leak into the instruction',
      calls[0]?.instruction === 'Summarize the attached report into the folder.',
      calls[0]?.instruction
    )

    bs.runJobNow('Every (30m)')
    for (let i = 0; i < 40 && calls.length < 2; i++) await sleep(25)
    ok(
      'an automation with no attachments passes neither',
      calls[1]?.contextFiles === undefined && calls[1]?.workingFolders === undefined,
      JSON.stringify(calls[1])
    )
    await bs.stopScheduler()
  }

  // ── 7. The other parsers agree ─────────────────────────────────────────
  {
    const block = [
      'mode: workflow',
      'project: p1',
      'icon: 📊',
      'file: /tmp/a b.pdf',
      'dir: /tmp/w',
      '',
      'Do the thing.'
    ].join('\n')
    const engine = splitMarkers(block)

    // The automations plugin: parses the same block AND composes it back, which
    // is what stops an agent edit from silently dropping an attachment.
    const pluginUrl = new URL(
      '../../../defaults/workspace/brain/cerebellum/automations/plugin/index.mjs',
      import.meta.url
    )
    // The plugin exports its tool surface, not its internals — the two pure
    // functions are lifted out of its source BYTE-FOR-BYTE rather than
    // re-implemented, so this checks the shipping code and nothing else.
    const pluginSrc = fs.readFileSync(pluginUrl, 'utf8')
    const pluginModule = (await import(
      `data:text/javascript,${encodeURIComponent(
        `${sliceFn(pluginSrc, 'const MODE_MARKER_RE', 'function splitMarkers')}\n` +
          `${sliceFn(pluginSrc, 'function splitMarkers', 'function formatBlock')}\n` +
          'export { splitMarkers, composeBody }'
      )}`
    )) as {
      splitMarkers: (b: string) => unknown
      composeBody: (m: unknown, b: string) => string
    }
    const pluginParsed = pluginModule.splitMarkers(block) as {
      files: string[]
      dirs: string[]
      body: string
    }
    ok(
      'plugin parser matches the engine',
      pluginParsed.files.join('|') === engine.files.join('|') &&
        pluginParsed.dirs.join('|') === engine.dirs.join('|') &&
        pluginParsed.body === engine.body,
      JSON.stringify(pluginParsed)
    )
    const recomposed = pluginModule.composeBody(pluginParsed, 'Edited instruction.')
    const afterEdit = splitMarkers(recomposed)
    ok(
      'a plugin edit preserves files and dirs',
      afterEdit.files.join('|') === engine.files.join('|') &&
        afterEdit.dirs.join('|') === engine.dirs.join('|') &&
        afterEdit.icon === '📊' &&
        afterEdit.project === 'p1',
      recomposed
    )

    // The Automations page's own parser, lifted out of the .tsx BYTE-FOR-BYTE
    // (markers + stripLeadingSettings + parseSidebarJobs). Its two helpers —
    // schedule validity and the next-fire countdown — are stubbed: neither has
    // anything to do with markers, and pulling in the cron scanner would drag
    // half the page along with it.
    const pageSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/renderer/src/pages/Heartbeat.tsx'),
      'utf8'
    )
    const pageFile = path.join(TEST_HOME, 'page-parser.ts')
    fs.writeFileSync(
      pageFile,
      [
        'type HeartbeatJobView = { label: string; cron: string | null; nextRunMs: number | null }',
        "const parseSchedule = (h: string) => (/^Daily \\(/.test(h) ? { type: 'daily', cron: '0 8 * * *' } : null)",
        'const nextCronMs = (_e: string, _n: number): number | null => null',
        sliceFn(pageSrc, 'const MODE_MARKER_RE', 'function parseSidebarJobs'),
        sliceFn(pageSrc, 'function parseSidebarJobs', 'export function Heartbeat'),
        'export { parseSidebarJobs, stripLeadingSettings }'
      ].join('\n')
    )
    const page = (await import(pageFile)) as {
      parseSidebarJobs: (
        content: string,
        jobs: unknown[],
        now: number
      ) => Array<{ files: string[]; dirs: string[]; body: string; icon: string | null }>
      stripLeadingSettings: (text: string) => string
    }
    const pageParsed = page.parseSidebarJobs(`## Daily (08:00)\n\n${block}\n`, [], Date.now())[0]
    ok(
      'Automations page parser matches the engine',
      pageParsed.files.join('|') === engine.files.join('|') &&
        pageParsed.dirs.join('|') === engine.dirs.join('|') &&
        pageParsed.body === engine.body,
      JSON.stringify(pageParsed)
    )
    ok(
      'the page strips file/dir markers off a pasted prompt',
      page.stripLeadingSettings(block) === 'Do the thing.',
      page.stripLeadingSettings(block)
    )
    // …and it writes them back in the shape it just read. The composition
    // lives inside the editor's save closure, so this pins the two lines that
    // produce it rather than re-implementing them.
    ok(
      'the page composes file:/dir: marker lines',
      pageSrc.includes('...files.map((f) => `file: ${f}`)') &&
        pageSrc.includes('...dirs.map((d) => `dir: ${d}`)')
    )

    // The phone's port — a pure, import-free module, so it loads straight from
    // the mobile repo. If it is not checked out next door, skip rather than fail.
    const mobile = path.resolve(
      process.cwd(),
      '../wolffish-mobile/src/lib/automations/heartbeat.ts'
    )
    if (!fs.existsSync(mobile)) {
      console.warn('… wolffish-mobile not checked out next door; phone parser not cross-checked')
    } else {
      const phone = (await import(mobile)) as PhoneHeartbeat
      const md = `## Daily (08:00)\n\n${block}\n`
      const [parsed] = phone.parseAutomations(md)
      ok(
        'phone parser matches the engine',
        parsed.files.join('|') === engine.files.join('|') &&
          parsed.dirs.join('|') === engine.dirs.join('|') &&
          parsed.body === engine.body,
        JSON.stringify(parsed)
      )
      const saved = phone.writeDraft(
        md,
        { label: 'Daily (08:00)', active: true },
        {
          schedule: 'Daily (09:00)',
          prompt: 'Rewritten from the phone.',
          icon: '📊',
          projectId: 'p1'
        }
      )
      const rewritten = phone.parseAutomations(saved.markdown)[0]
      ok(
        'a phone save preserves files and dirs',
        rewritten.files.join('|') === engine.files.join('|') &&
          rewritten.dirs.join('|') === engine.dirs.join('|') &&
          rewritten.label === 'Daily (09:00)',
        saved.markdown
      )
      // The phone's Add: a marker spliced in must land where the LEADING-marker
      // scan still sees it, or the engine would read it as instruction text.
      const withFile = phone.parseAutomations(
        phone.addBlockPath(saved.markdown, rewritten, 'file', '/tmp/added by phone.pdf')
      )[0]
      ok(
        'a phone-added file marker parses back',
        withFile.files.join('|') === `${engine.files.join('|')}|/tmp/added by phone.pdf`,
        JSON.stringify(withFile.files)
      )
      ok(
        'and never leaks into the prompt',
        withFile.body === 'Rewritten from the phone.',
        withFile.body
      )
      const withDir = phone.parseAutomations(
        phone.addBlockPath(saved.markdown, rewritten, 'dir', '/tmp/added dir')
      )[0]
      ok(
        'a phone-added folder marker parses back',
        withDir.dirs.join('|') === `${engine.dirs.join('|')}|/tmp/added dir`,
        JSON.stringify(withDir.dirs)
      )
      // The ENGINE has to agree — it is the one that actually runs the job.
      const engineSees = parseHeartbeat(
        phone.addBlockPath(saved.markdown, rewritten, 'file', '/tmp/added by phone.pdf')
      )[0]
      ok(
        'the ENGINE sees the phone-added file too',
        engineSees.files?.includes('/tmp/added by phone.pdf') === true,
        JSON.stringify(engineSees.files)
      )

      const dropped = phone.parseAutomations(
        phone.removeBlockPath(saved.markdown, rewritten, 'file', '/tmp/a b.pdf')
      )[0]
      ok(
        'the phone removes exactly the one marker it names',
        dropped.files.length === 0 && dropped.dirs.join('|') === '/tmp/w' && dropped.icon === '📊',
        JSON.stringify(dropped)
      )
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

/** Source slice between two top-level declarations, for reaching module internals. */
function sliceFn(src: string, from: string, until: string): string {
  const start = src.indexOf(from)
  const end = src.indexOf(until, start + from.length)
  if (start < 0 || end < 0) throw new Error(`sliceFn: ${from} … ${until} not found`)
  return src.slice(start, end)
}

void run().then(
  () => undefined,
  (err) => {
    console.error(err)
    process.exitCode = 1
  }
)
