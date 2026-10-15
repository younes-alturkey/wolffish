# The 3D Browser Game Manual

You are about to build a three.js game a person will play, on a phone as often as
on a desktop, and judge in the first thirty seconds. This manual is the difference
between a game and a cube that moves. Follow it for any three.js / WebGL game —
arcade loop, runner, shooter, puzzle, a campaign micro-game — unless the user already
specified the design. Sites, heroes and abstract scenes are `three_site_design`'s job.

**Precedence.** Explicit user or automation instructions win. Everything unspecified
follows this manual.

**The output is a three.js 3D game.** "One-thumb", "simple", "arcade", "dodge" or
"casual" describe the loop, not the renderer: a lane-dodger, a falling-block catcher,
a tap-to-jump runner are all 3D scenes with a chase or top-down camera. Build on a
2D canvas only when the user explicitly asks for 2D, and say so in the reply. The CDN
rule from the site manual applies: three.js comes from the pinned import map, and a
brief that says "self-contained" gets one sentence explaining why that is the only
external resource, not a 2D fallback.

**Where it comes from.** The loop contract, the build order and the scorecard come
from the most-starred three.js game skills (majidmanzarpour/threejs-game-skills,
PlayableIntelligence/threejs-game) and from what shipped games taught
(mshumer/Claude-of-Duty: pre-warm shaders, median fps hides stalls, one owner per
coupled system; Lacoste Ace Breaker: one verb, one loop, a tangible reward). The
reference build beside this manual, `references/game-drift.html`, is the proof.

---

## 1. The pipeline — exact steps, in order

1. **Design brief** (section 2). Five lines, before any code.
2. **Playable increment first.** One representative scene at the final camera scale
   with the verb, the objective and the pressure working — placeholder visuals are
   fine *here and only here*. Play it in the browser before expanding.
3. **Author one self-contained HTML file** with the pinned import map:
   ```html
   <script type="importmap">
   { "imports": {
     "three": "https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js",
     "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/"
   } }
   </script>
   ```
   three.js is the only external resource. Models, textures, sounds are procedural
   unless the user supplied assets.
4. **Polish in build order:** authored forms → materials → lighting and tone mapping →
   event-driven VFX → HUD → audio. Glow does not make primitives look premium.
5. **Verify — mandatory** (section 8): play it through in the browser, desktop and
   phone, read the console and the fps readout, screenshot active play.
6. **Deliver:** `send_file` the `.html`, say it must be opened in a browser (the in-app
   preview runs no scripts), say what you played and on which viewports.

## 2. The design brief and the core-loop contract

Write the brief in the reply before the code, five lines:

- **Player promise.** *"Hover down a neon canyon and survive as it speeds up."*
- **Primary verb.** One: steer / jump / shoot / tap. Map it to a key, a swipe and a tap.
- **What repeats every 5–30 s.** A row of gates; a wave; a hole. Name the reward.
- **Pressure.** What makes it harder and when: speed ramp, spawn density, a timer.
  Pressure must appear within the first minute; escalate every 20–60 s.
- **Lose and restart.** How you lose, what it costs, and a restart under one second
  with one tap.

The loop contract, proven in code: the **verb** maps to real input; the **objective**
is visible in the world or HUD; **pressure** arrives in the first minute; the
**reward** changes game state (score, combo, shield), not just pixels; **failure**
explains itself (flash, slow-motion, a toast) and restart is instant. A mechanic that
no input can trigger is a known failure.

## 3. Architecture — one file, deterministic, testable

```
state S          one plain object: running, over, paused, t, speed, lane/x, dist, score parts,
                 combo + comboT, shield, inv (invulnerability), shake, hit, slow, best, seed
simulate(dt)     fixed step 1/120 s via an accumulator; ALL game rules live here
render(dt)       poses, instance matrices, camera, HUD text, composer.render()
frame(now)       rAF; dt clamped to 0.1; skip when paused or document.hidden
input            intents, not devices: moveLane(±1) is called by keys, swipe and tap alike
pools            InstancedMesh per entity kind; inactive slots get a zero-scale matrix
spawn            rows at a fixed interval of distance, seeded RNG, always one free lane
collision        in game space (lane + z), never from the visual meshes
HUD              DOM, not sprites: score, combo, shield pips, speed bar, toast, flash
audio            Web Audio synthesized; AudioContext created on the first gesture
persistence      localStorage: best score, mute
```

- **Fixed timestep.** `acc += dt; while (acc >= STEP) { simulate(STEP); acc -= STEP; }`
  — collisions and spawns are then the same on a 30 fps phone and a 144 Hz monitor.
