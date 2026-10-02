/**
 * Tests for the per-conversation diagnostic export (src/main/diagnostics.ts).
 *
 * The whole feature is "gather the RIGHT files and nothing dangerous", and both
 * halves fail silently — a bundle built from a wrong filter still zips fine, and
 * a leaked API key still zips fine. So this runs the real collector against a
 * synthetic workspace and opens the resulting archive:
 *  - the conversation, its filtered corpus slice, and ONLY its tasks are in
 *  - another conversation's events and tasks are NOT
 *  - a failed step inside a SUCCEEDED task still surfaces in every roll-up
 *    (metrics, readme, failures.md, opinion prompt) — worker failures were
 *    invisible at conversation level before
 *  - the capability SKILL.md for a tool it actually called rides along
 *  - config secrets are redacted, structure survives
 *  - attachment media is listed but not copied; small text is copied
 *  - the model opinion is one call, and its absence is not a failure
 *
 * Redirects the workspace to a temp home BEFORE loading the runtime graph so
 * nothing touches the real ~/.wolffish workspace.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/__tests__/diagnostics.test.ts
 */

import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-diag-'))
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

const WS = path.join(TEST_HOME, '.wolffish', 'workspace')

function write(rel: string, content: string): void {
  const abs = path.join(WS, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

/** Local date, the way corpus/episode filenames are stamped. */
function localDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function run(): Promise<void> {
  const { exportConversationDiagnostics, redactSecrets } = await import('@main/diagnostics')
  const { saveConversation, createConversation } = await import('@main/conversations')

  const now = Date.now()
  const today = localDate(new Date(now))

  // ── the conversation under test, plus an unrelated neighbour ────────────
  const conv = createConversation('claude-opus-5')
  conv.title = 'Extract a figure from the textbook'
  conv.createdAt = now - 60_000
  conv.updatedAt = now
  conv.projectId = 'proj-1'
  conv.messages.push(
    { role: 'user', content: 'could you show me Fig. 34.5', timestamp: now - 60_000 },
    {
      role: 'assistant',
      content: 'Working on it.',
      timestamp: now - 30_000,
      // A model DIFFERENT from the one selected at export time — the case the
      // README has to keep distinct, and the one a real conversation hit.
      segments: [
        {
          kind: 'active_model',
          turnId: 't1',
          segmentId: 's0',
          provider: 'deepseek',
          model: 'gpt-oss-120b'
        },
        {
          kind: 'tool_call',
          turnId: 't1',
          segmentId: 's1',
          toolCallId: 'c1',
          name: 'pdf_extract_images',
          args: { path: '/tmp/book.pdf' }
        },
        {
          kind: 'tool_result',
          turnId: 't1',
          segmentId: 's2',
          toolCallId: 'c1',
          status: 'failed',
          output: '',
          error: 'Command timed out after 600000ms'
        },
        {
          kind: 'turn_end',
          turnId: 't1',
          segmentId: 's3',
          stopReason: 'end_turn',
          iterationCount: 2
        }
      ],
      toolTimings: { c1: { startedAt: now - 30_500, endedAt: now - 30_000 } }
    }
  )
  conv.stats = {
    allTime: {
      processingMs: 61_000,
      apiMs: 42_000,
      turns: 1,
      apiCalls: 2,
      toolCalls: 1,
      inputTokens: 942,
      outputTokens: 314,
      cacheReadTokens: 8_192,
      cacheCreationTokens: 0,
      cost: 0.0421
    },
    lastTurn: {
      endedAt: now,
      elapsedMs: 61_000,
      apiMs: 42_000,
      apiCalls: 2,
      toolCalls: 1,
      inputTokens: 942,
      outputTokens: 314,
      cacheReadTokens: 8_192,
      cacheCreationTokens: 0,
      cost: 0.0421,
      provider: 'deepseek',
      model: 'gpt-oss-120b'
    },
    meter: {
      contextTokens: 87_130,
      contextBudget: 1_000_000,
      compactionAt: 725_424,
      model: 'gpt-oss-120b'
    }
  }
  await saveConversation(conv)

  const other = createConversation(null)
  other.title = 'Unrelated'
  await saveConversation(other)

  // ── a corpus day carrying BOTH conversations' events ────────────────────
  write(
    `brain/corpus/${today}.log.md`,
    [
      `# ${today}`,
      ``,
      `## 10:00:00.000 [turn t1 conv ${conv.id}]`,
      `- task.created → {"taskId":"mine123","name":"figure","stepsTotal":0}`,
      ``,
      `## 10:00:01.000 [turn t1 conv ${conv.id}]`,
      `- tool.failed → {"taskId":"mine123","error":"Command timed out after 600000ms"}`,
      ``,
      `## 10:00:02.000 [turn t9 conv ${other.id}]`,
      `- task.created → {"taskId":"theirs999","name":"other work","stepsTotal":0}`,
      ``,
      `## 10:00:03.000 [bg]`,
      `- heartbeat.tick → {}`,
      ``
    ].join('\n')
  )
  // The task transcript in motor's real format. The task ended SUCCEEDED —
  // step 2 failed and step 3 recovered — which is the shape that made worker
  // failures invisible: nothing about it exists in the conversation's own
  // segments, and a status-level check reports success.
  write(
    `brain/motor/tasks/TASK-mine123.md`,
    [
      '# Task: figure',
      '',
      '- **ID:** TASK-mine123',
      '- **Status:** SUCCEEDED',
      `- **Created:** ${new Date(now - 50_000).toISOString()}`,
      `- **Updated:** ${new Date(now - 20_000).toISOString()}`,
      '- **Steps:** 2/3 succeeded',
      '',
      '## Steps',
      '',
      '### Step 1: pdf_extract_images ✅',
      '- **Args:** `{"path":"/tmp/book.pdf"}`',
      '- **Attempts:** 1',
      '- **Output:** extracted 3 images',
      '- **Result:** succeeded',
      '',
      '### Step 2: send_file ❌',
      '- **Args:** `{"path":"/tmp/missing-figure.png"}`',
      '- **Attempts:** 3',
      '- **Error:** tool failed (not_found, non-retryable): no such file: /tmp/missing-figure.png',
      '- **Result:** failed',
      '',
      '### Step 3: send_file ✅',
      '- **Args:** `{"path":"/tmp/fig-34-5.png"}`',
      '- **Attempts:** 1',
      '- **Output:** sent',
      '- **Result:** succeeded',
      ''
    ].join('\n')
  )
  write(`brain/motor/tasks/TASK-theirs999.md`, '# Task: other work\n')

  // ── everything else a bundle is supposed to reach ───────────────────────
  write(`logs/${new Date(now).toISOString().slice(0, 10)}.log`, 'INFO app started\n')
  write(`usage/daily/${today}.md`, '# usage\n\nin:942 out:314 | $0.0421\n')
  write('usage/providers/deepseek.md', '# deepseek\n\nin:942 out:314 | $0.0421\n')
  write(`brain/hippocampus/episodes/${today}.md`, `# ${today}\n\n## a turn\n`)
  write('brain/hippocampus/consolidated/W29.md', 'week 29\n')
  write('brain/hippocampus/consolidated/W30.md', 'week 30\n')
  write('brain/hippocampus/knowledge/pdfs.md', 'what I know about pdfs\n')
  write('brain/prefrontal/agents.core.md', '# core contract\n')
  write('brain/prefrontal/agents.md', '# user overrides\n')
  write('brain/identity/soul.md', '# soul\n')
  write('brain/identity/user.md', '# user\n')
  write('brain/brainstem/compaction-meta.json', '{"lastRun":null}')
  write('brain/projects.json', JSON.stringify([{ id: 'proj-1', title: 'Textbook', files: [] }]))
  write('brain/cerebellum/.pdf/SKILL.md', '---\nname: pdf\n---\nthe pdf contract\n')

  // A prompt snapshot inside the conversation's window, and one far outside it.
  const stamp = (d: Date): string => {
    const pad = (n: number, l = 2): string => String(n).padStart(l, '0')
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
    )
  }
  write(`brain/prefrontal/.debug/${stamp(new Date(now - 45_000))}.md`, '# snapshot in window\n')
  write(
    `brain/prefrontal/.debug/${stamp(new Date(now - 40 * 24 * 60 * 60 * 1000))}.md`,
    '# ancient snapshot\n'
  )

  // Config with credentials in several shapes.
  write(
    'config.json',
    JSON.stringify({
      version: 1,
      locale: 'en',
      llm: {
        mode: 'single',
        brain: { provider: 'anthropic', model: 'claude-opus-5' },
        providers: [{ id: 'anthropic', model: 'claude-opus-5', apiKey: 'sk-ant-SUPERSECRET' }]
      },
      telegram: { botToken: '12345:AAHsecretTOKEN', enabled: true },
      variables: [{ name: 'STRIPE_SECRET', value: 'sk_live_zzz' }]
    })
  )

  // Attachments: a media file (listed only) and a small text file (copied).
  write(`uploads/conv-${conv.id}/photo.png`, 'x'.repeat(4096))
  write(`uploads/conv-${conv.id}/notes.md`, '# the note that broke it\n')

  // ── run the export ──────────────────────────────────────────────────────
  const steps: string[] = []
  let llmCalls = 0
  let systemSeen = ''
  let materialSeen = ''
  const result = await exportConversationDiagnostics({
    conversationId: conv.id,
    env: {
      appVersion: '1.0.228',
      packaged: false,
      provider: 'anthropic',
      model: 'claude-opus-5',
      chatMode: 'single',
      locale: 'en'
    },
    llm: {
      diagnose: async (material: string, system: string) => {
        llmCalls++
        materialSeen = material
        systemSeen = system
        return {
          text: '## Most likely cause\nThe tool has no page filter.',
          provider: 'anthropic',
          model: 'claude-opus-5'
        }
      }
    },
    toolCapability: (tool) => (tool === 'pdf_extract_images' ? 'pdf' : undefined),
    capabilities: [{ name: 'pdf', dir: path.join(WS, 'brain', 'cerebellum', '.pdf') }],
    onProgress: (p) => steps.push(p.step)
  })

  ok('export succeeded', result.ok, result.error)
  ok('archive lands under workspace/diagnostics', result.relativePath.startsWith('diagnostics/'))
  ok('archive exists on disk', fs.existsSync(result.zipPath), result.zipPath)
  ok('archive is non-empty', result.sizeBytes > 0, String(result.sizeBytes))
  ok(
    'every step reported once, in order',
    steps.join(',') ===
      'conversation,logs,tasks,memory,context,settings,attachments,opinion,archive',
    steps.join(',')
  )

  // ── open the archive and inspect it ──────────────────────────────────────
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(fs.readFileSync(result.zipPath))
  const names = Object.keys(zip.files)
  const has = (n: string): boolean => names.includes(n)
  const text = async (n: string): Promise<string> => (await zip.file(n)?.async('string')) ?? ''

  ok('bundle: readme', has('00_README.md'))
  ok('bundle: environment snapshot', has('00_ENVIRONMENT.json'))
  ok('bundle: raw conversation', has('01_conversation/conversation.json'))
  ok('bundle: readable transcript', has('01_conversation/transcript.md'))
  ok('bundle: full daily corpus log', has(`02_logs/corpus/${today}.log.md`))
  ok('bundle: filtered corpus slice', has('02_logs/corpus-this-conversation.md'))
  ok('bundle: app log', has(`02_logs/app/${new Date(now).toISOString().slice(0, 10)}.log`))
  ok('bundle: episode', has(`04_memory/episodes/${today}.md`))
  ok('bundle: consolidated memory', has('04_memory/consolidated/W30.md'))
  ok('bundle: knowledge', has('04_memory/knowledge/pdfs.md'))
  ok('bundle: agents.core', has('05_context/agents.core.md'))
  ok('bundle: soul + user', has('05_context/soul.md') && has('05_context/user.md'))
  ok('bundle: compaction meta', has('06_settings/compaction-meta.json'))
  ok('bundle: bound project', has('06_settings/project.json'))
  ok('bundle: attachment manifest', has('07_attachments/MANIFEST.md'))
  ok('bundle: model opinion', has('08_analysis/model-opinion.md'))

  // The precision claims — these are what a wrong filter breaks silently.
  const slice = await text('02_logs/corpus-this-conversation.md')
  ok('slice: keeps this conversation’s events', slice.includes('"taskId":"mine123"'), slice)
  ok('slice: excludes another conversation’s events', !slice.includes('theirs999'), slice)
  ok('slice: excludes unattributed background events', !slice.includes('heartbeat.tick'), slice)
  ok('tasks: this conversation’s task transcript is in', has('03_tasks/TASK-mine123.md'))
  ok('tasks: another conversation’s task is NOT', !has('03_tasks/TASK-theirs999.md'))

  ok('capability: the SKILL.md of a called tool is in', has('05_context/capabilities/pdf.SKILL.md'))
  // JSZip lists implicit directory entries too — count files only.
  const snapshots = names.filter(
    (n) => n.startsWith('05_context/prompt-snapshots/') && !n.endsWith('/')
  )
  ok('snapshots: only the one inside the window', snapshots.length === 1, snapshots.join(','))

  // Redaction — the expensive-if-wrong one.
  const cfg = await text('06_settings/config.redacted.json')
  ok('redaction: no anthropic key', !cfg.includes('SUPERSECRET'), cfg)
  ok('redaction: no telegram token', !cfg.includes('AAHsecretTOKEN'), cfg)
  ok('redaction: structure survives', cfg.includes('"model": "claude-opus-5"'), cfg)
  ok('redaction: marker records the length', cfg.includes('[redacted —'), cfg)
  ok(
    'redaction: nested arrays are walked',
    JSON.stringify(redactSecrets({ a: [{ apiKey: 'zzz' }] })).includes('[redacted'),
    JSON.stringify(redactSecrets({ a: [{ apiKey: 'zzz' }] }))
  )

  // Media policy.
  ok('attachments: media bytes excluded', !has('07_attachments/uploads/photo.png'))
  ok('attachments: small text copied', has('07_attachments/uploads/notes.md'))
  const manifest = await text('07_attachments/MANIFEST.md')
  ok('attachments: media still listed', manifest.includes('photo.png'), manifest)

  // The opinion is ONE lean call that only reads.
  ok('opinion: exactly one model call', llmCalls === 1, String(llmCalls))
  ok('opinion: told not to act', /no tools/i.test(systemSeen), systemSeen.slice(0, 200))
  ok('opinion: given the failing tool', materialSeen.includes('pdf_extract_images'))
  ok('opinion: given the error text', materialSeen.includes('Command timed out'))
  ok('opinion: reported as included', result.modelOpinion && !result.opinionSkipped)
  const opinion = await text('08_analysis/model-opinion.md')
  ok('opinion: labelled as unverified', /unverified/i.test(opinion), opinion.slice(0, 200))

  // ── the numbers a developer asks for first ──────────────────────────────
  ok('bundle: metrics roll-up', has('00_METRICS.md'))
  ok('bundle: failures on their own', has('01_conversation/failures.md'))
  const metricsFile = await text('00_METRICS.md')
  const readme = await text('00_README.md')
  for (const [label, needle] of [
    ['tool call + failure counts', /tool calls: 1, of which FAILED: 1/],
    ['token split', /942|tokens:/],
    ['the model that actually ran', /gpt-oss-120b/],
    ['cost', /cost: \$/],
    ['context vs budget', /context at last turn: .*of .*tokens/],
    ['wall clock', /wall clock:/]
  ] as Array<[string, RegExp]>) {
    ok(`metrics: reports ${label}`, needle.test(metricsFile), metricsFile.slice(0, 400))
  }
  ok(
    'readme: leads with the failure, both counts apart',
    /## Failures \(tool calls: 1, task steps: 1\)/.test(readme),
    readme.slice(0, 600)
  )
  ok(
    'readme: separates model-selected-now from model-that-ran',
    /Model selected at export time/.test(readme) && /models that actually ran/.test(readme)
  )
  const failuresFile = await text('01_conversation/failures.md')
  ok('failures: names the tool', failuresFile.includes('pdf_extract_images'))
  ok('failures: keeps the arguments', failuresFile.includes('/tmp/book.pdf'))
  ok('failures: keeps the full error', failuresFile.includes('Command timed out after 600000ms'))

  // ── THE regression this bundle shape had: a failed step inside a task that
  //    ended SUCCEEDED was invisible at conversation level — "FAILED: 0" over
  //    a worker whose send_file step had failed. The counts stay separate (a
  //    turn's own steps duplicate its tool calls), but the step failure must
  //    show up in metrics, readme, failures.md and the opinion prompt.
  ok(
    'metrics: counts task steps as their own line',
    /task steps: 3 across 1 task\(s\), of which FAILED: 1/.test(metricsFile),
    metricsFile.slice(0, 400)
  )
  ok(
    'readme: lists the failed task step',
    readme.includes('(TASK-mine123, step 2)'),
    readme.slice(0, 900)
  )
  ok(
    'failures: title carries the task step count',
    failuresFile.includes('# Failed tool calls — 1 (failed task steps: 1)'),
    failuresFile.slice(0, 200)
  )
  ok(
    'failures: the failed step with its task id',
    failuresFile.includes('### TASK-mine123 — step 2: `send_file`'),
    failuresFile
  )
  ok('failures: keeps the step arguments', failuresFile.includes('/tmp/missing-figure.png'))
  ok(
    'failures: keeps the step error',
    failuresFile.includes('tool failed (not_found, non-retryable)')
  )
  ok(
    'opinion: given the failed task step',
    materialSeen.includes('## Failed task steps (1)') && materialSeen.includes('not_found'),
    materialSeen.slice(0, 400)
  )
  ok('bundle: usage ledger for the day', has(`02_logs/usage/daily/${today}.md`))
  ok('bundle: provider ledger', has('02_logs/usage/providers/deepseek.md'))
  const transcript = await text('01_conversation/transcript.md')
  ok(
    'transcript: carries per-call duration',
    /_\(\d+(\.\d+)?(ms|s)\)_/.test(transcript),
    transcript.slice(0, 800)
  )

  // ── THE regression that matters: a long conversation must not truncate
  //    its failures away. A plain tail-slice of a real 30-message run kept a
  //    stretch of successful sends and dropped every single failure, leaving
  //    the model asked what went wrong while holding no evidence that
  //    anything had. Padded well past OPINION_MAX_CHARS (60k).
  {
    const long = createConversation('claude-opus-5')
    long.title = 'A very long conversation'
    long.createdAt = now - 120_000
    long.updatedAt = now
    long.messages.push({ role: 'user', content: 'do the thing', timestamp: now - 120_000 })
    // The failure is buried in the MIDDLE — successful noise on both sides of
    // it. This is the shape that defeats a head-only, tail-only OR head+tail
    // cut of the transcript: the ONLY thing that can preserve the failure is
    // lifting it into a section that is never truncated.
    const filler = (i: number, at: number): (typeof long.messages)[number] => ({
      role: 'assistant',
      content: `filler turn ${i} — ${'x'.repeat(1500)}`,
      timestamp: at + i * 100
    })
    for (let i = 0; i < 45; i++) long.messages.push(filler(i, now - 119_000))
    long.messages.push({
      role: 'assistant',
      content: 'the attempt that failed',
      timestamp: now - 110_000,
      segments: [
        {
          kind: 'tool_call',
          turnId: 't1',
          segmentId: 'f1',
          toolCallId: 'fc1',
          name: 'the_broken_tool',
          args: { needle: 'ARGUMENT_NEEDLE' }
        },
        {
          kind: 'tool_result',
          turnId: 't1',
          segmentId: 'f2',
          toolCallId: 'fc1',
          status: 'failed',
          output: '',
          error: 'ERROR_NEEDLE: the tool blew up'
        }
      ]
    })
    for (let i = 45; i < 90; i++) long.messages.push(filler(i, now - 109_000))
    await saveConversation(long)

    let material = ''
    const r = await exportConversationDiagnostics({
      conversationId: long.id,
      env: {
        appVersion: '1.0.228',
        packaged: false,
        provider: 'anthropic',
        model: 'claude-opus-5',
        chatMode: 'single',
        locale: 'en'
      },
      llm: {
        diagnose: async (m: string) => {
          material = m
          return { text: 'ok', provider: 'anthropic', model: 'claude-opus-5' }
        }
      }
    })
    ok('long: export succeeds', r.ok, r.error)
    ok('long: prompt was actually truncated', /omitted for length/.test(material))
    ok(
      'long: the failing tool survives truncation',
      material.includes('the_broken_tool'),
      'MISSING'
    )
    ok('long: the error text survives truncation', material.includes('ERROR_NEEDLE'), 'MISSING')
    ok('long: the arguments survive truncation', material.includes('ARGUMENT_NEEDLE'), 'MISSING')
    ok('long: metrics survive truncation', /## Metrics/.test(material))
    ok(
      'long: failures come BEFORE the transcript',
      material.indexOf('## Failed tool calls') < material.indexOf('## Transcript')
    )
  }

  // ── the log filter classifies by event NAME, not by matching text ───────
  // A successful shell call carrying `"timeout":15000` in its arguments used
  // to land in the "errors" section and crowd out the real failures.
  {
    const { failureBlocksForTest } = await import('@main/diagnostics')
    const blocks = [
      '## 10:00:00.000 [turn t1 conv x]\n- tool.called → {"tool":"shell_exec","args":{"timeout":15000}}',
      '## 10:00:01.000 [turn t1 conv x]\n- tool.failed → {"tool":"ext_pdf","error":"not supported"}',
      '## 10:00:02.000 [turn t1 conv x]\n- llm.error → {"message":"429"}',
      '## 10:00:03.000 [turn t1 conv x]\n- tool.completed → {"tool":"web_search"}'
    ]
    const picked = failureBlocksForTest(blocks)
    ok('log filter: keeps tool.failed and llm.error', picked.length === 2, String(picked.length))
    ok(
      'log filter: drops a success carrying a timeout argument',
      !picked.join().includes('shell_exec')
    )
  }

  // ── no model configured: the bundle still ships ─────────────────────────
  {
    const r = await exportConversationDiagnostics({
      conversationId: conv.id,
      env: {
        appVersion: '1.0.228',
        packaged: false,
        provider: null,
        model: null,
        chatMode: 'single',
        locale: 'en'
      },
      llm: null
    })
    ok('no model: export still succeeds', r.ok, r.error)
    ok('no model: reported as skipped', !r.modelOpinion && r.opinionSkipped === 'no-model')
    const z = await JSZip.loadAsync(fs.readFileSync(r.zipPath))
    ok('no model: no opinion file', !Object.keys(z.files).includes('08_analysis/model-opinion.md'))
  }

  // ── a model that throws must not fail the export ────────────────────────
  {
    const r = await exportConversationDiagnostics({
      conversationId: conv.id,
      env: {
        appVersion: '1.0.228',
        packaged: false,
        provider: 'anthropic',
        model: 'claude-opus-5',
        chatMode: 'single',
        locale: 'en'
      },
      llm: {
        diagnose: async () => {
          throw new Error('provider down')
        }
      }
    })
    ok('model down: export still succeeds', r.ok, r.error)
    ok('model down: reported as failed opinion', r.opinionSkipped === 'failed')
  }

  // ── an empty answer is its own outcome, not a failure ───────────────────
  {
    const r = await exportConversationDiagnostics({
      conversationId: conv.id,
      env: {
        appVersion: '1.0.228',
        packaged: false,
        provider: 'anthropic',
        model: 'claude-opus-5',
        chatMode: 'single',
        locale: 'en'
      },
      llm: {
        diagnose: async () => ({ text: '   ', provider: 'anthropic', model: 'claude-opus-5' })
      }
    })
    ok('empty opinion: export still succeeds', r.ok, r.error)
    ok(
      'empty opinion: reported as empty, not failed',
      r.opinionSkipped === 'empty',
      r.opinionSkipped
    )
  }

  // ── an unknown conversation fails cleanly, without throwing ─────────────
  {
    const r = await exportConversationDiagnostics({
      conversationId: 'does-not-exist',
      env: {
        appVersion: '1.0.228',
        packaged: false,
        provider: null,
        model: null,
        chatMode: 'single',
        locale: 'en'
      }
    })
    ok('missing conversation: ok=false with a message', !r.ok && !!r.error, r.error)
  }

  await fs.promises.rm(TEST_HOME, { recursive: true, force: true }).catch(() => undefined)
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void run()
