// Web Design — a core capability whose single tool loads the web design
// manual into context. Model-led: the core contract instructs the agent to
// call `web_design` BEFORE authoring any HTML page/site a person will open
// in a browser; this returns it. Mirrors the body-load pattern of the other
// core manuals (and pdf-design, its print sibling).
//
// The manual text lives in ../manual.md (single source of truth, also
// readable via skill_read_source). We read it relative to this module's own
// URL so it resolves whether the skill runs from the repo default or the
// dot-prefixed runtime folder (~/.wolffish/.../.web-design/).

import { readFile } from 'node:fs/promises'

const MANUAL_URL = new URL('../manual.md', import.meta.url)

const toolDefinitions = [
  {
    name: 'web_design',
    description:
      'Load the full web design manual into context. Call this BEFORE writing the HTML for any web page or site a person will open in a browser. Returns the complete design system to author by.',
    parameters: {
      type: 'object',
      properties: {
        page: {
          type: 'string',
          description: 'One line naming the page you are about to design.'
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
      error: `web_design: could not read manual.md (${err instanceof Error ? err.message : String(err)})`
    }
  }
}

const plugin = {
  name: 'web-design',
  tools: toolDefinitions,
  async execute(toolName) {
    if (toolName === 'web_design') return loadManual()
    return { success: false, error: `web-design: unknown tool ${toolName}` }
  }
}

export default plugin