- **Seeded RNG.** `S.seed = (S.seed * 16807) % 2147483647` — a run is reproducible for
  QA; reseed from the clock on each start.
- **Pools, not allocation.** Hot paths allocate nothing: reuse `Matrix4`, `Vector3`,
  `Quaternion` scratch objects; hide an instance with a pre-built `makeScale(0,0,0)`.
- **The world moves, the player stays at z = 0.** Recycle track chunks and wall slabs
  by subtracting the track length when they pass the camera.
- **Difficulty from distance, not time**, so a pause does not spike it:
  `speed = min(max, base + dist * k)`.
- **Visibility.** `document.hidden` pauses; the start overlay unlocks audio.

## 4. The visual scorecard — reach 2 in every row before calling it done

| Category | 1 — not yet | 2 — shippable | 3 — premium |
|---|---|---|---|
| Art direction | theme is colours and fog | theme drives forms, materials, HUD, feedback | identity on every surface |
| Hero / player | a box with glow | authored silhouette (hull + wings + fins + engine), state cues, shadow blob | layered, expressive feedback |
| Obstacles | roles indistinguishable | role-specific forms, telegraphed, material cues | varied family with anticipation |
| Rewards | generic | authored form, readable while moving, HUD echo | value stays clear in motion |
| World | sparse repeats | layered kit: floor grid shader, canyon slabs, neon rails, stars | dense and readable |
| Materials | roughness sliders | shared roles: hull, neon, hazard, reward | cohesive language, measured |
| Lighting / render | fog + bloom as style | ACES tone mapping, exposure set, key + hemisphere, bloom only on desktop | cinematic yet readable |
| VFX / motion | generic trails | event-driven: pickup burst, hit burst, near-miss toast, exhaust with speed | effects that clarify play |
| UI / HUD | a stats dashboard | genre states: combo, pips, speed bar, start/over screens, mute | strong hierarchy, transitions |
| Performance evidence | "seems fine" | fps + calls readout, phone viewport shots, budget notes | baseline/post metrics, tradeoffs |

Banned on cost grounds, whatever the renderer: per-entity canvas `shadowBlur` or CSS
`filter: blur()` glows (use an emissive material and, on desktop, one bloom pass),
`backdrop-filter` on anything full-screen above the canvas, and allocating in the loop.

Render budgets (worst active-play view): draw calls ≤ 300 desktop / ≤ 150 phone;
triangles ≤ 750k / ≤ 300k; textures ≤ 60 / ≤ 40; shadow lights ≤ 2 / 1 (the reference
uses none and a shadow blob); shadow map ≤ 2048 / ≤ 1024; DPR cap 2 / 1.5; post passes
beyond render + output ≤ 1 / 0. The reference runs at 60 fps with under 20 draw calls.

## 5. The game-feel kit — all event-driven

- **Hit:** shield pip off, `inv = 1.4 s` with a blink (`visible` toggled at 18 Hz),
  `slow = 0.35` easing back to 1 (slow-motion), `shake = 0.9` decaying, a full-screen
  flash div in the hazard colour via `mix-blend-mode: screen`, noise burst audio,
  40 sparks, floor grid tints to the hazard colour for a moment, combo resets.
- **Pickup:** 14 sparks, a rising sine blip whose pitch climbs with combo, combo and
  score change in the same frame, a toast on milestones.
- **Near miss:** +score and a toast when an obstacle passes in the adjacent lane —
  the cheapest way to make skill visible.
- **Steering:** the ship banks into the lane change (`rotation.z` from the lateral
  error), the lane change eases (`x += (target - x) * min(1, dt * 12)`).
- **Speed:** FOV widens with speed, the exhaust cone lengthens, the engine oscillator's
  pitch and filter rise. Keep bloom off the ship hull (a darker hull colour, a
  threshold ≥ .8) so the silhouette survives.
- **Game over:** the crash sound, a long shake, the overlay 500 ms later with the
  score large, the best in the accent colour, one sentence that knows what happened,
  one restart button. **Start:** one pulsing button, the controls listed with `<kbd>`.
  Both overlays are a **solid translucent fill** (`rgba(bg, .72)`), never
  `backdrop-filter: blur` over the live canvas — the blur re-renders every frame and
  took a tested game from 60 to 20 fps on its own game-over card.
- **Camera:** chase from behind and above, lagging the lateral position by half, with
  a small random shake while `shake > 0`.

Audio is synthesized: a sawtooth engine through a low-pass filter whose frequency
follows speed; blips from oscillators with exponential ramps; a crash from a noise
buffer with a squared fade. Create the `AudioContext` inside the start handler, keep
a mute toggle with the state in `localStorage`.

## 6. Input — intents first

