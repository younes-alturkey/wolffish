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

The five lines above are phrased for a runner; map them to the genre instead of
forcing the genre into them. A versus fighter: the verb is the attack string, the
repeating unit is the round, the reward is the combo counter and the meter, the
pressure is the timer and the CPU's escalation, failure is the KO. A top-down shooter:
the wave, the multiplier, the spawn density. Whatever the genre, **one button held or
mashed must not be a winning strategy** — section 5a says how, section 8 tests it.

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
- **The state literal is complete, and NaN is a loud error.** Every field that
  `simulate`, `render` or the camera update reads is declared in the `S` literal with
  a numeric default; `S.camX += …` on an undeclared field is NaN by the second frame
  and NaN geometry still issues draw calls, so fps and draw-call readouts stay green
  while the player sees nothing. Three layers, all three required:
  1. **Declare** — no field is created by `+=`, `*=` or `lerp` on first use.
  2. **Assert** — at the end of `render`, once per second:
     `for (const k in S) if (typeof S[k] === 'number' && !Number.isFinite(S[k]))
     console.error('S.' + k + ' is ' + S[k]);` and the same for
     `camera.position` and `camera.projectionMatrix.elements`. A NaN then fails the
     mandatory "zero console errors" check even when no screenshot is taken.
  3. **Self-heal** — the camera update guards its inputs:
     `if (!Number.isFinite(S.camX)) S.camX = mid;` so a slip that gets through
     still shows the player the game instead of a gradient.
- **Every state has a timer and an exit, in one place.** Model each actor as an
  explicit state machine (for a versus game `idle | walk | block | attack | hit |
  down | ko | win`; for a runner `run | hit | over`; for a shooter `alive | hit |
  respawn | over`), where every non-idle state carries the timer that ends it and the transition
  back is written next to the timer, in `simulate`, not scattered across hit
  resolution, input handling and rendering. A timer that reaches zero without a
  transition is a stuck actor: the second Wolffish fighter decremented `stun` to
  zero but nothing ever set `state = 'idle'` again, so the first hit the CPU landed
  locked the player out for the rest of the round while fps, draw calls and the
  console stayed green. Add the watchdog to the per-second assertion: an actor in
  any hurt, guard or downed state (`hit`, `block`, `down`, `respawn`) longer than
  `2 × its longest stun` with no new hit is a `console.error`, and `simulate` forces
  it back to the actionable state.
- **The world moves, the player stays at z = 0** (track and runner games). Recycle
  track chunks and wall slabs by subtracting the track length when they pass the camera.
- **Difficulty from distance, not time**, so a pause does not spike it:
  `speed = min(max, base + dist * k)`.
