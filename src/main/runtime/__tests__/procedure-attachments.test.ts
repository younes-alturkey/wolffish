/**
 * Files and working directories attached to a PROCEDURE.
 *
 * Same question as its automation sibling, on the other store: when a procedure
 * runs, does it actually get the files it was given and see the folders it was
 * pointed at? A procedure has TWO run paths, so both are asserted —
 * `procedure_run` (detached, through a real Brainstem with a fake agent) and
 * the Play button (a chat turn, through the TurnRunner's own respond options).
 *
 * Contract under test:
 *  1. attaching COPIES into uploads/procedure-<id>/ and records the refs;
 *     duplicate names are skipped, missing sources reported
 *  2. detaching DELETES the copy we own; deleting the procedure takes the dir
 *  3. a phone's whole-list replace can only ever KEEP refs the procedure holds
 *     (the guard that stops an invented path entering a list whose removals
 *     delete files), and its directory paths are checked against this machine
 *  4. the overlay names the procedure and lists name/size/path
 *  5. the DETACHED path (procedure_run → runDetached) hands the run
 *     contextFiles + workingFolders
 *  6. the PLAY path threads the same two through the chat turn — asserted at
 *     the seam that actually carries them (TurnRunner → agent.respond)
 *
 * Redirects the workspace to a temp home BEFORE loading the runtime graph so
 * nothing touches the real ~/.wolffish workspace.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/procedure-attachments.test.ts
 */

import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-procedure-files-'))
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

