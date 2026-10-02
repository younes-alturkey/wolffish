/**
 * What the MODEL actually receives — and whether both screens hear about it.
 *
 * The sibling files prove the plumbing carries files and folders to a run.
 * This one answers the two questions that plumbing does not:
 *
 *  A. CONTEXT — assemble the real prompt material for a project, a procedure
 *     and an automation, and assert the model is told each file's name, size
 *     and PATH (so it can open it), each folder's path AND its live contents
 *     (so it can work in it), and in every case that it must read rather than
 *     assume. The working-folder block is rendered from a directory whose
 *     contents are changed between two renders, because "fresh listing every
 *     iteration" is the whole reason folders don't ride the system prompt.
 *
 *  B. SYNC — every write that touches an attachment must fire the store's
 *     changed listener, because that listener is what broadcasts to this app's
 *     open page AND pushes to the phone. A write that silently skips it leaves
 *     one of the two screens stale, which is invisible until someone looks.
 *
 * Redirects the workspace to a temp home BEFORE loading the runtime graph so
 * nothing touches the real ~/.wolffish workspace.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/attachment-context.test.ts
 */

import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-attach-context-'))
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

const WORKSPACE = path.join(TEST_HOME, '.wolffish', 'workspace')

async function run(): Promise<void> {
  fs.mkdirSync(path.join(WORKSPACE, 'brain'), { recursive: true })

  const projects = await import('@main/projects')
  const procedures = await import('@main/procedures')
  const { buildAttachedFilesOverlay } = await import('@main/uploads/owned-copies')
  const { attachFilesToAutomation } = await import('@main/automations/files')

  // A real folder with real contents — the working-folder block is a live
  // readdir, so anything stubbed here would prove nothing.
  const workDir = path.join(TEST_HOME, 'reports')
  fs.mkdirSync(path.join(workDir, 'archive'), { recursive: true })
  fs.writeFileSync(path.join(workDir, 'q3.csv'), 'a,b,c')
  const sources = path.join(TEST_HOME, 'sources')
  fs.mkdirSync(sources, { recursive: true })
  fs.writeFileSync(path.join(sources, 'handbook.pdf'), 'P'.repeat(4096))

  // ── A1. Project: instructions + files + folders in the system prompt ───
  {
    const project = await projects.createProject({
      title: 'Quarterly report',
      icon: '📊',
      instructions: 'Always cite the source table.'
    })
    const attached = await projects.attachFilesToProject(project.id, [
      path.join(sources, 'handbook.pdf')
    ])
    await projects.updateProject({ id: project.id, directories: [workDir] })

    const overlay = await projects.buildProjectOverlay(project.id)
    const filePath = attached.added[0].path
    ok('project overlay is tagged', overlay.includes('<project>') && overlay.includes('</project>'))
    ok(
      'project overlay carries the instructions verbatim',
      overlay.includes('Always cite the source table.')
    )
    ok(
      'the model is told the file NAME, SIZE and PATH',
      overlay.includes('handbook.pdf') &&
        /handbook\.pdf \(\d+KB\) at /.test(overlay) &&
        overlay.includes(filePath),
      overlay
    )
    ok(
      'the model is told to READ rather than assume',
      overlay.includes('content is never auto-loaded') &&
        overlay.includes('Never guess or claim knowledge of file contents'),
      overlay
    )
    ok(
      'the model is told which tools to open it with',
      overlay.includes('pdf_read') &&
        overlay.includes('file_read') &&
        overlay.includes('image_view')
    )
    ok('the working folder is named in the overlay', overlay.includes(workDir), overlay)
    ok(
      'and framed as where to work',
      overlay.includes('assume paths the user mentions are relative to these'),
      overlay
    )
    // The folders reach the TURN through workingFolders, which is what makes
    // them live — asserted for content in A4.
    const folders = await projects.projectWorkingFolders(project.id)
    ok('project folders resolve for the turn', folders.join('|') === workDir, folders.join('|'))
    ok(
      'an unknown project resolves to nothing rather than throwing',
      (await projects.projectWorkingFolders('nope')).length === 0
    )
  }

  // ── A2. Procedure: the same file contract, named as a procedure ────────
  {
    const proc = await procedures.createProcedure({ title: 'Digest', prompt: 'Summarize it.' })
    const attached = await procedures.attachFilesToProcedure(proc.id, [
      path.join(sources, 'handbook.pdf')
    ])
    const overlay = await procedures.buildProcedureFilesOverlay([attached.added[0].path])
    ok('procedure overlay is tagged', overlay.includes('<attached_files>'))
    ok(
      'it names the PROCEDURE as the owner',
      overlay.includes('This procedure has 1 attached file'),
      overlay
    )
    ok(
      'with name, size, path and the read-first rule',
      /handbook\.pdf \(\d+KB\) at /.test(overlay) &&
        overlay.includes('never auto-loaded') &&
        overlay.includes('Never guess'),
      overlay
    )
    ok(
      'and permission to hand it on when the task calls for it',
      overlay.includes('attach or send them when the task calls for it'),
      overlay
    )
  }

  // ── A3. Automation: same block, named as an automation ────────────────
  {
    const attached = await attachFilesToAutomation([], [path.join(sources, 'handbook.pdf')])
    const overlay = await buildAttachedFilesOverlay([attached.added[0].path], 'automation')
    ok(
      'it names the AUTOMATION as the owner',
      overlay.includes('This automation has 1 attached file'),
      overlay
    )
    ok(
      'with the same read-first contract',
      /handbook\.pdf \(\d+KB\) at /.test(overlay) && overlay.includes('never auto-loaded')
    )
  }

  // ── A4. Working folders are LIVE, and that is the point ───────────────
  {
    // renderWorkingFolders is Agent-private; the test drives the same readdir
    // contract through the exported seam the turn actually uses. Lifted from
    // Agent.ts BYTE-FOR-BYTE so this checks the shipping renderer.
    const agentSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/main/runtime/agent/Agent.ts'),
      'utf8'
    )
    const start = agentSrc.indexOf('/** Entries listed per working folder in the volatile tail. */')
    const end = agentSrc.indexOf('function segmentReasonFor')
    const file = path.join(TEST_HOME, 'render-working-folders.ts')
    fs.writeFileSync(
      file,
      `import fs from 'node:fs/promises'\n${agentSrc.slice(start, end)}\nexport { renderWorkingFolders }`
    )
    const rendered = (await import(file)) as {
      renderWorkingFolders: (folders: string[]) => Promise<string>
    }
    const render = rendered.renderWorkingFolders

    const before = await render([workDir])
    ok('the folder block is tagged', before.includes('<working_folders>'), before)
    ok('it names the folder', before.includes(workDir))
    ok('and LISTS its contents, which is what a listing is for', before.includes('q3.csv'), before)
    ok('directories are marked as such', before.includes('archive/'), before)
    ok(
      'the model is told to read paths relative to it',
      before.includes('assume they are relative to these unless stated otherwise'),
      before
    )

    // The reason folders do NOT ride the system prompt: a run writes a file and
    // the next iteration has to see it.
    fs.writeFileSync(path.join(workDir, 'q4.csv'), 'd,e,f')
    const after = await render([workDir])
    ok('a file the run just created shows up on the next render', after.includes('q4.csv'), after)
    ok('the earlier render did NOT have it (it is genuinely re-read)', !before.includes('q4.csv'))

    const gone = await render([path.join(TEST_HOME, 'not-a-folder')])
    ok(
      'an unreadable folder says so rather than vanishing',
      gone.includes('could not read contents'),
      gone
    )
  }

  // ── B. Sync: every attachment write announces itself ───────────────────
  {
    let projectPushes = 0
    let procedurePushes = 0
    projects.setProjectsChangedListener(() => {
      projectPushes += 1
    })
    procedures.setProceduresChangedListener(() => {
      procedurePushes += 1
    })

    // These two listeners are the ONE place index.ts hangs both the desktop
    // broadcast and mobileChannel.push*Changed off — so "the listener fired"
    // is exactly "both screens were told".
    const project = await projects.createProject({ title: 'Sync', instructions: '' })
    const proc = await procedures.createProcedure({ title: 'Sync', prompt: 'x' })
    projectPushes = 0
    procedurePushes = 0

    await projects.attachFilesToProject(project.id, [path.join(sources, 'handbook.pdf')])
    ok('attaching a project file announces it', projectPushes === 1, String(projectPushes))
    await projects.updateProject({ id: project.id, directories: [workDir] })
    ok('adding a project folder announces it', projectPushes === 2, String(projectPushes))
    await projects.updateProject({ id: project.id, files: [] })
    ok('detaching a project file announces it', projectPushes === 3, String(projectPushes))

    const staged = path.join(TEST_HOME, 'staged-1')
    fs.writeFileSync(staged, 'from the phone')
    await projects.adoptUploadedProjectFile(project.id, staged, 'phone.txt')
    ok("a PHONE's project upload announces it too", projectPushes === 4, String(projectPushes))

    await procedures.attachFilesToProcedure(proc.id, [path.join(sources, 'handbook.pdf')])
    ok('attaching a procedure file announces it', procedurePushes === 1, String(procedurePushes))
    await procedures.updateProcedure({ id: proc.id, directories: [workDir] })
    ok('adding a procedure folder announces it', procedurePushes === 2, String(procedurePushes))
    await procedures.updateProcedure({ id: proc.id, files: [] })
    ok('detaching a procedure file announces it', procedurePushes === 3, String(procedurePushes))

    const staged2 = path.join(TEST_HOME, 'staged-2')
    fs.writeFileSync(staged2, 'from the phone')
    await procedures.adoptUploadedProcedureFile(proc.id, staged2, 'phone.txt')
    ok(
      "a PHONE's procedure upload announces it too",
      procedurePushes === 4,
      String(procedurePushes)
    )

    projects.setProjectsChangedListener(null)
    procedures.setProceduresChangedListener(null)

    // Automations have no store listener — heartbeat.md IS the store, and BOTH
    // screens are driven by the scheduler reload the file write triggers. That
    // reload is corpus 'brainstem.schedulerReloaded', which index.ts turns into
    // heartbeat:changed + pushAutomationsChanged. Pinned at the source, because
    // a dropped push here is invisible until a phone goes stale.
    const indexSrc = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8')
    ok(
      'an automation edit reaches BOTH screens off the scheduler reload',
      /brainstem\.schedulerReloaded[\s\S]{0,400}heartbeat:changed[\s\S]{0,200}pushAutomationsChanged/.test(
        indexSrc
      )
    )
    ok(
      'a project write reaches both screens',
      /setProjectsChangedListener\([\s\S]{0,400}projects:changed[\s\S]{0,300}pushProjectsChanged/.test(
        indexSrc
      )
    )
    ok(
      'a procedure write reaches both screens',
      /setProceduresChangedListener\([\s\S]{0,400}procedures:changed[\s\S]{0,300}pushProceduresChanged/.test(
        indexSrc
      )
    )
    // And the other direction: the phone's own writes go through the SAME
    // store functions, so they fire the same listeners the assertions above
    // just counted.
    const channelSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/main/channels/mobile/channel.ts'),
      'utf8'
    )
    ok(
      "the phone's project edits go through the desktop's own store",
      channelSrc.includes('await updateProject({') &&
        channelSrc.includes('adoptUploadedProjectFile(')
    )
    ok(
      "the phone's procedure edits go through the desktop's own store",
      channelSrc.includes('await updateProcedure({') &&
        channelSrc.includes('adoptUploadedProcedureFile(')
    )
    ok(
      "the phone's automation edits write the same file the scheduler watches",
      channelSrc.includes('await writeViewerFile(HEARTBEAT_PATH, markdown)')
    )
  }

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
