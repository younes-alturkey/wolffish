// PDF Design — a core capability whose single tool loads the document design
// manual into context. Model-led: the core contract instructs the agent to
// call `pdf_design` BEFORE authoring any PDF/report/styled document; this
// returns it. Mirrors the body-load pattern used by the other core manuals.
//
// The manual text lives in ../manual.md and the tested palettes in
// ../themes.md (single sources of truth, also readable via
// skill_read_source). We read them relative to this module's own URL so they
// resolve whether the skill runs from the repo default or the dot-prefixed
// runtime folder (~/.wolffish/.../.pdf-design/).
//
// Both are returned together, every call. A theme is only useful with its
// exact token values: hand back the manual alone and the agent picks a
// palette from memory, which is how untested colour lands in a document.

import { readFile } from 'node:fs/promises'

const MANUAL_URL = new URL('../manual.md', import.meta.url)
const THEMES_URL = new URL('../themes.md', import.meta.url)

const toolDefinitions = [
  {
    name: 'pdf_design',
    description:
      'Load the full document design manual and the tested theme palettes into context. Call this BEFORE writing the HTML for any PDF or styled document a person will read. Returns the complete design system to author by — sheet architecture, the fit audit, the component kit, and eight contrast-tested colour themes with their exact tokens.',
    parameters: {
      type: 'object',
      properties: {
        document: {
          type: 'string',
          description: 'One line naming the document you are about to design.'
        }
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
      error: `pdf_design: could not read manual.md (${err instanceof Error ? err.message : String(err)})`
    }
  }

  // The themes file is additive: if it is somehow missing the manual is still
  // worth having, so fall back to a pointer rather than failing the call.
  let themes
  try {
    themes = await readFile(THEMES_URL, 'utf8')
  } catch {
    themes =
      '# Document Themes\n\nthemes.md could not be read. Use the Steel tokens in section 4.2 ' +
      'of the manual and do not invent a palette from memory.'
  }

  return { success: true, output: `${manual.trimEnd()}\n\n---\n\n${themes.trimStart()}` }
}

const plugin = {
  name: 'pdf-design',
  tools: toolDefinitions,
  async execute(toolName) {
    if (toolName === 'pdf_design') return loadManual()
    return { success: false, error: `pdf-design: unknown tool ${toolName}` }
  }
}

export default plugin
