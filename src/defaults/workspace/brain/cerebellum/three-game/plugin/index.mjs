// 3D Browser Games — a core capability whose single tool loads the three.js game
// manual into context. Model-led, like pdf_design and three_site_design: the core
// contract tells the agent to call `three_game_design` BEFORE building any game,
// and this returns the manual plus the absolute path of the reference build (read
// it with read_file / skill_read_source; it is too large to inline).

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const MANUAL_URL = new URL('../manual.md', import.meta.url)
const REFERENCE = fileURLToPath(new URL('../references/game-drift.html', import.meta.url))

const toolDefinitions = [
  {
    name: 'three_game_design',
    description:
      'Load the full 3D browser game manual into context. Call this BEFORE writing any three.js / WebGL game. Returns the core-loop contract, the design brief, the canonical fixed-timestep architecture with pooled instances and touch input, the game-feel kit, the visual scorecard and render budgets, portrait-phone rules, the mandatory play-through verify loop, the failure catalog, and the path of a reference build.',
    parameters: {
      type: 'object',
      properties: {
        game: { type: 'string', description: 'One line naming the game you are about to build.' }
      }
    }
  }
]

async function loadManual() {
  let manual
  try {
    manual = await readFile(MANUAL_URL, 'utf8')
  } catch (err) {
    return {
      success: false,
      error: `three_game_design: could not read manual.md (${err instanceof Error ? err.message : String(err)})`
    }
  }
  return {
    success: true,
    output: `${manual.trimEnd()}\n\n---\n\n## Reference build (read before adapting)\n\n- ${REFERENCE}\n  DRIFT: lane runner with gates, cores, combo, shields, slow-mo hits, swipe + keys, portrait camera, synthesized audio\n`
  }
}

const plugin = {
  name: 'three-game',
  tools: toolDefinitions,
  async execute(toolName) {
    if (toolName === 'three_game_design') return loadManual()
    return { success: false, error: `three-game: unknown tool ${toolName}` }
  }
}

export default plugin
