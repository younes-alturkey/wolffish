/**
 * LIVE end-to-end: does the MODEL actually pick up an owner's attached files
 * and working folders, and use them?
 *
 * The unit tests prove the context is assembled. This one puts that exact
 * context in front of a real model and reads what comes back — once per owner
 * (project, procedure, automation), with the real overlays and the real
 * working-folder block, through the real Thalamus.
 *
 * The question is built so the context is the ONLY way to answer it:
 *
 *  - the attached file is named `acme-handbook-2026-q3.pdf`, a name no model
 *    has seen; naming it back proves the attached-files overlay landed
 *  - the working folder contains `zebra-ledger-9f3a71.csv`, which appears
 *    NOWHERE except the live readdir; naming it back proves the folder listing
 *    landed and was read
 *  - the model is asked what it would do FIRST to answer a question about the
 *    attached file's contents. The right answer names a read tool and the
 *    file's path — because content is deliberately never injected. A model
 *    that instead summarizes the "contents" has hallucinated, and that is a
 *    FAILURE the assertion catches, not a pass.
 *
 * Reads the live key from ~/.wolffish/workspace/config.json; never mutates it.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 npx electron node_modules/tsx/dist/cli.mjs \
 *        src/main/runtime/__tests__/e2e-attachments-live.ts
 * (electron-as-node because thalamus.ts imports electron's net module)
 */
import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

// The workspace redirect has to happen before the store modules load, exactly
// as in the offline siblings — this test writes projects/procedures.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-attach-live-'))
const REAL_HOME = os.homedir()
;(os as unknown as { homedir: () => string }).homedir = (): string => TEST_HOME

// Electron-as-node has no `app`, and @electron-toolkit/utils reads
// `app.isPackaged` at import time. The rest of the module — crucially `net`,
// which thalamus streams through — is real and stays real: this only bolts a
// plausible `app` onto it.
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  const loaded = origLoad.apply(this, args)
  if (args[0] !== 'electron') return loaded
  const electron = loaded as { app?: unknown; net?: { isOnline?: () => boolean } }
  if (electron.app && electron.net?.isOnline) return loaded
  return {
    ...electron,
    app: electron.app ?? {
      isPackaged: false,
      getAppPath: () => process.cwd(),
      getPath: () => os.tmpdir(),
      getVersion: () => '0.0.0-test'
    },
    // `net.isOnline` is a main-process API and undefined here; the requests
    // themselves go out over plain fetch, so answering true is honest — if the
    // machine were offline the fetch would fail and the test would say so.
    net: { ...(electron.net ?? {}), isOnline: () => true }
  }
}

type StreamChunk = import('@main/runtime/thalamus').StreamChunk
type Thalamus = import('@main/runtime/thalamus').Thalamus

// ── live credentials, read-only, from the REAL workspace ─────────────────
type Cloud = { id: string; model: string; apiKey: string }
function collectProviders(node: unknown, out: Cloud[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectProviders(item, out)
    return
  }
  if (node && typeof node === 'object') {
    const rec = node as Record<string, unknown>
    if (typeof rec.id === 'string' && typeof rec.apiKey === 'string' && rec.apiKey) {
      out.push({ id: rec.id, model: String(rec.model ?? ''), apiKey: rec.apiKey })
    }
    for (const value of Object.values(rec)) collectProviders(value, out)
  }
}

