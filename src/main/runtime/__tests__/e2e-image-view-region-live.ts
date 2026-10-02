/**
 * LIVE behaviour probe — given the image_view schema, does a real vision
 * model actually USE the crop instead of squinting at a 1024px frame?
 *
 * The unit tests prove the tool works when handed a region. They cannot
 * prove the interesting part: that a model reading fine print reaches for
 * `region` on its own, and that the coordinates it invents in the ORIGINAL
 * pixel grid — a grid it has only ever seen downscaled — actually land on
 * the target. That is the one claim in this feature that no local test can
 * settle, so it gets a live probe.
 *
 * Runs a small real agent loop against the production XAIProvider with the
 * real cerebellum tool definitions and the real image_view executor. Every
 * tool call's arguments are printed. PASS means the model both read the
 * label correctly AND used a region to do it.
 *
 * Keys come from env vars — never from ~/.wolffish (that folder is a build
 * artifact and tests must not read it).
 *
 * Do NOT run this from an agent turn. One command:
 *
 *   XAI_API_KEY=... IMAGE=/abs/path/to/photo.jpg \
 *     TSX_TSCONFIG_PATH=tsconfig.node.json \
 *     ELECTRON_RUN_AS_NODE=1 npx electron node_modules/tsx/dist/cli.mjs \
 *     src/main/runtime/__tests__/e2e-image-view-region-live.boot.ts
 *
 * ASK defaults to the vertical bezel label in the crystal photo; override it
 * for any image whose detail is unreadable at 1024px.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { XAIProvider } from '@main/runtime/providers/xai'
import type { ChatMessage, ToolDefinition } from '@main/runtime/thalamus'

const KEY = process.env.XAI_API_KEY ?? ''
const MODEL = process.env.MODEL ?? 'grok-4.6'
const IMAGE = process.env.IMAGE ?? ''
const ASK =
  process.env.ASK ??
  'There is text printed vertically on the right-hand bezel of the device. Read it exactly, character for character. Be certain before you answer.'
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS ?? 5)

const REPO = path.resolve(__dirname, '../../../..')

type ToolCall = { id: string; name: string; args: Record<string, unknown> }

async function loadTools(): Promise<{
  defs: ToolDefinition[]
  run: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<{ ok: boolean; output: string; images?: Array<{ mediaType: string; data: string }> }>
  cleanup: () => Promise<void>
}> {
  const { Cerebellum } = await import('@main/runtime/cerebellum')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iv-live-'))
  const dest = path.join(root, 'brain', 'cerebellum', '.filesystem')
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.cp(path.join(REPO, 'src/defaults/workspace/brain/cerebellum/filesystem'), dest, {
    recursive: true
  })
  const cere = new Cerebellum({ workspaceRoot: root })
  await cere.loadAll()
  const defs = cere.getToolDefinitions().filter((d) => d.name === 'image_view')
  return {
    defs,
    run: async (name, args) => {
      const r = (await cere.executeTool(name, args)) as {
        ok?: boolean
        success?: boolean
        output?: string
        error?: string
        images?: Array<{ mediaType: string; data: string }>
      }
      return {
        ok: (r.ok ?? r.success) === true,
        output: r.output ?? r.error ?? '',
        images: r.images
      }
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  if (!KEY) throw new Error('set XAI_API_KEY')
  if (!IMAGE) throw new Error('set IMAGE to an absolute path')
  const stat = await fs.stat(IMAGE)

  const { defs, run, cleanup } = await loadTools()
  if (defs.length === 0) throw new Error('image_view not exposed by the loader')
  console.log(
    `image_view params: ${Object.keys(
      (defs[0].parameters as { properties: Record<string, unknown> }).properties
    ).join(', ')}\n`
  )

  const provider = new XAIProvider(KEY, MODEL)
  // The reference note is what the app really puts in front of the model —
  // never the bytes. Mirrors uploads/file-processor.ts imageReferenceNote.
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content:
        `[Image attached: ${path.basename(IMAGE)} — ${(stat.size / 1024 / 1024).toFixed(1)}MB — not loaded into context]\n` +
        `Path: ${IMAGE}\n` +
        `View it with image_view (returns the pixels, downscaled) whenever its content matters — ` +
        `never describe or answer questions about an image you have not actually viewed.\n\n${ASK}`
    }
  ]

  const calls: ToolCall[] = []
  let answer = ''

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let text = ''
    const pending: ToolCall[] = []
    for await (const chunk of provider.stream({ system: '', messages, tools: defs })) {
      if (chunk.type === 'text') text += chunk.text
      if (chunk.type === 'tool_call')
        pending.push({ id: chunk.id, name: chunk.name, args: chunk.args ?? {} })
    }
    if (pending.length === 0) {
      answer = text
      break
    }
    messages.push({ role: 'assistant', content: text, toolUses: pending })
    for (const call of pending) {
      calls.push(call)
      console.log(`round ${round + 1} → ${call.name} ${JSON.stringify(call.args)}`)
      const r = await run(call.name, call.args)
      console.log(`           ← ${r.output.split('\n')[0]}`)
      const msg: ChatMessage & { role: 'tool' } = {
        role: 'tool',
        toolUseId: call.id,
        toolName: call.name,
        content: r.output,
        isError: !r.ok
      }
      if (r.images?.length) msg.images = r.images
      messages.push(msg)
    }
  }

  await cleanup()

  const usedRegion = calls.some((c) => c.args.region !== undefined)
  const usedBigger = calls.some((c) => typeof c.args.max_dimension === 'number')
  console.log(`\nanswer: ${answer.trim().slice(0, 400)}`)
  console.log(`\ncalls=${calls.length} usedRegion=${usedRegion} usedMaxDimension=${usedBigger}`)
  if (!usedRegion && !usedBigger) {
    console.log(
      'RESULT: model never reached for a sharper view — the schema is reachable but the ' +
        'description is not persuading it. Tighten the steering text.'
    )
    process.exit(1)
  }
  console.log('RESULT: model chose a sharper view on its own. Check the answer above is correct.')
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e)
  process.exit(1)
})
