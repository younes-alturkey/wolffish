/**
 * Files and working folders on all three owners, end to end, in a temp
 * workspace.
 *
 * `cli:ownerFiles` / `cli:ownerFolders` run for real and the surrounding
 * channels route to the same main functions index.ts's handlers call, so what
 * is exercised is the whole path a terminal takes: CLI command → IPC → copy
 * into the workspace → store write → read back.
 *
 * The contracts worth guarding here are the ones that fail SILENTLY:
 *  - an attach must COPY into the workspace, never reference the original,
 *    or the owner dangles the first time a source file moves;
 *  - an automation's copy and its `file:` marker must land together, and the
 *    rewrite must leave the heading, the other markers and the prompt alone;
 *  - the scheduler's own parser must see what the CLI wrote;
 *  - a working folder that does not exist must be REPORTED, not stored — an
 *    unchecked one fails inside a run, where nobody is watching.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *        src/main/channels/__tests__/cli-owners.test.ts
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const Module = require('node:module')
const origLoad = Module._load
const APP = require('node:path').resolve(__dirname, '../../../..')
Module._load = function (request: string, ...rest: unknown[]) {
  if (request === 'electron') {
    return {
      app: { getVersion: () => '0.0.0-test', getAppPath: () => APP, getPath: () => home },
      ipcMain: { handle: () => undefined },
      BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
      dialog: {}
    }
  }
  if (request === '@electron-toolkit/utils') return { is: { dev: true } }
  return origLoad.call(this, request, ...rest)
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-owners-'))
const ws = path.join(home, '.wolffish', 'workspace')
fs.mkdirSync(path.join(ws, 'brain', 'brainstem'), { recursive: true })
fs.mkdirSync(path.join(ws, 'brain', 'identity'), { recursive: true })
fs.mkdirSync(path.join(ws, 'brain', 'prefrontal'), { recursive: true })
fs.writeFileSync(
  path.join(ws, 'config.json'),
  // A real config always carries these; a bare {} is not a state the app ever
  // writes, and testing against one tests a machine that cannot exist.
  JSON.stringify({
    version: 1,
    llm: { mode: 'single', local: {}, providers: [], brain: {} },
    safety: {}
  })
)
fs.writeFileSync(path.join(ws, 'brain', 'identity', 'soul.md'), '# Soul\n\nI am **Wolffish**.\n')
fs.writeFileSync(path.join(ws, 'brain', 'identity', 'user.md'), '# User\n\nYounes.\n')
fs.writeFileSync(path.join(ws, 'brain', 'prefrontal', 'agents.md'), '# Agents\n\nBe brief.\n')
fs.writeFileSync(
  path.join(ws, 'brain', 'brainstem', 'heartbeat.md'),
  ['# Heartbeat', '', '## Daily (08:00)', '', 'icon: 🌅', '', 'Summarise yesterday.', ''].join('\n')
)

// Sources to attach.
const sources = path.join(home, 'sources')
fs.mkdirSync(sources)
fs.writeFileSync(path.join(sources, 'notes.md'), '# notes\n')
fs.writeFileSync(path.join(sources, 'data.csv'), 'a,b\n1,2\n')
const workdir = path.join(home, 'work')
fs.mkdirSync(workdir)
;(os as { homedir: () => string }).homedir = () => home

let failures = 0
const check = (name: string, condition: boolean, detail = ''): void => {
  if (condition) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

async function main(): Promise<void> {
  const { registerCliIpc } = await import('@main/channels/cli/ipc')
  const projectsApi = await import('@main/projects')
  const proceduresApi = await import('@main/procedures')
  const viewer = await import('@main/viewer')
  const brainstem = await import('@main/runtime/brainstem')

  const handlers = new Map<string, (...args: any[]) => any>()
  registerCliIpc({
    handle: (channel: string, listener: any) => handlers.set(channel, listener),
    handlers: new Map(),
    channel: {} as any,
    server: {} as any,
    snapshot: async () => ({}),
    broadcast: () => undefined,
    status: async () => ({}),
    execPath: '',
    cliEntry: '',
    autostart: {
      enable: async () => ({ active: true, mechanism: 'x', warning: null, location: null }),
      disable: async () => ({ active: false, mechanism: 'x', warning: null, location: null }),
      read: async () => ({ active: true, mechanism: 'x', warning: null, location: null })
    }
  } as never)

  // The surrounding channels, routed to the same functions index.ts uses.
  const client = {
    invoke: async (channel: string, arg?: any, arg2?: any) => {
      const registered = handlers.get(channel)
      if (registered) return registered(null, arg, arg2)
      switch (channel) {
        case 'projects:list':
          return projectsApi.listProjects()
        case 'projects:create':
          return projectsApi.createProject(arg)
        case 'projects:update':
          return projectsApi.updateProject(arg)
        case 'projects:delete':
          return projectsApi.deleteProject(arg)
        case 'procedures:list':
          return proceduresApi.listProcedures()
        case 'procedures:create':
          return proceduresApi.createProcedure(arg)
        case 'procedures:update':
          return proceduresApi.updateProcedure(arg)
        case 'procedures:delete':
          return proceduresApi.deleteProcedure(arg)
        case 'viewer:readFile':
          return viewer.readViewerFile(arg)
        case 'viewer:writeFile':
          return viewer.writeViewerFile(arg, arg2)
        case 'heartbeat:getJobs': {
          const raw = await viewer.readViewerFile('brain/brainstem/heartbeat.md')
          return brainstem.parseHeartbeat(raw).map((job: any) => ({ ...job, nextRunMs: null }))
        }
        case 'locale:get':
          return 'en'
        default:
          return null
      }
    }
  }

  const cli = await import(path.join(APP, 'src/cli/commands/workspace.mjs'))
  const quiet = async (fn: () => Promise<unknown>): Promise<string> => {
    const real = process.stdout.write.bind(process.stdout)
    let text = ''
    ;(process.stdout as any).write = (chunk: string) => {
      text += String(chunk)
      return true
    }
    try {
      await fn()
    } finally {
      ;(process.stdout as any).write = real
    }
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;]*m/g, '')
  }

  // ── customizations ───────────────────────────────────────────────────────
  const soul = await quiet(() => cli.customizations(client, ['soul']))
  check(
    'customizations soul prints the document',
    /I am Wolffish|I am \*\*Wolffish/.test(soul),
    soul
  )
  const docList = await quiet(() => cli.customizations(client, []))
  check('customizations lists all three', /soul/.test(docList) && /agents/.test(docList))

  // ── projects ─────────────────────────────────────────────────────────────
  await quiet(() => cli.projects(client, ['new', 'Roadmap']))
  const project = (await projectsApi.listProjects())[0]
  check('projects new created one', Boolean(project?.id))

  await quiet(() =>
    cli.projects(client, ['files', 'Roadmap', 'add', path.join(sources, 'notes.md')])
  )
  const afterAttach = (await projectsApi.listProjects())[0]
  check('project file attached', afterAttach.files.length === 1, JSON.stringify(afterAttach.files))
  check(
    'project file COPIED into the workspace',
    afterAttach.files[0]?.path.includes(path.join('uploads', `project-${project.id}`)) &&
      fs.existsSync(afterAttach.files[0].path),
    afterAttach.files[0]?.path
  )
  check('the source is left where it was', fs.existsSync(path.join(sources, 'notes.md')))

  await quiet(() => cli.projects(client, ['dirs', 'Roadmap', 'add', workdir]))
  check(
    'project folder added',
    (await projectsApi.listProjects())[0].directories?.[0] === workdir,
    JSON.stringify((await projectsApi.listProjects())[0].directories)
  )

  const missing = await quiet(() =>
    cli.projects(client, ['dirs', 'Roadmap', 'add', path.join(home, 'nope')])
  )
  check('a folder that is not there is REPORTED, not stored', /not found/.test(missing), missing)
  check(
    'and not stored',
    (await projectsApi.listProjects())[0].directories?.length === 1,
    JSON.stringify((await projectsApi.listProjects())[0].directories)
  )

  const shown = await quiet(() => cli.projects(client, ['show', 'Roadmap']))
  check(
    'projects show renders files and folders',
    /notes.md/.test(shown) && /work/.test(shown),
    shown
  )

  await quiet(() => cli.projects(client, ['rename', 'Roadmap', 'Plan']))
  check('projects rename', (await projectsApi.listProjects())[0].title === 'Plan')

  await quiet(() => cli.projects(client, ['files', 'Plan', 'rm', 'notes.md']))
  check('project file detached by name', (await projectsApi.listProjects())[0].files.length === 0)

  // ── procedures ───────────────────────────────────────────────────────────
  await quiet(() => cli.procedures(client, ['new', 'Weekly', 'Write the weekly note']))
  const procedure = (await proceduresApi.listProcedures())[0]
  check('procedures new created one', Boolean(procedure?.id))
  await quiet(() =>
    cli.procedures(client, ['files', 'Weekly', 'add', path.join(sources, 'data.csv')])
  )
  const proc2 = (await proceduresApi.listProcedures())[0]
  check(
    'procedure file copied + attached',
    proc2.files?.length === 1 && fs.existsSync(proc2.files[0].path),
    JSON.stringify(proc2.files)
  )
  await quiet(() => cli.procedures(client, ['dirs', 'Weekly', 'add', workdir]))
  check(
    'procedure folder added',
    (await proceduresApi.listProcedures())[0].directories?.[0] === workdir
  )
  await quiet(() => cli.procedures(client, ['mode', 'Weekly', 'workflow']))
  check('procedure mode set', (await proceduresApi.listProcedures())[0].mode === 'workflow')
  await quiet(() => cli.procedures(client, ['project', 'Weekly', 'Plan']))
  check(
    'procedure bound to a project',
    (await proceduresApi.listProcedures())[0].projectId === project.id
  )
  const procShown = await quiet(() => cli.procedures(client, ['show', 'Weekly']))
  check('procedures show renders it', /data.csv/.test(procShown) && /workflow/.test(procShown))

  // ── the menu's attach prompts: files and folders, SEPARATELY ─────────────
  //
  // Two entries, two prompts, each taking several paths at once and quoted
  // where they contain spaces. The property that matters is that neither one
  // silently does the other's job: a folder typed at the files prompt is
  // reported and skipped, not quietly turned into a working folder, because
  // quiet cross-routing is exactly what splitting these apart removed.
  const mixedDir = path.join(home, 'mixed')
  fs.mkdirSync(mixedDir)
  fs.writeFileSync(path.join(sources, 'two words.txt'), 'spaces\n')
  ;(process.stdin as any).isTTY = true
  const ui = await import(path.join(APP, 'src/cli/lib/ui.mjs'))
  const answerWith = (...answers: string[]): void =>
    ui.setLineReader({
      question: (_prompt: string, resolve: (value: string) => void) =>
        resolve(answers.shift() ?? ''),
      pause: () => undefined,
      resume: () => undefined,
      prompt: () => undefined
    })

  // Files prompt: a quoted path with spaces, a folder (wrong kind), a ghost.
  answerWith(`"${path.join(sources, 'two words.txt')}" ${mixedDir} ${path.join(home, 'ghost')}`)
  const filesRun = await quiet(() => cli.attachFilesInteractive(client, 'project', project.id))
  ui.setLineReader(null)
  const afterFiles = (await projectsApi.listProjects())[0]
  check(
    'a quoted path with spaces is one path, and it was copied',
    afterFiles.files.some((f: { name: string }) => f.name === 'two words.txt'),
    JSON.stringify(afterFiles.files.map((f: { name: string }) => f.name))
  )
  check(
    'a folder typed at the FILES prompt is not silently added as a folder',
    afterFiles.directories?.includes(mixedDir) !== true,
    JSON.stringify(afterFiles.directories)
  )
  check('and it says so, naming the other entry', /that is a folder/.test(filesRun), filesRun)
  check('a path that does not exist is reported', /not found/.test(filesRun), filesRun)

  // Folders prompt: the same directory, plus a file (wrong kind, quoted so it
  // arrives as ONE path rather than two that happen not to exist).
  answerWith(`${mixedDir} "${path.join(sources, 'two words.txt')}"`)
  const foldersRun = await quiet(() => cli.attachFoldersInteractive(client, 'project', project.id))
  ui.setLineReader(null)
  const afterFolders = (await projectsApi.listProjects())[0]
  check(
    'the folders prompt adds a working folder',
    afterFolders.directories?.includes(mixedDir) === true,
    JSON.stringify(afterFolders.directories)
  )
  check(
    'a file typed at the FOLDERS prompt is not attached twice',
    afterFolders.files.filter((f: { name: string }) => f.name === 'two words.txt').length === 1,
    JSON.stringify(afterFolders.files.map((f: { name: string }) => f.name))
  )
  check('and it says so, naming the other entry', /that is a file/.test(foldersRun), foldersRun)

  // Removing is split the same way. Drain the folder list one at a time: each
  // removal must take exactly one FOLDER and leave every file alone.
  const filesBefore = (await projectsApi.listProjects())[0].files.length
  let folderCount = (await projectsApi.listProjects())[0].directories?.length ?? 0
  check('there are folders to drain', folderCount > 0, String(folderCount))
  while (folderCount > 0) {
    answerWith('1')
    await quiet(() => cli.detachFolderInteractive(client, 'project', project.id))
    ui.setLineReader(null)
    const now = (await projectsApi.listProjects())[0]
    const left = now.directories?.length ?? 0
    check(
      `Remove a working folder took exactly one (${folderCount} -> ${left})`,
      left === folderCount - 1 && now.files.length === filesBefore
    )
    folderCount = left
  }

  answerWith('')
  const emptyFolders = await quiet(() => cli.detachFolderInteractive(client, 'project', project.id))
  ui.setLineReader(null)
  check(
    'with none left it says so rather than listing files',
    /no working folders/.test(emptyFolders),
    emptyFolders
  )

  answerWith('')
  const stillFiles = await quiet(() => cli.detachFileInteractive(client, 'project', project.id))
  ui.setLineReader(null)
  check(
    'and the file list is unaffected by the folder removals',
    /two words\.txt/.test(stillFiles),
    stillFiles
  )

  // ── automations ──────────────────────────────────────────────────────────
  await quiet(() =>
    cli.automations(client, ['files', 'Daily (08:00)', 'add', path.join(sources, 'notes.md')])
  )
  const heartbeat = fs.readFileSync(path.join(ws, 'brain', 'brainstem', 'heartbeat.md'), 'utf8')
  check('automation file: marker written', /^file: .+notes\.md$/m.test(heartbeat), heartbeat)
  check('automation icon marker preserved', /^icon: 🌅$/m.test(heartbeat), heartbeat)
  check('automation prompt preserved', /Summarise yesterday\./.test(heartbeat), heartbeat)
  const markerPath = heartbeat.match(/^file: (.+)$/m)?.[1] ?? ''
  check(
    'automation file COPIED into the workspace',
    markerPath.includes(path.join('uploads', 'automation-')) && fs.existsSync(markerPath),
    markerPath
  )

  await quiet(() => cli.automations(client, ['dirs', 'Daily (08:00)', 'add', workdir]))
  const heartbeat2 = fs.readFileSync(path.join(ws, 'brain', 'brainstem', 'heartbeat.md'), 'utf8')
  check(
    'automation dir: marker written',
    new RegExp(`^dir: ${workdir}$`, 'm').test(heartbeat2),
    heartbeat2
  )
  check('file marker still there after adding a dir', /^file: /m.test(heartbeat2))

  const jobs = brainstem.parseHeartbeat(heartbeat2)
  check(
    "the scheduler's own parser sees both",
    jobs[0]?.files?.length === 1 && jobs[0]?.dirs?.length === 1,
    JSON.stringify({ files: jobs[0]?.files, dirs: jobs[0]?.dirs })
  )
  const autoShown = await quiet(() => cli.automations(client, ['show', 'Daily']))
  check(
    'automations show renders it',
    /notes.md/.test(autoShown) && /Summarise/.test(autoShown),
    autoShown
  )

  // A `project:` marker must surface on the card as the PROJECT'S NAME —
  // getActiveJobs used to drop the field entirely, so the card said
  // "project none" over a job whose marker was plainly in the file.
  const bound = await client.invoke('projects:create', { title: 'Mentor Miller' })
  const heartbeatBound = fs
    .readFileSync(path.join(ws, 'brain', 'brainstem', 'heartbeat.md'), 'utf8')
    .replace('icon: 🌅', `icon: 🌅\nproject: ${bound.id}`)
  fs.writeFileSync(path.join(ws, 'brain', 'brainstem', 'heartbeat.md'), heartbeatBound)
  const boundShown = await quiet(() => cli.automations(client, ['show', 'Daily']))
  check(
    'automations show names the bound project, not "none"',
    /Mentor Miller/.test(boundShown) && !/project\s+none/.test(boundShown),
    boundShown
  )
  await client.invoke('projects:delete', bound.id)

  await quiet(() => cli.automations(client, ['files', 'Daily (08:00)', 'rm', 'notes.md']))
  const heartbeat3 = fs.readFileSync(path.join(ws, 'brain', 'brainstem', 'heartbeat.md'), 'utf8')
  check('automation file detached', !/^file: /m.test(heartbeat3), heartbeat3)
  check('but its dir survived', /^dir: /m.test(heartbeat3), heartbeat3)

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  fs.rmSync(home, { recursive: true, force: true })
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
