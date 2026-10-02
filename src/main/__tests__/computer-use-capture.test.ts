/**
 * Screenshot resolution and format are the AGENT's, per capture. There is no
 * user control for either any more — not in the desktop panel, not on the
 * phone, not over IPC — so `config.json → computerUse` is a read-only fallback
 * default and `max_width` / `format` on computer_screenshot are the only way
 * they move.
 *
 * Three things have to hold for that to be true rather than merely intended,
 * and all three fail quietly:
 *
 * 1. The rules the model is TOLD (SKILL.md frontmatter, which is the
 *    model-facing schema) must be the rules the plugin ENFORCES. A model
 *    promised 2560 and silently clamped to 2048 stops trusting the knob.
 * 2. No surface may write those two values. A leftover writer would let a
 *    stale phone or panel move a default the agent believes it owns.
 * 3. The frame the model is handed must state the image's REAL height.
 *    libvips picks the resized height itself and does not always agree with
 *    nativeH * (outW / nativeW) rounded — 2560x1600 at width 1500 comes out
 *    937, not 938 — and a crosshair overlay built from the predicted height
 *    makes sharp refuse the composite outright, failing the screenshot. With
 *    fixed 640/960/1280/1920 options that never fired; with model-chosen
 *    widths it would.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/__tests__/computer-use-capture.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// src/main/__tests__ -> repo root
const REPO = path.resolve(HERE, '..', '..', '..')
const read = (rel: string): string => readFileSync(path.join(REPO, rel), 'utf8')

const CAP = 'src/defaults/workspace/brain/cerebellum/computer-use'
const PLUGIN_REL = `${CAP}/plugin/index.mjs`
const pluginSource = read(PLUGIN_REL)
const skill = read(`${CAP}/SKILL.md`)
const vision = read('src/main/runtime/vision.ts')
const thalamus = read('src/main/runtime/thalamus.ts')

type Resolved = {
  cfgWidth: number
  cfgFormat: string
  format: string
  outW: number
  overrode: boolean
  notes: string[]
}
type ResolveCapture = (input: {
  args: Record<string, unknown>
  cfg: Record<string, unknown>
  logicalW: number
  nativeW: number
}) => Resolved

// The plugin's top level pulls in nothing but node:fs/promises and node:path —
// electron, nut-js and sharp all load inside init() — so the real module
// imports here and the real rules run, rather than a copy of them.
let resolveCapture: ResolveCapture

let n = 0
const check = (name: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve()
    .then(fn)
    .then(() => {
      n++
      console.log(`✅ ${name}`)
    })
    .catch((err: unknown) => {
      n++
      console.log(`❌ ${name}: ${(err as Error).message}`)
      process.exitCode = 1
    })

// A 16:10 Retina laptop: 1512 logical, 3024 native.
const laptop = { logicalW: 1512, nativeW: 3024 }
// A 5120-wide super-ultrawide — where the default path's 1/3-of-logical floor
// actually bites (a 3440 one does not: its floor is 1147, under the 1280
// default, so the floor is invisible there).
const ultrawide = { logicalW: 5120, nativeW: 5120 }
const DEFAULTS = { screenshotMaxWidth: 1280, screenshotFormat: 'jpeg' }

const resolve = (
  args: Record<string, unknown>,
  display = laptop,
  cfg: Record<string, unknown> = DEFAULTS
): Resolved => resolveCapture({ args, cfg, ...display })

async function run(): Promise<void> {
  resolveCapture = (
    (await import(pathToFileURL(path.join(REPO, PLUGIN_REL)).href)) as {
      resolveCapture: ResolveCapture
    }
  ).resolveCapture

  // ── 1. the rules the plugin enforces ────────────────────────────────────

  await check('no args = the stored default, and nothing is reported as an override', () => {
    const r = resolve({})
    assert.equal(r.outW, 1280)
    assert.equal(r.format, 'jpeg')
    assert.equal(r.overrode, false)
    assert.deepEqual(r.notes, [])
  })

  await check('a missing config still lands on 1280/jpeg', () => {
    const r = resolve({}, laptop, {})
    assert.equal(r.outW, 1280)
    assert.equal(r.format, 'jpeg')
  })

  await check('the model can raise the width and is told nothing was adjusted', () => {
    for (const w of [1920, 2048, 2560]) {
      const r = resolve({ max_width: w })
      assert.equal(r.outW, w, `max_width ${w}`)
      assert.equal(r.overrode, true)
      assert.deepEqual(r.notes, [], `max_width ${w} should need no correction`)
    }
  })

  await check('the model can lower the width, floors and all', () => {
    const r = resolve({ max_width: 640 })
    assert.equal(r.outW, 640)
    assert.equal(r.overrode, true)
  })

  await check('an explicit low width beats the ultrawide overview floor', () => {
    // The DEFAULT path floors an ultrawide at 1/3 of logical width so the
    // overview stays readable — 1707 here, well above the 1280 default...
    assert.equal(resolve({}, ultrawide).outW, Math.ceil(5120 / 3))
    // ...but an explicit request is a deliberate act, not an accident.
    assert.equal(resolve({ max_width: 640 }, ultrawide).outW, 640)
  })

  await check('out-of-range widths clamp to 480-2560 and SAY they were clamped', () => {
    const low = resolve({ max_width: 100 })
    assert.equal(low.outW, 480)
    assert.match(low.notes.join(' '), /outside the supported 480-2560 range/)

    const high = resolve({ max_width: 9999 })
    assert.equal(high.outW, 2560)
    assert.match(high.notes.join(' '), /outside the supported 480-2560 range/)
  })

  await check('a width beyond what the display captures reports the native ceiling', () => {
    assert.equal(resolve({ max_width: 2560 }, ultrawide).outW, 2560)
    const small = resolveCapture({
      args: { max_width: 2000 },
      cfg: DEFAULTS,
      logicalW: 1280,
      nativeW: 1280
    })
    assert.equal(small.outW, 1280)
    assert.match(small.notes.join(' '), /native 1280px/)
  })

  await check('format overrides work, tolerate "jpg", and never silently swallow junk', () => {
    assert.equal(resolve({ format: 'png' }).format, 'png')
    assert.equal(resolve({ format: 'PNG' }).format, 'png')
    assert.equal(resolve({ format: 'jpg' }).format, 'jpeg')
    assert.equal(resolve({ format: 'png' }).overrode, true)

    const junk = resolve({ format: 'webp' })
    assert.equal(junk.format, 'jpeg', 'falls back to the default')
    assert.match(junk.notes.join(' '), /not recognized/)
    assert.match(junk.notes.join(' '), /jpeg, png/)
  })

  await check('a nonsense max_width falls back instead of producing NaN pixels', () => {
    for (const bad of [0, -5, 'wide', null, undefined, NaN]) {
      const r = resolve({ max_width: bad })
      assert.equal(r.outW, 1280, `max_width ${String(bad)}`)
      assert.equal(r.overrode, false, `max_width ${String(bad)} is not an override`)
    }
  })

  await check('the stored config is a DEFAULT the model can still override', () => {
    const cfg = { screenshotMaxWidth: 1920, screenshotFormat: 'png' }
    assert.equal(resolve({}, laptop, cfg).outW, 1920)
    assert.equal(resolve({}, laptop, cfg).format, 'png')
    assert.equal(resolve({ max_width: 640, format: 'jpeg' }, laptop, cfg).outW, 640)
    assert.equal(resolve({ max_width: 640, format: 'jpeg' }, laptop, cfg).format, 'jpeg')
  })

  // ── 2. what the model is TOLD matches what it gets ──────────────────────

  const screenshotSchema = skill.slice(
    skill.indexOf('- name: computer_screenshot'),
    skill.indexOf('- name: computer_zoom')
  )

  await check('SKILL.md declares both parameters, optional, with a jpeg/png enum', () => {
    assert.match(screenshotSchema, /^ {6}max_width:$/m)
    assert.match(screenshotSchema, /^ {6}format:$/m)
    assert.match(screenshotSchema, /required: false/)
    assert.match(screenshotSchema, /enum:\n\s+- jpeg\n\s+- png/)
  })

  await check('the range SKILL.md advertises is the range the plugin enforces', () => {
    const min = Number(/const MIN_REQ_WIDTH = (\d+)/.exec(pluginSource)?.[1])
    const max = Number(/const MAX_REQ_WIDTH = (\d+)/.exec(pluginSource)?.[1])
    assert.equal(min, 480)
    assert.equal(max, 2560)
    assert.ok(
      screenshotSchema.includes(`${min}-${max}`),
      `SKILL.md must advertise the ${min}-${max} range it is clamped to`
    )
    assert.equal(resolve({ max_width: min }).outW, min)
    assert.equal(resolve({ max_width: max }).outW, max)
  })

  await check('the default SKILL.md quotes is the default the plugin falls back to', () => {
    const dw = Number(/const DEFAULT_MAX_WIDTH = (\d+)/.exec(pluginSource)?.[1])
    assert.equal(dw, 1280)
    assert.ok(screenshotSchema.includes(`default ${dw}`), 'SKILL.md must quote the real default')
    assert.equal(resolve({}).outW, dw)
  })

  await check('the plugin tool mirror carries the same two parameters', () => {
    const mirror = pluginSource.slice(
      pluginSource.indexOf("name: 'computer_screenshot'"),
      pluginSource.indexOf("name: 'computer_zoom'")
    )
    assert.match(mirror, /max_width: \{/)
    assert.match(mirror, /format: \{/)
    assert.match(mirror, /enum: \['jpeg', 'png'\]/)
  })

  await check('the model is told an override does not persist', () => {
    // Both channels say it: the standing schema and the result of every
    // overridden capture. Losing either lets a high-res pass decay to 1280
    // halfway through without anything looking wrong.
    assert.match(screenshotSchema, /does not persist/)
    assert.match(pluginSource, /They do NOT persist/)
  })

  // ── 3. nothing else writes these two values ─────────────────────────────

  await check('the desktop Computer Use panel has no resolution or format control', () => {
    const panel = read('src/renderer/src/pages/settings/ComputerUsePanel.tsx')
    assert.ok(!panel.includes('screenshotMaxWidth'), 'panel must not touch screenshotMaxWidth')
    assert.ok(!panel.includes('screenshotFormat'), 'panel must not touch screenshotFormat')
    assert.ok(!panel.includes('setConfig'), 'panel must not write computer-use config')
  })

  await check('no IPC or workspace setter can write them either', () => {
    const preload = read('src/preload/index.ts')
    const main = read('src/main/index.ts')
    const workspace = read('src/main/workspace/workspace.ts')
    assert.ok(!preload.includes("invoke('computerUse:setConfig'"), 'preload setter must be gone')
    assert.ok(!main.includes("'computerUse:setConfig'"), 'main setConfig handler must be gone')
    assert.ok(
      !/export async function setComputerUseConfig/.test(workspace),
      'workspace setter must be gone'
    )
    // The read side stays: the plugin falls back to it.
    assert.ok(main.includes("'computerUse:getConfig'"), 'the read handler must survive')
    assert.ok(/export async function getComputerUseConfig/.test(workspace))
  })

  await check("the phone cannot set them: not in this app's whitelist", () => {
    // The phone SCREEN lives in the wolffish-mobile repo and is guarded
    // there; this end is the whitelist a phone write has to pass.
    const main = read('src/main/index.ts')

    // applyMobileSettings' switch is a whitelist; an unlisted key throws, which
    // is how a stale phone write is meant to be refused.
    assert.ok(
      !/case 'screenshotMaxWidth'/.test(main),
      'applyMobileSettings must not accept screenshotMaxWidth'
    )
    assert.ok(
      !/case 'screenshotFormat'/.test(main),
      'applyMobileSettings must not accept screenshotFormat'
    )
    // The browser extension keeps its own pair — this is a computer-use change.
    assert.ok(/case 'browserScreenshotMaxWidth'/.test(main))
    assert.ok(/case 'browserScreenshotFormat'/.test(main))

    // MOBILE_KEY_SERVICE drives the re-seed fan-out; a key left there points
    // at a panel that can no longer be written.
    assert.ok(
      !/^\s*screenshotMaxWidth: 'computerUse',$/m.test(main),
      'MOBILE_KEY_SERVICE must not still route screenshotMaxWidth'
    )
    assert.ok(
      !/^\s*screenshotFormat: 'computerUse',$/m.test(main),
      'MOBILE_KEY_SERVICE must not still route screenshotFormat'
    )
    assert.ok(/^\s*browserScreenshotMaxWidth: 'browserExtension',$/m.test(main))
  })

  await check('the CLI surface has no computer-use capture control either', () => {
    // This fork has a settings surface the cloud build does not, and its rows
    // name their IPC channel as a STRING — so a row left pointing at the
    // deleted computerUse:setConfig typechecks fine and silently does nothing
    // at runtime. cli-settings-table.test.ts catches that in general; this
    // pins the specific rows, and the card that held only them.
    const cli = read('src/main/channels/cli/settings.ts')
    assert.ok(
      !cli.includes("channel: 'computerUse:setConfig'"),
      'no CLI row may write through the deleted computer-use setter'
    )
    assert.ok(
      !/id: 'services\.computerUse\.screenshot/.test(cli),
      'the CLI screenshot rows must be gone'
    )
    assert.ok(
      !/id: 'services\.computerUse',/.test(cli),
      'the card those rows lived on is empty now and must go too'
    )
    // The browser extension keeps its own — this is a computer-use change.
    assert.ok(cli.includes("read: 'services.browserExtension.screenshotMaxWidth'"))
  })

  // ── 4. PNG is honored only up to the request-size ceiling ───────────────

  await check('the per-image byte budget stays under what providers accept', () => {
    const budget = Number(
      /const MAX_IMAGE_B64_BYTES = ([\d.]+) \* 1024 \* 1024/.exec(pluginSource)?.[1]
    )
    assert.ok(Number.isFinite(budget), 'MAX_IMAGE_B64_BYTES must be declared in MB')
    // vision.ts keeps the newest 6 tool images and a 413 is a HARD status —
    // not retried — so an oversized capture fails the turn outright instead
    // of backing off. Six budgets have to stay inside the tightest per-image
    // limit we ship against (Anthropic: 5 MB an image).
    const keep = Number(/export const TOOL_IMAGES_KEEP = (\d+)/.exec(vision)?.[1])
    assert.equal(keep, 6)
    assert.ok(
      /HARD_STATUSES = new Set\(\[[^\]]*413/.test(thalamus),
      '413 must still be a hard, non-retried status — that is why the budget exists'
    )
    assert.ok(budget < 5, `${budget}MB must stay under the 5MB per-image provider limit`)
  })

  await check('an over-budget PNG falls back to JPEG at the SAME width, and says so', async () => {
    const sharp = (await import('sharp')).default
    const budget = 1.2 * 1024 * 1024
    const ratio = 4 / 3
    const outW = 1920
    // Noise stands in for a screen PNG cannot compress — the real 1920 and
    // 2560 screen captures that motivated the budget measured 1.7 MB and
    // 3.8 MB of base64.
    const px = Buffer.alloc(outW * 1200 * 3)
    for (let i = 0; i < px.length; i++) px[i] = (Math.random() * 256) | 0
    const pipe = (): ReturnType<typeof sharp> =>
      sharp(px, { raw: { width: outW, height: 1200, channels: 3 } })

    const png = await pipe().png().toBuffer()
    assert.ok(png.length * ratio > budget, 'this case must actually exceed the budget')

    const jpeg = await pipe().jpeg({ quality: 85 }).toBuffer()
    const meta = await sharp(jpeg).metadata()
    assert.equal(meta.width, outW, 'the fallback must keep the requested width')
    assert.equal(meta.format, 'jpeg')
    assert.ok(jpeg.length < png.length, 'the fallback must actually be smaller')

    // And the plugin must take that branch rather than shipping the PNG.
    assert.match(pluginSource, /buffer\.length \* B64_RATIO > MAX_IMAGE_B64_BYTES/)
    assert.match(pluginSource, /encoded as JPEG at the SAME \$\{outW\}px/)
    // The note has to reach the model even when nothing else was overridden —
    // a stored png default hits this path with no per-call override at all.
    assert.match(pluginSource, /: downgradeNote$/m)
    // Whitespace-normalized: the sentence is prose and re-wraps whenever the
    // paragraph is edited, but the promise it makes must not change.
    const prose = skill.replace(/\s+/g, ' ')
    assert.ok(
      prose.includes('**encoded as JPEG at the same width**'),
      'SKILL.md must document the fallback'
    )
    assert.ok(
      prose.includes('The width you asked for is always honored'),
      'SKILL.md must promise the requested width survives the fallback'
    )
  })

  // ── 4. the frame must state the image's real height ─────────────────────

  await check('the plugin measures the resized height instead of predicting it', () => {
    assert.ok(
      pluginSource.includes('const outH = resized.info.height'),
      'takeScreenshot must read the height back from the resized image'
    )
    assert.ok(
      !/const outH = Math\.round\(nativeH \* \(outW \/ nativeW\)\)/.test(pluginSource),
      'the predicted-height formula must not come back — it fails the composite'
    )
  })

  await check('and the prediction it replaced really does break a real capture', async () => {
    const sharp = (await import('sharp')).default
    // The exact shape takeScreenshot builds: resize to outW, then composite a
    // crosshair overlay sized to the height. 2560x1600 at 1500 is the case that
    // exposed this — the model may now ask for any width in range, so the test
    // pins the mechanism rather than the one number.
    const [nativeW, nativeH, outW] = [2560, 1600, 1500]
    const base = await sharp({
      create: { width: nativeW, height: nativeH, channels: 3, background: { r: 9, g: 9, b: 9 } }
    })
      .png()
      .toBuffer()

    const predicted = Math.round(nativeH * (outW / nativeW))
    const resized = await sharp(base)
      .resize({ width: outW, withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true })
    assert.notEqual(
      resized.info.height,
      predicted,
      'this case must still disagree with the formula'
    )

    const overlay = (h: number): Buffer =>
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${h}"><rect width="4" height="4" fill="magenta"/></svg>`
      )
    const composite = (h: number): Promise<Buffer> =>
      sharp(resized.data, {
        raw: {
          width: resized.info.width,
          height: resized.info.height,
          channels: resized.info.channels
        }
      })
        .composite([{ input: overlay(h), left: 0, top: 0 }])
        .jpeg({ quality: 85 })
        .toBuffer()

    await assert.rejects(
      () => composite(predicted),
      /same dimensions or smaller/,
      'the predicted height must be the thing that breaks'
    )
    const ok = await composite(resized.info.height)
    const meta = await sharp(ok).metadata()
    assert.equal(meta.width, outW)
    assert.equal(meta.height, resized.info.height)
    assert.equal(meta.format, 'jpeg')
  })

  console.log(`\n${n} checks run`)
}

void run()
