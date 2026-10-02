/**
 * Deck-preview tests — pins where rendered slides land and when they are
 * re-rendered. The images are derived data, so the contract is: inside the
 * workspace, under a dot-directory the corpus indexer skips, one directory
 * per deck, re-rendered only when the deck itself changes, and swept when
 * the deck is gone.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/uploads/__tests__/deck-preview.test.mts
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

let failures = 0
function ok(name: string, cond: boolean, extra?: unknown): void {
  console.log(
    `${cond ? 'PASS' : 'FAIL'}: ${name}${extra !== undefined ? ` — ${String(extra)}` : ''}`
  )
  if (!cond) failures++
}

async function main(): Promise<void> {
  // The module under test writes into workspaceRoot(), which is derived from
  // os.homedir() when @main/workspace/root is first imported. Patch the home
  // directory BEFORE that import so nothing ever touches the real ~/.wolffish.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'wolffish-deck-test-'))
  os.homedir = () => home
  // Ask the module for the root rather than spelling it out: this test is
  // mirrored into a sibling app whose workspace lives somewhere else.
  const { workspaceRoot } = await import('../../workspace/root')
  const workspace = workspaceRoot()
  if (!workspace.startsWith(home)) throw new Error(`workspace escaped the sandbox: ${workspace}`)
  const uploads = path.join(workspace, 'uploads', 'conv-test')
  await fs.mkdir(uploads, { recursive: true })

  const { renderDeckPreview, sweepDeckPreviews } = await import('../deck-preview')
  const {
    addSlide,
    addSlideShape,
    addSlideTextBox,
    createPresentation,
    getSlideLayouts,
    getSlides,
    savePresentation,
    setParagraphAlignment,
    setPresentationFonts
  } = await import('@office-kit/pptx')

  async function writeDeck(file: string, slideCount: number): Promise<void> {
    const pres = createPresentation({ size: '16:9' })
    const layout = getSlideLayouts(pres)[0]
    for (let i = 0; i < slideCount; i++) {
      const slide = addSlide(pres, { layout })
      addSlideTextBox(slide, {
        x: 914400 as never,
        y: 914400 as never,
        w: 5486400 as never,
        h: 914400 as never,
        text: `Slide ${i + 1}`
      })
    }
    await fs.writeFile(file, await savePresentation(pres))
    // Sanity: the fixture must be a deck this renderer can read at all.
    if (getSlides(pres).length !== slideCount) throw new Error('fixture slide count mismatch')
  }

  const deckRel = 'uploads/conv-test/deck.pptx'
  const deckAbs = path.join(workspace, deckRel)
  await writeDeck(deckAbs, 3)

  // ── first render ────────────────────────────────────────────────────────
  const first = await renderDeckPreview(deckRel)
  ok('renders every slide', first?.slides.length === 3, first?.slides.length)
  ok('reports the deck total', first?.totalSlides === 3, first?.totalSlides)
  ok(
    'carries a 16:9 canvas',
    !!first && first.width > first.height,
    `${first?.width}x${first?.height}`
  )
  ok(
    'slides live under the dot-directory the corpus skips',
    !!first && first.slides.every((s) => s.startsWith('.previews/decks/')),
    first?.slides[0]
  )
  ok(
    'slide paths stay inside the workspace',
    !!first &&
      (
        await Promise.all(
          first.slides.map((s) =>
            fs
              .access(path.join(workspace, s))
              .then(() => true)
              .catch(() => false)
          )
        )
      ).every(Boolean)
  )

  const dir = path.join(workspace, path.dirname(first!.slides[0]))
  const firstSlideStat = await fs.stat(path.join(workspace, first!.slides[0]))

  // ── cached second call ──────────────────────────────────────────────────
  const second = await renderDeckPreview(deckRel)
  const secondSlideStat = await fs.stat(path.join(workspace, first!.slides[0]))
  ok('unchanged deck returns the same slides', second?.slides.join() === first?.slides.join())
  ok(
    'unchanged deck is not re-rendered',
    secondSlideStat.mtimeMs === firstSlideStat.mtimeMs,
    `${firstSlideStat.mtimeMs} -> ${secondSlideStat.mtimeMs}`
  )

  // ── edited deck ─────────────────────────────────────────────────────────
  await writeDeck(deckAbs, 2)
  const third = await renderDeckPreview(deckRel)
  ok('edited deck re-renders', third?.slides.length === 2, third?.slides.length)
  ok(
    'stale slides from the longer version are gone',
    !(await fs
      .access(path.join(dir, 'slide-003.svg'))
      .then(() => true)
      .catch(() => false))
  )
  ok(
    'one directory per deck, not one per version',
    (await fs.readdir(path.join(workspace, '.previews', 'decks'))).length === 1
  )

  // ── alignment: an autoshape that says nothing must render LEFT ─────────
  // pptxgenjs writes every run of text as a bare autoshape (`<p:cNvSpPr/>`,
  // no `txBox="1"`). The renderer's authoring convention centres autoshape
  // text; PowerPoint resolves the same silence to the deck default, which is
  // left. Without the fix a whole deck came out centred.
  const alignDeck = path.join(uploads, 'align.pptx')
  {
    const pres = createPresentation({ size: '16:9' })
    const layout = getSlideLayouts(pres)[0]
    const slide = addSlide(pres, { layout })
    addSlideShape(slide, {
      preset: 'rect',
      x: 914400 as never,
      y: 914400 as never,
      w: 7315200 as never,
      h: 457200 as never,
      text: 'Silent about alignment'
    })
    const centred = addSlideShape(slide, {
      preset: 'rect',
      x: 914400 as never,
      y: 1828800 as never,
      w: 7315200 as never,
      h: 457200 as never,
      text: 'Deliberately centred'
    })
    setParagraphAlignment(centred, 0, 'center')
    await fs.writeFile(alignDeck, await savePresentation(pres))
  }
  const aligned = await renderDeckPreview('uploads/conv-test/align.pptx')
  const alignSvg = await fs.readFile(path.join(workspace, aligned!.slides[0]), 'utf-8')
  ok(
    'an autoshape with no stated alignment renders left',
    alignSvg.includes('text-align:left'),
    alignSvg.match(/text-align:[a-z]+/g)?.join(',')
  )
  ok(
    'a paragraph that states centre keeps it',
    (alignSvg.match(/text-align:center/g) ?? []).length === 1,
    (alignSvg.match(/text-align:center/g) ?? []).length
  )

  // ── a serif heading must not fall back to a sans ────────────────────────
  // The renderer ends every stack with the deck's body font and a sans-serif
  // generic, so a Cambria heading on a machine without Office came out sans.
  // Exercised directly: these are the exact stacks office-kit emitted for a
  // real Cambria-over-Calibri deck.
  {
    const { repairFontFallbacks } = await import('../deck-preview')
    const serif = repairFontFallbacks(
      'style="font-family:Cambria, Calibri, \'Helvetica Neue\', Arial, sans-serif"'
    )
    const sans = repairFontFallbacks(
      'style="font-family:Calibri, Calibri, \'Helvetica Neue\', Arial, sans-serif"'
    )
    const mono = repairFontFallbacks('style="font-family:Consolas, Calibri, Arial, sans-serif"')
    ok(
      'a serif face falls back to a serif',
      serif.endsWith('serif"') && !serif.includes('sans-serif'),
      serif
    )
    ok('the serif face itself stays first', serif.includes("font-family:'Cambria',"), serif)
    ok('a sans face keeps a sans generic', sans.endsWith('sans-serif"'), sans)
    ok('a mono face falls back to monospace', mono.endsWith('monospace"'), mono)
    ok(
      'a stack that is already generic is left alone',
      repairFontFallbacks('style="font-family:sans-serif"') === 'style="font-family:sans-serif"'
    )
  }

  // And end to end: nothing the renderer emits may be left without a generic.
  {
    const pres = createPresentation({ size: '16:9' })
    setPresentationFonts(pres, { majorLatin: 'Cambria', minorLatin: 'Calibri' })
    const layout = getSlideLayouts(pres)[0]
    const slide = addSlide(pres, { layout })
    addSlideShape(slide, {
      preset: 'rect',
      x: 914400 as never,
      y: 914400 as never,
      w: 7315200 as never,
      h: 457200 as never,
      text: 'Heading'
    })
    await fs.writeFile(path.join(uploads, 'fonts.pptx'), await savePresentation(pres))
  }
  const fontDeck = await renderDeckPreview('uploads/conv-test/fonts.pptx')
  const fontSvg = await fs.readFile(path.join(workspace, fontDeck!.slides[0]), 'utf-8')
  const stacks = [...new Set(fontSvg.match(/font-family:[^;"]+/g) ?? [])]
  ok(
    'every font stack the renderer emits ends in a generic',
    stacks.length > 0 && stacks.every((f) => /(?:sans-serif|serif|monospace)$/.test(f)),
    stacks.join(' | ')
  )

  // ── a renderer change re-renders decks already cached ───────────────────
  const stamped = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8')) as Record<
    string,
    unknown
  >
  ok(
    'the manifest records which renderer drew it',
    typeof stamped.renderer === 'number',
    stamped.renderer
  )
  const beforeStamp = (await fs.stat(path.join(workspace, third!.slides[0]))).mtimeMs
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ ...stamped, renderer: 0 }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  await renderDeckPreview(deckRel)
  ok(
    'a stale renderer stamp forces a re-render',
    (await fs.stat(path.join(workspace, third!.slides[0]))).mtimeMs !== beforeStamp
  )

  // ── refusals ────────────────────────────────────────────────────────────
  const notADeck = path.join(uploads, 'notes.txt')
  await fs.writeFile(notADeck, 'plain text, definitely not a presentation')
  ok(
    'a non-deck renders nothing',
    (await renderDeckPreview('uploads/conv-test/notes.txt')) === null
  )
  ok(
    'a path outside the workspace is refused',
    (await renderDeckPreview('../../escape.pptx')) === null
  )
  ok('a missing file is refused', (await renderDeckPreview('uploads/conv-test/gone.pptx')) === null)

  // ── sweep ───────────────────────────────────────────────────────────────
  await sweepDeckPreviews()
  ok(
    'sweep keeps previews whose deck still exists',
    await fs
      .access(dir)
      .then(() => true)
      .catch(() => false)
  )
  await fs.rm(deckAbs)
  await sweepDeckPreviews()
  ok(
    'sweep drops previews whose deck is gone',
    !(await fs
      .access(dir)
      .then(() => true)
      .catch(() => false))
  )

  await fs.rm(home, { recursive: true, force: true })
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