- Keyboard: arrows and WASD, `P` pause, Enter/Space start. Ignore `e.repeat`.
- Touch and mouse through **pointer events** on the canvas with `touch-action: none`
  and `setPointerCapture`: a horizontal drag moves one lane per `min(90px, 16vw)`; a
  tap without movement steers toward the tapped half of the screen.
- Every intent plays the same tiny feedback blip, so a phone player hears the input
  land even when the thumb covers the ship.
- Never read device tilt without a user-initiated permission flow; do not rely on
  hover; do not put controls under the thumb's resting area (bottom corners are for
  the mute button and nothing else).

## 7. Phones — the real target

- Sizing: visual-viewport boot, as in the site manual — `VW()/VH()` from
  `visualViewport`, `renderer.setSize(VW(), VH(), true)`, the canvas translated by
  `visualViewport.offsetLeft/Top` on scroll and resize. `user-scalable=no`,
  `viewport-fit=cover`, `overscroll-behavior: none`, HUD padded by
  `env(safe-area-inset-*)`.
- **Portrait camera rule:** when `VW() < VH()`, sit higher and further back and widen
  the *vertical* FOV so three lanes and the next two rows fit:
  `position (x·.55, 5.2, 10.5)`, `lookAt (x·.3, .6, -16)`, `fov 78` — versus
  `(x·.55, 3.4, 7.5)`, `(x·.3, .6, -8)`, `fov 70` in landscape. Re-evaluate on resize.
- Tier: DPR 1.5, no bloom, `antialias: false`, star count halved, in one `TIER` object.
- Touch targets ≥ 44 px; the start button ≥ 56 px tall; HUD text ≥ 12 px mono.
- Phones load the modules in seconds; the start overlay is the loader.

## 8. Verify before delivering — mandatory

You never deliver a game you have not played. Drive it with the browser capability:

1. `browser_launch` headless (1280 × 900) → `browser_navigate` to the file → wait for
   the start screen → `browser_screenshot` → `image_view`.
2. Console: zero errors. Then click Start (`browser_click` on the button), wait 3 s,
   screenshot active play, `image_view`: the player silhouette must read, obstacles
   and rewards must be distinguishable at a glance.
3. Press the steering keys (`browser_press`), screenshot, confirm the lane changed
   and the score climbed (`browser_evaluate` on the HUD text).
4. **Bot playtest:** do not steer for 30 s. The run must take hits, lose pips, and
   reach game over with the final score and best shown; "Run again" must restart in
   under a second. If no hit ever lands, the spawner is too kind or collision is off.
5. Phone viewport (390 × 844, coarse pointer): start, drag across the canvas to
   change lane, screenshot portrait framing (three lanes visible, ship in the lower
   third, not crowding the bottom), game over and restart.
6. Read the fps / draw-call evidence (`renderer.info.render.calls` exposed in a
   footer or via evaluate) against section 4's budgets at the busiest moment. Measure,
   do not assume: count `requestAnimationFrame` ticks over two seconds via
   `browser_evaluate` **during play and again on the game-over card** — the overlay is
   where blur and glow costs hide, and a check that only covers the start screen will
   report 60 fps for a game that plays at 30.
7. Only then `send_file`, naming what you played and measured.

Median fps hides stalls: if the first obstacle of a kind stutters, compile its
material up front (render one hidden instance on the start screen).

## 9. Failure catalog

- **Nothing happens on a phone.** Mouse events instead of pointer events, or the
  canvas lacks `touch-action: none` so the page scrolls instead.
- **Ship is a glowing blob.** Hull too bright under bloom; exhaust cone too long.
  Darken the hull, threshold ≥ .8, exhaust ≤ 1.3 units.
- **Portrait shows one lane.** Landscape camera on a tall viewport. Portrait rule.
- **Collisions feel random.** They are read from mesh positions after easing, or dt is
  variable. Collide in game space inside the fixed step.
- **Difficulty jumps after a pause.** Speed from elapsed time. Use distance.
- **Audio silent on iOS.** `AudioContext` created outside a gesture; create it in the
  start handler, `resume()` on later starts.
- **Instances flicker or pile up.** Hidden slots not zero-scaled; `instanceMatrix.
  needsUpdate` set per instance instead of once per frame.
- **Garbage-collection hitches.** `new Vector3()` in the loop. Scratch objects.
- **It only runs on your desktop GPU.** You never opened the phone viewport.
- **The verify loop reported 60 fps for a 30 fps game.** It measured the start
  screen, not play or game over. Measure both, with rAF counts.
- **A 2D canvas shipped for a 3D brief.** The brief's "simple" was read as "2D", or
  the CDN rule was read as a ban on three.js. Neither is; see the top of this manual.
