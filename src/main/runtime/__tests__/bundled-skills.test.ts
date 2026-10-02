/**
 * Every bundled capability's SKILL.md must parse, and parse to its own
 * folder name. A frontmatter that js-yaml rejects (the 2026-09-21 case: an
 * unquoted `description:` scalar that grew a ": " inside it) makes the
 * cerebellum register the folder under its dot-name with status "error" —
 * the capability silently vanishes from the index and every one of its
 * tools becomes "unknown tool". That is how shell_exec disappeared on a
 * machine that had the shell capability installed.
 *
 * Run: npx tsx src/main/runtime/__tests__/bundled-skills.test.ts
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { parseSkillMd } from '../capabilityImport'

async function main(): Promise<void> {
  // Run from the repo root, like every other test here.
  const root = path.resolve(process.cwd(), 'src/defaults/workspace/brain/cerebellum')
  const entries = await fs.readdir(root, { withFileTypes: true })
  let checked = 0
  const failures: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const skillPath = path.join(root, entry.name, 'SKILL.md')
    let raw: string
    try {
      raw = await fs.readFile(skillPath, 'utf8')
    } catch {
      continue
    }
    checked++
    try {
      const { frontmatter } = parseSkillMd(raw)
      if (!frontmatter?.name) failures.push(`${entry.name}: frontmatter has no name`)
      else if (frontmatter.name !== entry.name)
        failures.push(`${entry.name}: frontmatter name is "${frontmatter.name}"`)
      for (const tool of frontmatter?.tools ?? []) {
        if (!tool || typeof tool.name !== 'string' || !tool.name)
          failures.push(`${entry.name}: a tool entry has no name`)
      }
    } catch (err) {
      failures.push(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (checked === 0) failures.push('no bundled SKILL.md found — wrong root?')
  for (const f of failures) console.error(`FAIL ${f}`)
  console.log(`bundled skills: ${checked} checked, ${failures.length} failed`)
  process.exit(failures.length ? 1 : 0)
}

void main()