const configPath = path.join(REAL_HOME, '.wolffish', 'workspace', 'config.json')
let config: Record<string, unknown>
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
} catch {
  console.error(`no config at ${configPath} — cannot run a live check`)
  process.exit(1)
}
const cloud: Cloud[] = []
collectProviders(config, cloud)
const brain = (config.llm as { brain?: { providerId: string; model: string } } | undefined)?.brain
if (cloud.length === 0 || !brain) {
  console.error('no cloud provider / Brain configured — skipping the live check')
  process.exit(1)
}

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  ok   ${label}`)
    return
  }
  failed++
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
}

let thalamus: Thalamus

async function ask(system: string, tail: string, question: string): Promise<string> {
  let text = ''
  const stream = thalamus.stream({
    system,
    // The working-folder block rides the outbound tail exactly as the agent
    // sends it — after the user's words, ahead of nothing.
    messages: [{ role: 'user', content: `${question}\n\n${tail}` }]
  }) as AsyncGenerator<StreamChunk>
  for await (const chunk of stream) {
    if (chunk.type === 'text') text += chunk.text
    else if (chunk.type === 'error') throw new Error(chunk.message)
    else if (chunk.type === 'no_provider_available') throw new Error('no provider available')
  }
  return text
}

// ── the fixture: names that exist nowhere but here ───────────────────────
const FILE_NAME = 'acme-handbook-2026-q3.pdf'
const FOLDER_FILE = 'zebra-ledger-9f3a71.csv'

const sources = path.join(TEST_HOME, 'sources')
fs.mkdirSync(sources, { recursive: true })
fs.writeFileSync(path.join(sources, FILE_NAME), 'P'.repeat(8192))
const workDir = path.join(TEST_HOME, 'reports')
fs.mkdirSync(path.join(workDir, 'archive'), { recursive: true })
fs.writeFileSync(path.join(workDir, FOLDER_FILE), 'x,y,z')

const BASE_SYSTEM =
  'You are wolffish, a concise assistant with file tools (file_read, pdf_read, pdf_search, image_view). ' +
  'Answer in at most four short lines.'
const QUESTION =
  'Answer all three, one line each: (1) the exact filename attached to you; ' +
  '(2) the exact filename inside my working folder; ' +
  '(3) to answer a question about what the ATTACHED file says, what is the FIRST thing you would do — ' +
  'name the tool and the path. Do not tell me what the attached file contains.'

/**
 * One owner's live turn. Fails loudly on a fabricated answer: the attached
 * file's bytes are never in context, so any claim about its contents is a
 * hallucination the shipping prompt is supposed to prevent.
 */
async function check(label: string, system: string, tail: string): Promise<void> {
  console.log(`\n${label}`)
  const answer = await ask(system, tail, QUESTION)
  console.log(
    `  ── model said ─────────────\n${answer.replace(/^/gm, '  │ ')}\n  ───────────────────────────`
  )
  const lower = answer.toLowerCase()
  ok('the model names the ATTACHED FILE', lower.includes(FILE_NAME.toLowerCase()), answer)
  ok(
    'the model names a file it could only get from the FOLDER LISTING',
    lower.includes(FOLDER_FILE.toLowerCase()),
    answer
  )
  ok(
    'it reaches for a read tool and the real path rather than guessing',
    /file_read|pdf_read|pdf_search/.test(lower) && lower.includes(FILE_NAME.toLowerCase()),
    answer
  )
  ok(
    'it does NOT claim to know the attached contents',
    !/(the (pdf|handbook|document|file) (says|contains|covers|describes)|according to the (pdf|handbook|attached))/i.test(
      answer
    ),
    answer
  )
}

async function main(): Promise<void> {
  // Loaded here, not at module top: the tsconfig emits CJS, where top-level
  // await is not available — and the workspace redirect above has to be in
  // place before the store modules resolve their root either way.
  const { LocalProvider } = await import('@main/runtime/providers/local')
  const { Thalamus } = await import('@main/runtime/thalamus')
  const projects = await import('@main/projects')
  const procedures = await import('@main/procedures')
  const { attachFilesToAutomation } = await import('@main/automations/files')
  const { buildAttachedFilesOverlay } = await import('@main/uploads/owned-copies')

  thalamus = new Thalamus(new LocalProvider())
  // The config's provider ids ARE the union at runtime; this crosses the
  // JSON-to-typed boundary once, here, rather than re-declaring the union.
  thalamus.setCloudProviders(cloud as unknown as Parameters<Thalamus['setCloudProviders']>[0])
  thalamus.setBrain(brain as unknown as Parameters<Thalamus['setBrain']>[0])

  /** renderWorkingFolders, lifted from Agent.ts byte-for-byte. */
  const agentSrc = fs.readFileSync(
    path.join(process.cwd(), 'src/main/runtime/agent/Agent.ts'),
    'utf8'
  )
  const sliceFile = path.join(TEST_HOME, 'render-working-folders.ts')
  fs.writeFileSync(
    sliceFile,
    `import fs from 'node:fs/promises'\n${agentSrc.slice(
      agentSrc.indexOf('/** Entries listed per working folder in the volatile tail. */'),
      agentSrc.indexOf('function segmentReasonFor')
    )}\nexport { renderWorkingFolders }`
  )
  const { renderWorkingFolders } = (await import(sliceFile)) as {
    renderWorkingFolders: (folders: string[]) => Promise<string>
  }

  console.log(`Brain: ${brain!.providerId}/${brain!.model}`)
  const tail = await renderWorkingFolders([workDir])

  // ── PROJECT ────────────────────────────────────────────────────────────
  const project = await projects.createProject({
    title: 'Quarterly report',
    icon: '📊',
    instructions: 'Always cite the source table.'
  })
  await projects.attachFilesToProject(project.id, [path.join(sources, FILE_NAME)])
  await projects.updateProject({ id: project.id, directories: [workDir] })
  await check(
    'PROJECT — instructions + attached file + working folder',
    BASE_SYSTEM + (await projects.buildProjectOverlay(project.id)),
    tail
  )

  // ── PROCEDURE ──────────────────────────────────────────────────────────
  const proc = await procedures.createProcedure({ title: 'Digest', prompt: 'Summarize it.' })
  const procFiles = await procedures.attachFilesToProcedure(proc.id, [
    path.join(sources, FILE_NAME)
  ])
  await procedures.updateProcedure({ id: proc.id, directories: [workDir] })
  await check(
    'PROCEDURE — attached file + working folder',
    BASE_SYSTEM + (await procedures.buildProcedureFilesOverlay(procFiles.added.map((f) => f.path))),
    tail
  )

  // ── AUTOMATION ─────────────────────────────────────────────────────────
  const autoFiles = await attachFilesToAutomation([], [path.join(sources, FILE_NAME)])
  await check(
    'AUTOMATION — attached file + working folder',
    BASE_SYSTEM +
      (await buildAttachedFilesOverlay(
        autoFiles.added.map((f) => f.path),
        'automation'
      )),
    tail
  )

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
