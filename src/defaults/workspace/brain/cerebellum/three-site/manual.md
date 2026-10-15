# The 3D Web Design Manual

You are about to build a three.js page a person will open in a browser and judge
against the best WebGL sites they have seen. This manual is the difference between a
site that wins a Site of the Day and a spinning cube over a gradient. Follow it for
any 3D website, hero section, scroll-driven 3D page, abstract shader scene, or
interactive WebGL experience — unless the user already specified the design. A page
with no 3D in it is `web_design`'s job; a game is `three_game_design`'s.

**Precedence.** Explicit user or automation instructions win. Everything unspecified
follows this manual. This is a system, not a template: section 10 says what to vary.

**Where it comes from.** The doctrine is distilled from the most-starred three.js
work (mrdoob/three.js, react-three-fiber, the CloudAI-X and threejs-game-skills agent
skills, img2threejs's code-only procedural models) and from write-ups of Awwwards and
FWA three.js winners (Lusion's Oryzo, Shopify Editions, Cartier Watches & Wonders,
IVRESS, Primland). The reference builds beside this manual are the proof that the
rules below produce the result.

---

## 1. The pipeline — exact steps, in order

1. **Plan** (section 2): the one hard idea, the object, the beat map. Before any code.
2. **Author one self-contained HTML file** in the workspace (e.g. `files/aura.html`):
   inline CSS, one `<script type="module">`, and a pinned import map. three.js is the
   **only** external resource and it must be pinned:
   ```html
   <script type="importmap">
   { "imports": {
     "three": "https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js",
     "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/"
   } }
   </script>
   ```
   No other CDN, no webfont URL, no image or model files unless the user supplied
   them. Everything visible is procedural: geometry from primitives, textures from
   shaders or canvas, audio from Web Audio.
   **If the brief says "self-contained" or "offline":** three.js cannot be inlined
   (600 KB of library is not a page), so say in one sentence that the page needs the
   pinned CDN for three.js and nothing else, and proceed with the import map. Only
   when the user supplies a local `three.module.js` do you point the map at that
   file instead. Never answer a 3D brief with a 2D canvas to dodge the CDN.
3. **Verify — mandatory** (section 9): open it in a browser, desktop and phone
   viewport, read the console, read the fps/draw-call readout, LOOK at screenshots.
4. **Deliver:** `send_file` the `.html` and say that it must be opened in a browser —
   the in-app preview card is sandboxed and runs no scripts, so the 3D cannot show
   there. Say which phone tier you tested.

## 2. Plan before code — the one hard idea

Award sites do not stack effects. Each picks one hard idea and executes it cleanly.
Write these four lines down before touching the file; they decide everything after.

- **The idea.** One sentence: *"one object you take apart by scrolling"*, *"a sheet of
  light that remembers where you touched it"*, *"a terrain flythrough"*. If you have
  two ideas, you have none yet.
- **The object.** Award sites *sell one object properly*: weight, inertia, material
  response. Name it, and name its three parts (core / shell / satellites; sheet /
  dust / light). Build it from primitives with authored silhouette, trim, and state
  cues — "glow does not make primitives look premium."
- **The beat map.** Scroll is the narrative device. One row per section: *section ·
  the reader's question · camera pose · object state · backdrop mood*. Four to six
  beats; each beat has an entrance, a hold, and an exit. The hero beat answers the
  whole page in one line of copy and one framing of the object.
- **The restraint line.** Which one or two moments are the strong ones (the explode,
  the crystallize, the network lighting up)? Everything else stays quiet so they
  land. Generic particle backgrounds and floating orbs are the usual reason sites
  lose; a full-viewport fragment shader is the best impact-to-effort opener.

Then read the plan back: *would I have made these choices for any brief?* If yes,
they are defaults in costume. Change one and say why.

**Calibrate the treatment.** A product/brand site wants the editorial treatment:
serif display type, a dark ground, one accent (copper, gold, bone), HTML sections
with real copy. An abstract study wants almost no UI: three words, three lines, the
surface. A hero for an otherwise ordinary page wants the 3D confined to one viewport
with the rest of the page following `web_design`.

## 2b. The doctrine behind the reference builds — follow it, don't admire it

The two reference builds were not produced by the rules above alone; they were produced
by these rules plus a way of looking. Both are required. This is what the author did,
in order, and what you do too.

**Before code: four sentences on paper.** One idea; one object with three named parts;
a beat table; a restraint line. For AURA they were: *one node you take apart by
scrolling* · core (faceted gold crystal), lattice (wire cage), satellites (48–96 orbiting
octahedra) · hero / explode / network / numbers / join · the strong moments are the
explode and the network lighting up, everything else is quiet. For MERIDIAN: *a sheet of
light that remembers where you touched it* · sheet, dust, light · silk / tension /
crystal · the strong moment is the crystallization; no post-processing at all.

**The references are a method, not a quarry.** Read them for structure, values and
the verify loop. Never reuse their copy: not a headline, a lead line, a title, a
button label, a stat, a ticker row. Every word on your page is written for the brief
in front of you, and the object, accent and interaction verb are chosen for it (section
10). A page that could be mistaken for a reference in a line-up has failed critique
question 8, however well it runs.

**Composition rules that were applied on every frame.**
1. The room is dark and the object is the light source. The backdrop is a near-black
   fbm noise at low mix, a warm glow that follows the beat, and a vignette; the object
   gets the environment map, the rim light and the accent point light. Never the reverse.
2. Negative space must survive the brightest beat. If a screenshot has no black left in
   it, the exposure, bloom or backdrop is too generous — fix the room, not the object.
3. The copy owns one side of the frame and the object owns the other. Aim the look
   target *past* the object so it sits beside the headline; on phones give the object the
   space above or below the copy with its own camera pose.
4. Display copy over 3D always wears a scrim (`text-shadow: 0 2px 24px rgba(bg,.85)`),
   and lead copy is one step brighter than muted. Cards blur what is behind them.
5. One warm accent on a dark ground: copper `#e0a96d` / bone `#ecebe6` for a product;
   coral `#ff7a59` for a study. The accent appears in eyebrows, the CTA dot, the
   progress bar, the point light and the emissive — and nowhere else.
6. Type: a system serif display face at `clamp(44px, 8.5vw, 120px)` with line-height
   .96 and balanced wrapping; mono eyebrows letter-spaced `.22em`; nothing centered on
   a product site except the closing beat.
7. Evidence is part of the design: a live `fps · calls` readout in the footer stays in
   the delivered page. With a composer, `renderer.info` resets on every internal
   render, so read it right: `renderer.info.autoReset = false` once, then
   `renderer.info.reset()` at the top of each frame and `renderer.info.render.calls`
   after the composer — that is the whole frame's draw calls, post passes included.

**Values that produced the look** (start here, then tune by looking):
- Renderer: ACES tone mapping, exposure `0.92`, DPR ≤ 2 (1.5 phone), antialias desktop only.
- Hero object: `IcosahedronGeometry(1, 1)` flat-shaded `MeshPhysicalMaterial` — color
  `0xd9a46a`, metalness 1, roughness .18, clearcoat 1, envMapIntensity 1.6, emissive
  `0x3a1f0a` at .35 — inside `EdgesGeometry(Icosahedron(1.55, 1))` lines at .55 opacity
  and a `DoubleSide` cage at .18 opacity; satellites `OctahedronGeometry(.09)` with
  emissive intensity .22, never higher (they bloom into blobs).
- Lights: `RoomEnvironment` PMREM + one rim `DirectionalLight(0xf5d3a4, 2.2)` from
  behind + one accent `PointLight(0xe0a96d, 18, 12, 2)` that follows the pointer.
- Bloom (desktop only): strength .32, radius .6, threshold .86 — then `OutputPass`.
- Camera: FOV 38, hero at `z 7.2`; beats move it between `z 5.6` and `9.5`.
- Easing: `x += (target - x) * (1 - Math.pow(0.001, dt))` for scroll, `0.02` for camera.
- Surface (MERIDIAN): plane 18×18, 160 segments (90 phone), tilted `-1.25 rad`, camera
  `(0, .3, 6.4)` looking at `(0, -.9, 0)`; noise `0.26·1.15 + 0.7·0.3 + 1.8·0.05`;
  highlights only carry the iridescence, `hsl(fract(0.96 + band·0.11), .62, .56)`;
  crystal specular power 140 at strength 1.5; far fade from `z -15` to `-5`.

**The first-look critique — run it on the first screenshot of every build.** Look at
the hero and the busiest beat, desktop and phone, and answer each question with a yes
or a fix. The author's first AURA frame failed four of these; the second passed all.

| Question | Usual fix |
|---|---|
| Is there still black in the frame at the brightest beat? | exposure ↓, bloom threshold ↑, backdrop mix ↓ |
| Is the object beside the copy, not behind it? | move the look target, give phones their own pose |
| Can I read the lead copy over the busiest beat? | scrim, lead colour one step brighter, dim the field behind it |
| Does the object read as material (metal, glass, silk) rather than coloured plastic? | env map, flat shading, clearcoat; lower emissive |
| Do the small things (satellites, peers, dust) stay small? | emissive ≤ .25, size ↓, opacity ↓ |
| On the phone, does the canvas fill the screen on every beat? | visual-viewport sizing |
| Is the hero copy readable within one second of load? | reveals and kinetic type run from an inline classic script, never from the module; loader covers only the canvas |
| Would I have made these choices for any brief? | change one of accent, face, object, interaction — and say why |

Two fix cycles are normal. A third means the idea was wrong, not the values.

## 3. Architecture — fixed canvas, flowing HTML

```
<canvas id="gl">            fixed, top/left 0, z-index 0, sized by JS (section 4)
<header> + <main> sections  position: relative, z-index 2, native scroll
<footer>                     with a live "fps · calls" readout (keep it: it is evidence)
#loader                      covers ONLY the canvas (z-index between canvas and .ui); the copy
                             is readable from the first paint; fades on the first rendered frame
#fallback                    shown when WebGLRenderer throws
```

- **HTML first.** Every section is real, readable copy that works with scripts off
  and reads in search. The 3D is behind it, never instead of it.
- **Native scroll, eased progress.** Do not hijack the wheel. Read scroll position,
  normalize to 0–1, and ease it in the frame loop with a frame-rate-independent lerp:
  `scroll += (target - scroll) * (1 - Math.pow(0.001, dt))`.
- **Text over 3D gets a scrim.** `text-shadow: 0 2px 24px rgba(bg,.85)` on display
  and lead text, and `backdrop-filter: blur(10px)` cards. Verified at the brightest
  frame of the brightest beat, not the first frame.
- **Reveals** via `IntersectionObserver` adding `.in`; counters animate on entry; a
  2px scroll progress bar at the top is cheap and welcome. **All of that lives in an
  inline classic `<script>` after the markup, not in the module**: the module waits on
  the three.js fetch (seconds on a phone), and copy whose reveal is gated on it is a black
  screen until then. The first paint shows the full hero copy; only the canvas fades in.
- **Touch.** `touch-action: pan-y` on the canvas so the page still scrolls; only a
  press that starts on the canvas (or empty section space) grabs the object.

## 4. The canonical boot — copy this, then adapt

```js
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Size from the visual viewport, never window.inner*: it equals the window on a phone and
// stays right under pinch-zoom, in-app browsers and device emulators, where the window can be
// far larger than what is on screen. The fixed canvas follows the visual viewport's offset.
const vv = window.visualViewport;
const VW = () => Math.round(vv ? vv.width : document.documentElement.clientWidth);
const VH = () => Math.round(vv ? vv.height : document.documentElement.clientHeight);
const PAGE_TOP = () => (vv ? vv.pageTop : scrollY);
const placeCanvas = () => { if (vv) canvas.style.transform = `translate(${vv.offsetLeft}px, ${vv.offsetTop}px)`; };

const MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(VW(), VH()) < 700;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const DPR = Math.min(devicePixelRatio || 1, MOBILE ? 1.5 : 2);
const TIER = { satellites: MOBILE ? 48 : 96, peers: MOBILE ? 140 : 320, bloom: !MOBILE };

let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: !MOBILE, powerPreference: 'high-performance' }); }
catch { fallback.style.display = 'block'; canvas.remove(); loader.classList.add('gone'); }
if (renderer) boot();

function boot() {
  renderer.setPixelRatio(DPR); renderer.setSize(VW(), VH(), true);   // true: the canvas owns its CSS size
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.92;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, VW() / VH(), 0.1, 100);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; pmrem.dispose();
  // ...objects (section 5), backdrop (section 6)...
  let composer = null;
  if (TIER.bloom) {                                   // post only where the budget allows
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(VW(), VH()), 0.32, 0.6, 0.86));
    composer.addPass(new OutputPass());               // required: tone mapping + color space live here
  }
  const onResize = () => { camera.aspect = VW() / VH(); camera.updateProjectionMatrix();
    renderer.setSize(VW(), VH(), true); composer?.setSize(VW(), VH()); placeCanvas(); };
  addEventListener('resize', onResize); vv?.addEventListener('resize', onResize);
  let scrollTarget = 0, scroll = 0;
  const onScroll = () => { scrollTarget = Math.max(0, Math.min(1, PAGE_TOP() / (document.documentElement.scrollHeight - VH()))); placeCanvas(); };
  addEventListener('scroll', onScroll, { passive: true }); vv?.addEventListener('scroll', onScroll); onScroll();
  const timer = new THREE.Timer(); timer.connect(document); let visible = true;   // Clock is deprecated in r186
  document.addEventListener('visibilitychange', () => { visible = !document.hidden; if (visible) { timer.update(); tick(); } });
  function tick() {
    if (!visible) return; requestAnimationFrame(tick);
    timer.update(); const dt = Math.min(timer.getDelta(), 0.05), t = timer.getElapsed();
    scroll += (scrollTarget - scroll) * (1 - Math.pow(0.001, dt));
    // ...choreography (section 5)...
    if (composer) composer.render(); else renderer.render(scene, camera);
  }
  tick(); requestAnimationFrame(() => loader.classList.add('gone'));
}
```

r186 facts the boot relies on (recalled from the three.js changelog; the reference
builds run on them): `outputColorSpace` defaults to sRGB; addons import from
`three/addons/`; `OutputPass` is what applies tone mapping in a composer; there is no
`sRGBEncoding` any more; `THREE.Clock` logs a deprecation warning — use `THREE.Timer`
(`update()` once per frame, then `getDelta()` / `getElapsed()`, `connect(document)` to
zero the delta while hidden); `MeshPhysicalMaterial` transmission costs a full extra pass —
avoid it on phones, fake glass with `transparent` + env map instead.

## 5. The object and the choreography

**Build the object from primitives with a silhouette.** A flat-shaded
`IcosahedronGeometry(1, 1)` in `MeshPhysicalMaterial({ metalness: 1, roughness: .18,
clearcoat: 1, flatShading: true })` lit by `RoomEnvironment` reads as a jewel; the same
sphere in `MeshStandardMaterial` default reads as a demo. Layer it: a core, a wire
`EdgesGeometry` lattice, a translucent cage, an `InstancedMesh` of orbiting
satellites. State cues per beat: explode factor scales the shells, lattice opacity
rises, satellites orbit wider.

**Lighting.** The environment map does the material work. Add one rim
`DirectionalLight` from behind for the silhouette and one `PointLight` in the accent
colour that follows the pointer. Two lights, no shadows, on a site; shadows are for
grounding a product on a floor and cost a pass.

**Beats.** A table of poses, interpolated with smoothstep between neighbours:
```js
const beats = [ { cam: [0,-.2,7.2], look: [0,.2,0], explode: 0, scale: 1, warm: .15 }, /* … */ ];
const seg = scroll * (beats.length - 1), i = Math.min(beats.length - 2, Math.floor(seg)), f = seg - i;
// smooth(a, b, f) = a + (b - a) * f*f*(3-2f), applied per field
```
Put the object **beside** the copy, not behind it: to show it on the left, aim the
look target to the right of it (`look: [1.6, .1, 0]` with the object at the origin).
Phones get their own poses (above or below the copy), set in one `if (MOBILE)` line.

**Pointer.** Parallax adds `pointer * 0.35` to the camera target; a drag on the canvas
spins the object with velocity and inertia (`vel *= 0.94` per frame after release).
Pointer events only; never mouse + touch pairs.

**Motion with `prefers-reduced-motion`:** no auto-rotation, reveals instant, the
object still responds to drag and scroll.

## 6. Shaders — the backdrop and the abstract surface

**Full-viewport backdrop (every site).** A `PlaneGeometry(2, 2)` with
`depthTest: false`, `gl_Position = vec4(position.xy, 0.999, 1.0)`, `frustumCulled =
false`, `renderOrder = -1`. Fragment: value-noise fbm of `uv` with time, a warm
radial glow that follows the beat, a vignette, 3% grain. Pass the resolution as a
`uRes` uniform (and divide by DPR) — never bake numbers into the shader string. Keep it
dark: mix the noise in at `0.45`, not `0.9`; the object is the light source, the
backdrop is the room.

**Abstract surface (the scene recipe, proven in `scene-meridian.html`).**
- One `PlaneGeometry(18, 18, SEG, SEG)` — `SEG` 160 desktop, 90 phone — in a
  `ShaderMaterial`, tilted to a grazing angle (`rotation.x ≈ -1.25`, camera slightly
  above, looking down) so it has a horizon and dark sky, not a border.
- Vertex: simplex noise displacement in three octaves (`0.26·1.15 + 0.7·0.3 + 1.8·0.05`
  scale·amplitude), a second "crystal" field (`abs(noise)`), mixed by `uMorph`. Normals
  by finite differences in the vertex shader for the smooth phase.
- Fragment: `cross(dFdx(vPos), dFdy(vPos))` gives faceted normals; mix smooth → facet
  with `uMorph` and the surface crystallizes. Iridescence lives **only in the
  highlights**, in a narrow hue window (`hsl(fract(0.96 + band * 0.11), …)` runs copper
  → rose → violet); the base stays near-black. Fade far fragments to the background.
- Interaction: `uPointer` (x, y, pull) eased toward the raycast hit on the surface's
  plane; a ring buffer of 10 `uRipples` (x, y, startTime, strength) written on tap;
  scroll drives `uMorph` across the middle half of the page and tilts the sheet.
- A `Points` dust field with additive blending leans toward the pointer — 1500
  desktop, 500 phone. No post-processing: the shader is the effect.

## 7. Mobile — the real target

Test on the phone viewport first, not last; the desktop GPU hides everything.

| Rule | Value |
|---|---|
| Tier detection | `(pointer: coarse)` OR min side < 700px |
| DPR cap | 2 desktop · 1.5 phone |
| Post passes beyond render + output | ≤ 1 desktop · 0 phone |
| Draw calls (worst beat) | ≤ 300 desktop · ≤ 150 phone (reference site: 9) |
| Triangles | ≤ 750k · ≤ 300k |
| Textures | ≤ 60 · ≤ 40 (procedural sites: 1, the PMREM) |
| Shadow-casting lights | ≤ 2 · 1, and none on a site without a floor |
| Instance / particle counts | halve them on phone, in one `TIER` object |
| `antialias` | desktop only (bloom's blur hides aliasing anyway) |
| Loader | sits above the canvas and below the copy, never over the text; fades on the first frame, and on a 12 s deadline reveals the static fallback (a blocked CDN must not mean a page that never finishes). Phones load the modules in seconds, and a reader who sees a black screen for five seconds leaves |
| Hidden tab | stop the loop; resume with a fresh `clock.getDelta()` |
| Safe areas | `viewport-fit=cover` + `env(safe-area-inset-*)` on fixed header/footer |
| Nav | collapses under 820px; CTA ≥ 44px tall |

The visual-viewport sizing in section 4 is not optional: with `window.innerWidth` and
`inset: 0`, an in-app browser or an emulator shows only the top-left corner of the
canvas, and nobody notices on a desktop.

## 8. Type, colour, copy

- **Display face:** a system serif (`"Iowan Old Style", "Palatino Linotype", Georgia`)
  at `clamp(44px, 8.5vw, 120px)`, line-height .96, `text-wrap: balance`. Body: the
  system sans at 17px. Mono for eyebrows and tickers, letter-spaced `.22em`, uppercase.
- **Palette:** one dark ground (`#07080c` / `#06050a`), one warm accent (copper
  `#e0a96d`, coral `#ff7a59`), bone text (`#ecebe6`), muted `#6c6b66`. Gold-or-copper
  on dark is the current award palette; neon rainbows read as 2019.
- **Copy:** every section has a job and a claim, not a topic. Numbers as stat tiles
  with animated counters; a ticker of live-looking rows sells "network". Say what the
  object is in the hero line (*"One node. Every transaction. No middlemen."*).
- A `mix-blend-mode: difference` header stays legible over light and dark beats.

## 9. Verify before delivering — mandatory

You never deliver a 3D page you have not watched run. The failures — a washed-out
frame, an object hiding behind the copy, a canvas showing one corner on a phone, a
`three/addons` 404 — are silent in the source and obvious on screen.

1. Serve or open the file in the browser capability (`browser_launch` headless →
   `browser_navigate`; `file://` works because the import map is absolute).
2. `browser_screenshot` the hero after the loader fades (wait ≥ 3 s on first load),
   then at each beat (scroll in steps), then `image_view` each.
3. Read the console: zero errors is the bar. A 404 on `three/addons/` means the
   import map is wrong; a GLSL compile error names the line.
4. Read the footer readout (`fps · calls`): desktop ≥ 55 fps, phone tier ≥ 45; draw
   calls under section 7's budget at the busiest beat.
5. Phone viewport (390 × 844, pointer coarse): repeat 2–4. If the emulator reports a
   window larger than the visual viewport, the canvas must still fill the screen on
   every beat — that is what the visual-viewport sizing is for.
6. Run the first-look critique from section 2b on the hero and the busiest beat, then
   this checklist — fix and re-shoot if any fails:
   - The brightest beat still has dark negative space; nothing reads milky (bloom
     strength ≤ .35, threshold ≥ .85, exposure ≤ .95 are the usual fix).
   - Display copy legible over the 3D at every beat (scrims present).
   - Object beside copy on desktop, above/below it on phone; never behind cards.
   - No horizontal page scroll at 390px; `touch-action: pan-y` lets the page scroll.
   - Loader gone; fallback hidden when WebGL works and shown when it doesn't.
   - Reduced motion honoured; hidden tab stops the loop.
7. Only then `send_file`, naming what you tested (viewports, fps, calls).

One fix cycle is expected; two is fine; a third means simplify the failing beat.

## 10. Vary per page — and never vary

Vary: the object and its three parts, the number and order of beats, the accent, the
display face (serif vs. a geometric sans for a product), the backdrop mood, whether the
object explodes, orbits, or crystallizes, the interaction verb (drag, tap, hover).
Never vary: one hard idea, HTML first, the pinned import map, visual-viewport sizing,
the phone tier, the dark ground with a single accent, the verify loop.

## 11. Failure catalog

- **Milky, washed-out frame.** Bloom strength/threshold too generous, exposure > 1,
  backdrop noise mixed in too strong. Darken the room; the object is the light.
- **Object behind the cards.** Camera looks at the object instead of past it. Aim the
  look target beside the object; give phones their own pose.
- **Canvas shows one corner on a phone or emulator.** Sized from `window.innerWidth`
  with `inset: 0`. Use the visual-viewport boot.
- **Colours wrong inside the composer.** Missing `OutputPass`.
- **Transmission glass stutters on phones.** Fake it: `transparent: true, opacity:
  .18, metalness: .9` with the env map.
- **Particles everywhere, nothing to look at.** The restraint line was skipped. Cut
  the field to context (opacity .2, behind the object) and sell the object.
- **Scroll jank.** The page is scroll-hijacked, or scroll work happens in the handler.
  Read scroll in the handler, ease it in the loop; keep handlers passive.
- **Reveal text never appears.** `.reveal` starts at opacity 0 and the observer was
  attached before the elements existed, or the threshold never meets a short section.
- **The footer says "1 calls" under a composer.** `renderer.info` auto-reset left only
  the output quad. Disable auto-reset and reset per frame (section 2b, rule 7).
- **The page reads like the reference.** Copy or labels were reused. Rewrite for the
  brief; the references license their method, not their words.
- **Black screen for seconds on a phone.** The loader covers the copy while modules
  load. Keep the loader under the `.ui` layer, or drop it and let the canvas fade in.
- **Blurred overlays over a live canvas.** `backdrop-filter` on a full-screen
  element above a rendering canvas re-blurs every frame; a phone pays a third of its
  frame budget for it. Cards may blur; full-screen overlays use a solid translucent
  fill. The same goes for per-element `shadowBlur` if you ever fall back to 2D canvas.
- **`THREE.sRGBEncoding is undefined`, `examples/jsm` 404.** Pre-r152 API or an
  unpinned import map. Pin r186 and use `three/addons/`.
- **It runs on your desktop GPU only.** You never opened the phone viewport.
