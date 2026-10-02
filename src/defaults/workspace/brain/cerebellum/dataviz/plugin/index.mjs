// Dataviz — a core capability whose single tool loads the data visualization
// manual into context. Model-led: the core contract instructs the agent to
// call `dataviz` BEFORE creating any chart or data display; this returns it.
// Mirrors the body-load pattern used by the other core manuals.
//
// The manual text lives in ../manual.md (single source of truth, also
// readable via skill_read_source). We read it relative to this module's own
// URL so it resolves whether the skill runs from the repo default or the
// dot-prefixed runtime folder (~/.wolffish/.../.dataviz/).

import { readFile } from 'node:fs/promises'

const MANUAL_URL = new URL('../manual.md', import.meta.url)

const toolDefinitions = [
  {
    name: 'dataviz',
    description:
      'Load the full data visualization manual into context. Call this BEFORE creating any chart, graph, or data display — in-app chart cards (.chart.json), SVG charts inside documents, or channel table fallbacks. Returns the system to visualize by.',
    parameters: {
      type: 'object',
      properties: {
        data: {
          type: 'string',
          description: 'One line naming the data you are about to visualize.'
        }
      }
    }
  }
]

async function loadManual() {
  try {
    const text = await readFile(MANUAL_URL, 'utf8')
    return { success: true, output: text }
  } catch (err) {
    return {
      success: false,
      error: `dataviz: could not read manual.md (${err instanceof Error ? err.message : String(err)})`
    }
  }
}

const plugin = {
  name: 'dataviz',
  tools: toolDefinitions,
  async execute(toolName) {
    if (toolName === 'dataviz') return loadManual()
    return { success: false, error: `dataviz: unknown tool ${toolName}` }
  }
}

export default plugin
