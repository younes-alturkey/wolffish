---
name: three-game
description: "The 3D browser game manual. Call three_game_design BEFORE building any three.js / WebGL game, arcade loop, runner, shooter, puzzle, or playable campaign piece — it is what makes games come out playable and polished instead of a cube that moves."
triggers:
  - three.js game
  - threejs game
  - 3d game
  - webgl game
  - browser game
  - html5 game
  - arcade game
  - runner game
  - endless runner
  - shooter
  - playable
  - mini game
  - micro-game
  - game loop
  - game feel
  - mobile game
tools:
  - name: three_game_design
    readOnly: true
    description: "Load the full 3D browser game manual into context. Call this BEFORE writing any three.js / WebGL game. Returns the complete system — the core-loop contract (verb, objective, pressure, reward, cost), the design brief, the canonical single-file architecture (fixed-timestep simulation, input intents for keys and touch, pooled InstancedMesh entities, recycled track chunks, DOM HUD, synthesized Web Audio unlocked on first gesture, persisted best score), the game-feel kit, the visual scorecard and render budgets, portrait-phone rules, the mandatory play-through verify loop, the failure catalog, and the path of a reference build you can read and adapt. Skip only when the user fully specifies the design (explicit instructions always win over the manual)."
    parameters:
      game:
        type: string
        required: false
        description: "One line naming the game you are about to build — stating it commits you to following the manual."
---

# 3D Browser Games (three.js)

A core capability. Its one tool, `three_game_design`, returns the game manual: the
core-loop contract and design brief borrowed from the most-starred three.js game
skills, the single-file architecture that keeps a game deterministic and testable
(fixed timestep, input intents, pooled instances, seeded randomness), the game-feel
kit (hitstop, slow-motion, shake, flash, banking, FOV with speed, event-driven
sparks, synthesized audio), the ten-category visual scorecard and render budgets,
portrait-phone framing and touch rules, the mandatory play-through verify loop, and
a failure catalog.

One reference build lives beside the manual and is the proof of the system — read
it before adapting:

- `references/game-drift.html` — DRIFT, a hover-canyon lane runner: three lanes,
  gates and cores spawned per row with one lane always free, combo multiplier, near
  misses, three shields with invulnerability blink, slow-motion hits, game over and
  one-tap restart, best score in localStorage, keyboard + swipe + tap steering,
  portrait camera, synthesized engine and effects, bloom on desktop only.

Websites, heroes and abstract scenes are a different discipline — the `three-site`
capability owns those.
