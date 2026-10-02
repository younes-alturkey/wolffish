/**
 * Prepare platform-specific icon masters.
 *
 * macOS pipeline (icon-master.png):
 *   1. Read the original full-bleed square master (resources/images/icon.png).
 *   2. Downscale it to 824x824 — matching Apple's ~80% inner artwork ratio so
 *      the icon renders at the same visual footprint as native apps (Finder,
 *      Safari) in the Dock.
 *   3. Apply the Apple-style squircle mask (superellipse, n~5) to that 824
 *      artwork so macOS renders the right shape — macOS does not auto-mask.
 *   4. Composite the masked 824 artwork centered onto a 1024x1024 transparent
 *      canvas, yielding 100px transparent padding on each side.
 *
 * Windows/Linux pipeline (icon-master-win.png):
 *   1. Read the same original master.
 *   2. Resize to 1024x1024 full-bleed (no mask, no padding).
 *      Windows and Linux DEs expect icons to fill the full canvas.
 *
 * The original resources/images/icon.png is never modified.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..', '..')

const CANVAS = 1024
const ARTWORK = 824
const PAD = (CANVAS - ARTWORK) / 2
const SUPERELLIPSE_N = 5

const input = resolve(projectRoot, 'resources/images/icon.png')
const outputMac = resolve(projectRoot, 'resources/images/icon-master.png')
const outputWin = resolve(projectRoot, 'resources/images/icon-master-win.png')

// --- macOS: squircle-masked, 80% with padding ---
const artworkBuf = await sharp(input)
  .resize(ARTWORK, ARTWORK, { kernel: 'lanczos3' })
  .ensureAlpha()
  .raw()
  .toBuffer()

const r = ARTWORK / 2
for (let y = 0; y < ARTWORK; y++) {
  for (let x = 0; x < ARTWORK; x++) {
    const idx = (y * ARTWORK + x) * 4
    const dx = Math.abs(x + 0.5 - r) / r
    const dy = Math.abs(y + 0.5 - r) / r
    const v = dx ** SUPERELLIPSE_N + dy ** SUPERELLIPSE_N
    if (v > 1) {
      artworkBuf[idx + 3] = 0
    } else {
      const edge = 1 - v
      if (edge < 0.02) {
        const t = edge / 0.02
        artworkBuf[idx + 3] = Math.round(artworkBuf[idx + 3] * t)
      }
    }
  }
}

const artworkImg = sharp(artworkBuf, { raw: { width: ARTWORK, height: ARTWORK, channels: 4 } })

await sharp({
  create: { width: CANVAS, height: CANVAS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
})
  .composite([{ input: await artworkImg.png().toBuffer(), left: PAD, top: PAD }])
  .png()
  .toFile(outputMac)

console.log(`wrote ${outputMac} (${CANVAS}x${CANVAS}, ${ARTWORK}x${ARTWORK} centered)`)

// --- Windows/Linux: full-bleed with rounded corners ---
const WIN_RADIUS = Math.round(CANVAS * 0.2)
const roundedMask = Buffer.from(
  `<svg width="${CANVAS}" height="${CANVAS}"><rect x="0" y="0" width="${CANVAS}" height="${CANVAS}" rx="${WIN_RADIUS}" ry="${WIN_RADIUS}" fill="white"/></svg>`
)

const winResized = await sharp(input)
  .resize(CANVAS, CANVAS, { kernel: 'lanczos3' })
  .ensureAlpha()
  .toBuffer()

await sharp(winResized)
  .composite([{ input: roundedMask, blend: 'dest-in' }])
  .png()
  .toFile(outputWin)

console.log(`wrote ${outputWin} (${CANVAS}x${CANVAS}, full-bleed)`)
