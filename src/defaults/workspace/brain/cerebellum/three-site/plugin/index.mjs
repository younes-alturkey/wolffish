// 3D Web Design — a core capability whose single tool loads the three.js site and
// scene manual into context. Model-led, like pdf_design and web_design: the core
// contract tells the agent to call `three_site_design` BEFORE authoring any 3D
// page, and this returns the manual plus the absolute paths of the two reference
// builds (read with read_file / skill_read_source; they are too large to inline).
//
// Paths resolve relative to this module's own URL so they work from the repo
// default folder and the dot-prefixed runtime folder alike.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const MANUAL_URL = new URL('../manual.md', import.meta.url)
const REFERENCES = [
  ['site-aura.html', 'scroll-driven 3D product site: hero object, five beats, instanced graph, backdrop shader'],
  ['scene-meridian.html', 'abstract interactive surface: one shader, pull + ripples, silk → crystal scroll morph']
].map(([file, what]) => ({ file, what, path: fileURLToPath(new URL(`../references/${file}`, import.meta.url)) }))

const toolDefinitions = [
  {
    name: 'three_site_design',
    description:
      'Load the full 3D web design manual into context. Call this BEFORE writing the HTML for any three.js / WebGL website, hero, scroll-driven 3D page, abstract shader scene, or interactive 3D experience. Returns the doctrine, the canonical boot, the scroll-beat and shader recipes, mobile and render budgets, the mandatory verify loop, the failure catalog, and the paths of two reference builds.',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'One line naming the 3D page or scene you are about to design.' }
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
      error: `three_site_design: could not read manual.md (${err instanceof Error ? err.message : String(err)})`
    }
  }
  const refs = REFERENCES.map((r) => `- ${r.path}\n  ${r.what}`).join('\n')
  return {
    success: true,
    output: `${manual.trimEnd()}\n\n---\n\n## Reference builds (read before adapting)\n\n${refs}\n`
  }
}

const plugin = {
  name: 'three-site',
  tools: toolDefinitions,
  async execute(toolName) {
    if (toolName === 'three_site_design') return loadManual()
    return { success: false, error: `three-site: unknown tool ${toolName}` }
  }
}

export default plugin
