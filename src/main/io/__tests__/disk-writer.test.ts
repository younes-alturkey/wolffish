/**
 * Concurrency tests for the diskWriter's RMW primitives and the
 * conversation-level merge built on them.
 *
 * With conversations running concurrently, multiple writers touch shared
 * files at once. Three guarantees under test:
 *
 *  - `update()` runs read-modify-write INSIDE the per-path queue, so N
 *    concurrent increments never lose an update (the classic two-writers-
 *    load-the-same-copy clobber).
 *  - `appendWithInit()` decides the header inside the queue, so two
 *    concurrent first-writers can't both write the `# date` header.
 *  - `updateConversation()` + `mergeConversationOnto()` preserve the
 *    summarizer's fields when a stale whole-file save races it, and let
 *    two writers append messages to one conversation without loss.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/io/__tests__/disk-writer.test.ts
 */

import Module from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Shim `electron` before importing anything that touches the workspace
// (conversations.ts → workspace.ts reads electron.app paths at import time).
// tmpRoot is assigned inside run() before any import needs it (tsx compiles
// to CJS — no top-level await).
let tmpRoot = ''
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => tmpRoot }
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

async function run(): Promise<void> {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wolffish-diskwriter-'))
  const { diskWriter } = await import('@main/io/diskWriter')

  // ── update(): 100 concurrent increments, zero lost updates ─────────────
  {
    const target = path.join(tmpRoot, 'counter.json')
    await diskWriter.writeFileAtomic(target, JSON.stringify({ n: 0 }))
    await Promise.all(
      Array.from({ length: 100 }, () =>
        diskWriter.update(target, (raw) => {
          const value = raw ? (JSON.parse(raw) as { n: number }) : { n: 0 }
          value.n += 1
          return JSON.stringify(value)
        })
      )
    )
    const final = JSON.parse(await fs.readFile(target, 'utf8')) as { n: number }
    ok('update: 100 concurrent RMW increments all land', final.n === 100, String(final.n))
  }

  // ── appendWithInit(): concurrent first-writers, exactly one header ──────
  {
    const target = path.join(tmpRoot, 'daily.md')
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        diskWriter.appendWithInit(target, (exists) =>
          exists ? `- line ${i}\n` : `# header\n\n- line ${i}\n`
        )
      )
    )
    const text = await fs.readFile(target, 'utf8')
    const headers = text.split('\n').filter((l) => l === '# header').length
    const lines = text.split('\n').filter((l) => l.startsWith('- line')).length
    ok('appendWithInit: exactly one header under 20 concurrent writers', headers === 1, text)
    ok('appendWithInit: all 20 lines landed', lines === 20, String(lines))
  }

  // ── conversation-shaped RMW appends + summarizer merge ──────────────────
  // Hermetic twin of updateConversation (same diskWriter.update code path,
  // temp-dir file instead of the real ~/.wolffish workspace) + the pure
  // mergeConversationOnto rules.
  {
    const { mergeConversationOnto } = await import('@main/conversations')
    type Conv = import('@main/conversations').ConversationFile

    const target = path.join(tmpRoot, 'conv-test.json')
    const base: Conv = {
      id: 'test',
      title: 'Untitled',
      model: null,
      messages: [{ role: 'user', content: 'seed', timestamp: 1 }],
      createdAt: 1,
      updatedAt: 1
    }
    await diskWriter.writeFileAtomic(target, JSON.stringify(base))
    const updateConv = (mutate: (c: Conv) => Conv): Promise<void> =>
      diskWriter.update(target, (raw) =>
        raw === null ? null : JSON.stringify(mutate(JSON.parse(raw) as Conv))
      )

    // Two writers append concurrently from their own (stale) copies.
    await Promise.all([
      updateConv((disk) => {
        disk.messages.push({ role: 'assistant', content: 'from writer A', timestamp: 2 })
        return disk
      }),
      updateConv((disk) => {
        disk.messages.push({ role: 'assistant', content: 'from writer B', timestamp: 3 })
        return disk
      })
    ])
    const afterAppends = JSON.parse(await fs.readFile(target, 'utf8')) as Conv
    ok(
      'conversation RMW: concurrent appends both land',
      afterAppends.messages.length === 3,
      String(afterAppends.messages.length)
    )

    // Summarizer writes summary fields; a STALE whole-file save (no summary)
    // races it. The merge must keep the summary.
    await updateConv((disk) => {
      disk.summary = 'the rolling summary'
      disk.summarizedThroughMessage = 2
      return disk
    })
    const staleCopy: Conv = { ...base, messages: afterAppends.messages, title: 'Untitled' }
    await diskWriter.update(target, (raw) =>
      JSON.stringify(
        mergeConversationOnto(raw === null ? null : (JSON.parse(raw) as Conv), staleCopy)
      )
    )
    const merged = JSON.parse(await fs.readFile(target, 'utf8')) as Conv
    ok(
      'merge: stale whole-file save preserves the newer on-disk summary',
      merged.summary === 'the rolling summary' && merged.summarizedThroughMessage === 2,
      JSON.stringify({ summary: merged.summary, mark: merged.summarizedThroughMessage })
    )

    // A real on-disk title beats an incoming 'Untitled'.
    await updateConv((disk) => {
      disk.title = 'Real title'
      return disk
    })
    await diskWriter.update(target, (raw) =>
      JSON.stringify(
        mergeConversationOnto(raw === null ? null : (JSON.parse(raw) as Conv), staleCopy)
      )
    )
    const titled = JSON.parse(await fs.readFile(target, 'utf8')) as Conv
    ok('merge: on-disk title survives an Untitled overwrite', titled.title === 'Real title')
  }

  // ── flush(): no-arg is a bounded snapshot, not a drain-until-empty ──────
  {
    const target = path.join(tmpRoot, 'flush-probe.txt')
    let feeding = true
    // A producer that keeps enqueueing while we flush — the old
    // drain-until-empty semantics would livelock here.
    const producer = (async () => {
      while (feeding) {
        await diskWriter.appendLine(target, 'x\n')
        await new Promise((r) => setImmediate(r))
      }
    })()
    const flushDone = await Promise.race([
      diskWriter.flush().then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 2000))
    ])
    feeding = false
    await producer
    ok('flush: returns while other writers keep enqueueing (no livelock)', flushDone === true)
  }

  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void run()