- **Visibility.** `document.hidden` pauses; the start overlay unlocks audio.
- **Genre.** The block above is the runner's. Every game keeps `state / simulate /
  render / frame / input / pools / HUD / audio / persistence`; a versus, arena or board
  game replaces the track with its own play volume (two actors on a line, a ring, a
  grid) and keeps collision in game space inside the fixed step.

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
A single 1024 shadow map on the phone tier is affordable when the scene is under
~100 calls and it costs about one extra call per caster; prefer it over blobs for
characters whose feet must read as grounded (a fighter, a brawler), blobs for
anything fast or numerous.

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
- **Overlays never leak input.** A hidden screen is `pointer-events: none` for itself
  **and its descendants**: `.screen.hide, .screen.hide * { pointer-events: none }`.
  A `.btn` or `.card` rule that sets `pointer-events: auto` re-enables a hidden
  button, and because later screens sit above earlier ones in the DOM, the invisible
  REMATCH or character card then swallows the tap meant for START. Both the baseline
  fighter and the first Wolffish fighter shipped exactly this.
- **Chrome belongs to the match.** HUD (bars, timer, round pips), the touch pad and
  the hint are hidden on the title, select and result screens and appear with the
  first round. The title screen carries only its own copy and one start control.
- **Music bed.** A brief that asks for immersion gets a synthesized loop (a kick and
  a bass line at a fixed BPM is enough, scheduled with a look-ahead timer), ducked
  on the KO card, under the same mute toggle, and one world element that pulses to
  the beat (lanterns, floor emissive, a ring).
- **Block economy (any game with a guard).** Blocking must be strictly better than
  being hit: chip ≤ 15 % of the move's damage, floored at 1 HP, never a KO, and a
  guarded hit pushes the attacker back further than a landed one.

### 5a. Challenge — one input must not win

A game whose default opponent loses to one held direction and one mashed button is
not a game; the first Wolffish fighter measured exactly that at its default level
(CPU from 1000 HP to 52 in twenty seconds). Build the counter-play in, with numbers,
whatever the genre:

- **Repeating one input costs something.** The repeated input is at a disadvantage
  on success unless it is deliberately chained: a recovery the opponent can act in,
  a cooldown, recoil, heat, a shrinking reward. For a versus game, the frame rule:
  for every light attack, `startup + active + recovery ≥ hitstun it causes + 0.05 s`,
  so the defender recovers first unless the attacker *chains*, and repeating one
  button is minus on hit, not plus. Only a connected hit can chain, a string is at
  most three hits, and the third ends in a knockdown or a recovery ≥ 0.4 s that the
  opponent can punish.
- **Rewards shrink with repetition.** The Nth repeat is worth less than the first and
  pushes the player out of the position that made it work. For a versus game:
  knockback grows per consecutive hit so the third hit of a string leaves the
  attacker outside light range; damage scales down ≥ 10 % per hit in a combo;
  hitstun shrinks by the same factor.
- **The opponent reads the pattern.** At every level, the same input succeeding twice
  within 1.5 s changes what the opponent does next. For a versus game: the CPU
  blocks that button's next use with ≥ 70 % probability and answers during the
  recovery with its own string; after two guarded hits it counters; a heavy it has
  already started is not interrupted by a light (super armor on the first 40 % of
  the heavy's startup), so the masher trades and loses the trade. For a runner or
  shooter: the spawner stops feeding the lane or position the player has camped in.
- **Default level.** The first round, wave or minute runs at the level that beats the
  mash bot and loses to the patient bot (section 8): a first-time player who defends
  and answers wins it; a player who holds forward and taps does not. Escalate per
  round or wave or offer a picker, never start at the level that is only there for
  onboarding.
- **Misses are punished.** An action that connects with nothing has its full recovery
  and no chain; for a versus game the CPU attacks into a whiffed heavy within its
  reaction time, for a shooter a missed volley costs the multiplier or heat.

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
- **The touch tier is live, not a boot constant.** `pointer: coarse` at load is a
  hint. Show the pad on the first `pointerdown` whose `pointerType` is `touch`, hide
  it on the first mouse pointer, and re-run the tier decision on `resize` and
  `orientationchange`. A tier read once is wrong for a laptop with a touchscreen and
  for a page rotated or resized after load. Pad targets ≥ 44 px, the move buttons
  ≥ 60 px.

## 7. Phones — the real target

- Sizing: visual-viewport boot, as in the site manual — `VW()/VH()` from
  `visualViewport`, `renderer.setSize(VW(), VH(), true)`, the canvas translated by
  `visualViewport.offsetLeft/Top` on scroll and resize. `user-scalable=no`,
  `viewport-fit=cover`, `overscroll-behavior: none`, HUD padded by
  `env(safe-area-inset-*)`.
- **Framing rule.** Frame the play volume, not a fixed position: compute the camera
  distance from the bounding extent of what must stay on screen (the lanes and the
  next rows; both fighters plus a margin; the board) and the *horizontal* FOV
  derived from aspect, with a portrait variant that widens the vertical FOV and sits
  higher. Re-evaluate on resize. Two worked examples:
  - **Runner, portrait** (`VW() < VH()`): three lanes and the next two rows fit with
    `position (x·.55, 5.2, 10.5)`, `lookAt (x·.3, .6, -16)`, `fov 78` — versus
    `(x·.55, 3.4, 7.5)`, `(x·.3, .6, -8)`, `fov 70` in landscape.
  - **Versus fighter:** side camera at the midpoint, `dist = (sep/2 + margin) /
    tan(hFov/2)` clamped, margin ≈ 1.5 in portrait and 2.6 in landscape, vertical
    fov ≈ 64 portrait / 46 landscape, target height ≈ 1.1; the KO camera moves in
    to ~60 % of that distance.
- Tier: DPR 1.5, no bloom, `antialias: false`, star count halved, in one `TIER` object.
- Touch targets ≥ 44 px; the start button ≥ 56 px tall; HUD text ≥ 12 px mono.
- Phones load the modules in seconds; the start overlay is the loader.

## 8. Verify before delivering — mandatory

You never deliver a game you have not played. Drive it with the browser capability:

1. `browser_launch` headless (1280 × 900) → `browser_navigate` to the file → wait for
   the start screen → `browser_screenshot` → `image_view`.
2. Console: zero errors. Then click Start **through the hit-test**: evaluate
   `document.elementFromPoint(cx, cy)` at the button's centre and require it to be
   that button (a hidden screen's child on top is a shipped bug, see section 5),
   then click by screen coordinates, not by dispatching on the element — a finger
   goes through the same hit-test. Wait 3 s, screenshot active play, `image_view`:
   the player silhouette must read, obstacles and rewards must be distinguishable at
   a glance, and the title/select screenshots must show no HUD, pad or hint.
3. Press the movement keys (`browser_press`), screenshot, confirm the actor moved
   (for a runner, the lane changed) and the HUD changed with it (`browser_evaluate`
   on the HUD text).
4. **Bot playtests, four of them, at the default level** (the wording below says
   "hit", "attack" and "round"; read it as the game's own verb, damage and unit —
   wave, lap, minute):
   - *Idle bot:* no input for 30 s. The run must take hits, lose pips, and reach game
     over with the final score and best shown; "Run again" must restart in under a
     second. If no hit ever lands, the spawner is too kind or collision is off.
   - *Mash bot:* hold forward (or the one verb) and tap the light attack at 8 Hz for
     20 s via `browser_evaluate` on the input layer. The bot must lose more HP than
     it deals and must not win the round; if it does, apply section 5a and re-test.
   - *Patient bot:* defend against the opponent's first attack (block, dodge, sidestep),
     then answer during its recovery — for a versus game one three-hit string —
     and repeat. It must win the first round at the default level. Report every bot's
     HP or score outcome in the reply, as numbers.
   - *Control-recovery bot:* stand still until the opponent lands one hit, then hold
     forward and press the primary action. The actor must move within its stun
     (for a versus game the move's hitstun) + 0.1 s and the action must start within
     0.5 s. Bot results are only valid if this passes: a masher that "loses" because
     it is stuck in `hit` after the first exchange proves nothing about the opponent.
5. Phone viewport (390 × 844, coarse pointer): start, drag or tap the canvas and the
   pad (for a runner, to change lane), screenshot portrait framing (for a runner
   three lanes visible and the ship in the lower third, not crowding the bottom; for
   a versus game both actors with margin and the pad clear of them), game over and
   restart.
6. Read the fps / draw-call evidence (`renderer.info.render.calls` exposed in a
   footer or via evaluate) against section 4's budgets at the busiest moment. Measure,
   do not assume: count `requestAnimationFrame` ticks over two seconds via
   `browser_evaluate` **during play and again on the game-over card** — the overlay is
   where blur and glow costs hide, and a check that only covers the start screen will
   report 60 fps for a game that plays at 30.
7. **Verify the file you ship, not an earlier one.** Every code edit after a
   screenshot invalidates that screenshot. After the last edit, reload and retake
   the active-play screenshot on desktop and phone and `image_view` both; a numeric
   bot re-run alone does not count — the second Wolffish fighter shipped a black
   arena (an uninitialised camera x became NaN) because only the bot numbers were
   re-checked after the final edit, while the bots, fps and draw calls all read fine.
8. **Black-frame guard, programmatic.** During play, `browser_evaluate`: wait one
   `requestAnimationFrame`, `drawImage` the WebGL canvas into a 32×32 2D canvas,
   compute the standard deviation of pixel luminance, and require it above 12; also
   assert `Number.isFinite` on the camera's position and projection matrix (expose
   both on the debug object next to fps and calls). A frame that is only the
   background gradient fails this test even when the renderer reports 60 fps and
   88 draw calls, because NaN geometry still issues draw calls.
9. Only then `send_file`, naming what you played and measured.

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
- **The start button does nothing on a phone.** A hidden screen's button or card
  keeps `pointer-events: auto` and sits above the visible one. Hit-test before you
  click (section 8) and blanket-disable hidden descendants (section 5).
- **Mashing wins.** Light attacks are plus on hit, strings never end, the CPU never
  blocks a repeated button, round 1 runs at the onboarding level. Section 5a.
- **The HUD is on the title screen.** Bars, timer and pad render before any match.
  Chrome appears with the first round.
- **The pad never appears.** Touch tier computed once at load; see section 6.
- **One hit and the player is frozen for the round.** The stun timer counts down
  but no code path returns the state to `idle`; `canAct()` keeps saying no. Put the
  exit next to the timer in `simulate`, run the watchdog, run the control-recovery
  bot (sections 3 and 8).
- **The arena is black but fps and draw calls look fine.** A state field the camera
  reads was never initialised (`S.camX += …` on `undefined`), so the camera position
  is NaN and every draw call renders nothing. The second Wolffish fighter shipped
  this after a late edit that was re-checked with bot numbers only. Section 3's
  declare / assert / self-heal rule makes it a console error and a non-event for the
  player; section 8's final-file screenshot and black-frame guard catch what is left.