async function run(): Promise<void> {
  fs.mkdirSync(path.join(WORKSPACE, 'brain'), { recursive: true })

  const {
    attachFilesToProcedure,
    adoptUploadedProcedureFile,
    buildProcedureFilesOverlay,
    createProcedure,
    deleteProcedure,
    listProcedures,
    procedureDirName,
    updateProcedure
  } = await import('@main/procedures')
  const { resolveWorkingDirectory } = await import('@main/uploads/owned-copies')
  const { Brainstem } = await import('@main/runtime/brainstem')

  const sources = path.join(TEST_HOME, 'sources')
  fs.mkdirSync(sources, { recursive: true })
  fs.writeFileSync(path.join(sources, 'report.pdf'), 'A'.repeat(2048))
  fs.writeFileSync(path.join(sources, 'notes.md'), 'hello')
  const workDir = path.join(TEST_HOME, 'work folder')
  fs.mkdirSync(workDir, { recursive: true })

  // ── 1. Copy-on-attach ──────────────────────────────────────────────────
  const proc = await createProcedure({ title: 'Weekly digest', prompt: 'Summarize it.' })
  ok('a fresh procedure has no attachments', (proc.files ?? []).length === 0)

  const ticks: number[] = []
  const first = await attachFilesToProcedure(
    proc.id,
    [path.join(sources, 'report.pdf'), path.join(sources, 'nope.txt')],
    (p) => ticks.push(p.copiedBytes)
  )
  ok('one file attached', first.added.length === 1, JSON.stringify(first.added))
  ok('missing source reported, not attached', first.missing.length === 1)
  ok('progress ticks reached the batch total', ticks.at(-1) === 2048, String(ticks.at(-1)))
  const copied = first.added[0].path
  ok('the copy exists', fs.existsSync(copied))
  ok('the source is left in place', fs.existsSync(path.join(sources, 'report.pdf')))
  ok(
    'the copy lives in uploads/procedure-<id>/',
    path.dirname(copied) === path.join(WORKSPACE, 'uploads', procedureDirName(proc.id)),
    copied
  )
  ok('the store records the ref', (first.procedure.files ?? []).length === 1)

  const second = await attachFilesToProcedure(proc.id, [path.join(sources, 'report.pdf')])
  ok('a name already attached is skipped', second.skipped.length === 1 && second.added.length === 0)

  // The phone's Add-files: staged bytes adopted under a name THIS side picks.
  const staged = path.join(TEST_HOME, 'staged-upload')
  fs.writeFileSync(staged, 'from the phone')
  const adopted = await adoptUploadedProcedureFile(proc.id, staged, 'notes.md')
  ok(
    'an uploaded file is adopted into the same dir',
    path.dirname(adopted.file.path) === path.dirname(copied)
  )
  ok('the staged bytes are moved, not copied', !fs.existsSync(staged))
  ok('both files are now attached', (adopted.procedure.files ?? []).length === 2)

  // ── 2. Detaching deletes the copy; deleting takes the dir ──────────────
  const kept = (adopted.procedure.files ?? []).filter((f) => f.path === copied)
  await updateProcedure({ id: proc.id, files: kept })
  ok('the detached copy is deleted', !fs.existsSync(adopted.file.path))
  ok('the kept copy survives', fs.existsSync(copied))

  await updateProcedure({ id: proc.id, directories: [workDir] })
  const stored = (await listProcedures()).find((p) => p.id === proc.id)
  ok(
    'directories persist',
    stored?.directories?.join('|') === workDir,
    JSON.stringify(stored?.directories)
  )

  // ── 3. What a whole-list replace may and may not delete ───────────────
  {
    // Dropping a ref DELETES the copy — but only inside the procedure's own
    // uploads dir. A ref pointing anywhere else was never ours (a legacy row,
    // a hand-edited JSON, a path the phone sent) and dropping it must leave
    // the file exactly where it is. Both halves in one replace.
    const outside = path.join(sources, 'shared-original.csv')
    fs.writeFileSync(outside, 'a,b,c')
    const owned = await attachFilesToProcedure(proc.id, [path.join(sources, 'notes.md')])
    const ownedCopy = owned.added[0].path
    await updateProcedure({
      id: proc.id,
      files: [
        { path: copied, name: 'report.pdf' },
        { path: ownedCopy, name: 'notes.md' },
        { path: outside, name: 'shared-original.csv' }
      ]
    })
    await updateProcedure({ id: proc.id, files: [{ path: copied, name: 'report.pdf' }] })
    ok('dropping OUR copy deletes it', !fs.existsSync(ownedCopy))
    ok('dropping a ref we never owned leaves the file alone', fs.existsSync(outside))
    ok('the kept copy is still there', fs.existsSync(copied))

    // The phone types a folder path, so the DESKTOP is what decides whether it
    // names anything — one answer with one wording for both directions.
    const good = await resolveWorkingDirectory(workDir)
    ok('an existing folder resolves', good.ok && good.path === workDir)
    const missing = await resolveWorkingDirectory(path.join(TEST_HOME, 'no-such-folder'))
    ok('a folder that is not there is refused', !missing.ok)
    const notADir = await resolveWorkingDirectory(path.join(sources, 'report.pdf'))
    ok(
      'a file is refused as a working folder',
      !notADir.ok && notADir.error.includes('not a folder')
    )
    const tilde = await resolveWorkingDirectory('~')
    ok('a ~ path resolves to home', tilde.ok && tilde.path === TEST_HOME, JSON.stringify(tilde))
  }

  // ── 4. The overlay ────────────────────────────────────────────────────
  {
    const overlay = await buildProcedureFilesOverlay([copied])
    ok('overlay is tagged', overlay.includes('<attached_files>'))
    ok(
      'overlay names the procedure',
      overlay.includes('This procedure has 1 attached file'),
      overlay
    )
    ok('overlay carries name, size and path', /report\.pdf \(\d+KB\) at /.test(overlay), overlay)
    ok('no files ⇒ no overlay', (await buildProcedureFilesOverlay([])) === '')
  }

  // ── 5. THE DETACHED PATH: procedure_run ───────────────────────────────
  {
    const ws = path.join(TEST_HOME, 'runws')
    fs.mkdirSync(path.join(ws, 'brain', 'brainstem'), { recursive: true })
    const bs = new Brainstem({ workspaceRoot: ws })
    const calls: Array<{
      channel?: string
      contextFiles?: string[]
      workingFolders?: string[]
    }> = []
    bs.setAgent({
      processAutonomous: (opts: {
        channel?: string
        contextFiles?: string[]
        workingFolders?: string[]
      }) => {
        calls.push(opts)
        return Promise.resolve({ success: true, response: '', toolCalls: 0, conversationId: 'x' })
      }
    } as unknown as import('@main/runtime/agent').Agent)

    // Exactly what index.ts's proceduresHost.run() passes.
    const current = (await listProcedures()).find((p) => p.id === proc.id)
    const started = bs.runDetached(
      current!.prompt,
      current!.title,
      `procedure:${current!.id}`,
      current!.mode ?? null,
      current!.icon ?? '📋',
      current!.projectId ?? null,
      (current!.files ?? []).map((f) => f.path),
      current!.directories ?? []
    )
    ok('run accepted', started.ok && started.started, JSON.stringify(started))
    for (let i = 0; i < 40 && calls.length === 0; i++) await sleep(25)

    ok('the run happened', calls.length === 1, String(calls.length))
    ok(
      'THE DETACHED RUN GOT THE FILE',
      calls[0]?.contextFiles?.join('|') === copied,
      JSON.stringify(calls[0]?.contextFiles)
    )
    ok(
      'THE DETACHED RUN GOT THE DIRECTORY',
      calls[0]?.workingFolders?.join('|') === workDir,
      JSON.stringify(calls[0]?.workingFolders)
    )
    ok(
      'it is stamped as a procedure, which is what names the overlay',
      calls[0]?.channel === 'procedure',
      calls[0]?.channel
    )
    await bs.stopScheduler()
  }

  // ── 6. THE PLAY PATH: the chat turn ───────────────────────────────────
  {
    // Play's chain is renderer → chat:send → ElectronChannel → TurnRunner →
    // agent.respond. Driving it end to end would mean booting a TurnRunner
    // with a titler, a corpus and a thalamus — so what is checked instead is
    // the thing that actually breaks: a HOP THAT FORGETS TO FORWARD. Every
    // link compiles perfectly with the field dropped, which is exactly why
    // typechecking cannot answer this and each forwarding expression is
    // pinned here by name.
    const reads = (file: string): string => fs.readFileSync(path.join(process.cwd(), file), 'utf8')

    const chat = reads('src/renderer/src/pages/Chat.tsx')
    ok(
      'Chat seeds the conversation from the played procedure',
      chat.includes('conv.contextFiles = files.length > 0 ? files : null') &&
        chat.includes('conv.workingFolder = directories.length > 0 ? directories : null')
    )
    ok(
      'Chat sends both lists on every turn of that conversation',
      chat.includes('workingFolders: opts?.workingFolders ?? workingFolders') &&
        chat.includes('contextFiles: opts?.contextFiles ?? contextFiles')
    )
    ok(
      'a conversation reopened later still carries its files',
      chat.includes(
        'setStoredContextFiles(Array.isArray(conv.contextFiles) ? conv.contextFiles : [])'
      )
    )
    ok(
      'the chat:send IPC payload declares contextFiles',
      /chat:send[\s\S]{0,600}contextFiles\?: string\[\]/.test(reads('src/main/index.ts'))
    )
    ok(
      'ElectronChannel forwards it to the runner',
      reads('src/main/channels/electron/channel.ts').includes('contextFiles: payload.contextFiles')
    )
    const runner = reads('src/main/channels/turn-runner.ts')
    ok(
      'the runner forwards both into agent.respond',
      runner.includes('contextFiles: opts.contextFiles') &&
        runner.includes('workingFolders: opts.workingFolders')
    )
    ok(
      'and names the overlay for a procedure on this path',
      runner.includes("contextFilesOwner: 'procedure'")
    )
    // The far end of every one of those hops is executed above (§5) and in
    // Agent.runRespond, whose overlay is asserted in §4.
  }

  // ── 2b. Deleting the procedure takes its dir ──────────────────────────
  const dir = path.join(WORKSPACE, 'uploads', procedureDirName(proc.id))
  ok('the uploads dir is there before the delete', fs.existsSync(dir))
  await deleteProcedure(proc.id)
  ok('deleting the procedure removes its uploads dir', !fs.existsSync(dir))
  ok('the source files are untouched', fs.existsSync(path.join(sources, 'report.pdf')))

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void run().then(
  () => undefined,
  (err) => {
    console.error(err)
    process.exitCode = 1
  }
)
