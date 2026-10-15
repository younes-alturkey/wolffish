---
name: three-site
description: "The 3D web design manual. Call three_site_design BEFORE authoring any three.js website, hero, scroll-driven 3D page, WebGL scene, shader piece, or interactive 3D web experience — it is what makes them come out award-grade instead of a spinning cube."
triggers:
  - three.js
  - threejs
  - 3d website
  - 3d web
  - webgl
  - webgl site
  - 3d hero
  - 3d landing
  - scroll-driven 3d
  - shader
  - glsl
  - 3d scene
  - abstract scene
  - interactive 3d
  - web3 site
  - immersive site
  - awwwards
tools:
  - name: three_site_design
    readOnly: true
    description: "Load the full 3D web design manual into context. Call this BEFORE writing the HTML for any three.js / WebGL website, hero section, scroll-driven 3D page, abstract shader scene, or interactive 3D experience a person will open in a browser. Returns the complete system — the one-hard-idea doctrine, the beat map for scroll-driven 3D, the canonical single-file boot (pinned three.js import map, visual-viewport sizing, device tiers, post-processing rules), the shader-scene recipe, mobile and performance budgets, the mandatory screenshot + console + fps verify loop, the failure catalog, and the paths of two reference builds you can read and adapt. Skip only when the user fully specifies the design (explicit instructions always win over the manual)."
    parameters:
      page:
        type: string
        required: false
        description: "One line naming the 3D page or scene you are about to design — stating it commits you to following the manual."
---

# 3D Web Design (three.js sites and scenes)

A core capability. Its one tool, `three_site_design`, returns the 3D web design
manual: the planning doctrine distilled from award-winning three.js sites (one hard
idea, sell one object, scroll as the narrative device, restraint over effect
stacking, HTML first, mid-range phones as the real target), the canonical
single-file boot for three.js r186 (pinned import map, visual-viewport sizing,
device tiers, environment lighting, post-processing only where the budget allows),
the scroll-beat choreography pattern, the full-viewport shader and abstract-surface
recipes, the mobile and render budgets, the mandatory browser verify loop, and a
failure catalog.

Two reference builds live beside the manual in `references/` and are the proof of
the system — read them before adapting:

- `references/site-aura.html` — a scroll-driven 3D product site: one hero object
  (core, lattice, satellites) choreographed through five beats, an instanced
  network graph, a full-viewport backdrop shader, bloom on desktop only, text
  scrims, counters and reveals, drag with inertia.
- `references/scene-meridian.html` — an abstract interactive surface: one
  ShaderMaterial with simplex displacement, pointer pull, tap ripples, scroll morph
  from silk to faceted crystal via derivative normals, a dust field, kinetic type.

Games are a different discipline — the `three-game` capability owns those. The
plain `web_design` manual still owns pages with no 3D in them.
