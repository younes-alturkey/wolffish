/**
 * KnowledgeStore — the amend path over Wolffish's own long-term beliefs.
 *
 * These files are read into (or keyed into) EVERY system prompt, and the model
 * now writes them mid-conversation. That makes this the highest-consequence
 * write surface in the app: a bad edit corrupts what the agent believes about
 * the user, silently, on every future turn. So the guards are pinned here
 * rather than left to the prompt —
 *
 *   - the nine-file allowlist (no app-owned file, no traversal)
 *   - unique-match or refuse: never guess WHICH belief was meant
 *   - forget removes whole entries, prunes emptied topics, and cannot blank a file
 *   - the playbook's five sections, provenance stamp and character ceiling
 *   - `.bak` on every write, and restore as a reversible swap
 *   - the memory-map invalidation fires on heading changes and ONLY then
 *     (it costs a prompt-cache break)
 *
 * Run: npx tsx --tsconfig tsconfig.node.json src/main/runtime/__tests__/knowledge-store.test.ts
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hippocampus } from '../hippocampus'
import {
  KNOWLEDGE_TARGETS,
  KnowledgeStore,
  isKnowledgeTarget,
  type KnowledgeResult
} from '../knowledge'

let passed = 0
let failed = 0

function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

/** A throwaway workspace — nothing here ever touches ~/.wolffish. */
async function makeWorkspace(): Promise<{ root: string; topicBumps: () => number }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wolffish-knowledge-'))
  for (const dir of [
    'brain/reflection',
    'brain/prefrontal',
    'brain/identity',
    'brain/hippocampus/knowledge'
  ]) {
    await fs.mkdir(path.join(root, dir), { recursive: true })
  }
  return { root, topicBumps: () => 0 }
}

function storeFor(root: string): { store: KnowledgeStore; bumps: () => number } {
  let bumps = 0
  const store = new KnowledgeStore({
    workspaceRoot: root,
    onKnowledgeTopicsChanged: () => {
      bumps += 1
    }
  })
  return { store, bumps: () => bumps }
}

const read = (root: string, rel: string): Promise<string> =>
  fs.readFile(path.join(root, rel), 'utf8').catch(() => '')

const write = (root: string, rel: string, body: string): Promise<void> =>
  fs.writeFile(path.join(root, rel), body, 'utf8')

const KNOWLEDGE_REL = 'brain/hippocampus/knowledge'
const PLAYBOOK_REL = 'brain/reflection/playbook.md'

function err(r: KnowledgeResult): string {
  return r.ok ? '(succeeded)' : r.error
}

async function main(): Promise<void> {
  // ── The allowlist is the perimeter ──────────────────────────────────
  {
    ok(
      'the nine editable targets are exactly the intended set',
      KNOWLEDGE_TARGETS.join(',') ===
        'playbook,instructions,soul,user,projects,people,preferences,technical,decisions',
      KNOWLEDGE_TARGETS.join(',')
    )
    // agents.core.md and the workflow role files are rewritten by workspace.ts
    // on every launch — editable-looking but not editable, so they must not be
    // reachable at all rather than accept a write that evaporates on restart.
    for (const bad of [
      'agents.core',
      'agents-core',
      'workflow',
      '../config',
      'brain/identity/soul.md',
      '',
      'Playbook '
    ]) {
      ok(`"${bad}" is not an editable target`, !isKnowledgeTarget(bad))
    }
    ok('a real target passes', isKnowledgeTarget('playbook'))
  }

  // ── forget: the unlearn primitive ───────────────────────────────────
  {
    const { root } = await makeWorkspace()
    const { store, bumps } = storeFor(root)
    await write(
      root,
      `${KNOWLEDGE_REL}/people.md`,
      [
        '# People',
        '',
        '## Sana (wife)',
        '- Prefers voice notes over text.',
        '- Works at Acme as a designer.',
        '',
        '## Omar (brother)',
        '- Lives in Jeddah.',
        ''
      ].join('\n')
    )

    // The failure this exists to prevent: deleting only the matched WORDS and
    // leaving "- Works at  as a designer." behind as a half-true belief.
    const gone = await store.forget('people', 'Works at Acme as a designer')
    ok('forget succeeds on a unique entry', gone.ok, err(gone))
    const after = await read(root, `${KNOWLEDGE_REL}/people.md`)
    ok(
      '…the whole line is gone, not just the matched words',
      !after.includes('as a designer'),
      after
    )
    ok('…the sibling entry survives', after.includes('Prefers voice notes'), after)
    ok('…the section survives while it still has facts', after.includes('## Sana (wife)'), after)
    ok(
      'a knowledge forget that leaves headings intact does NOT break the prompt cache',
      bumps() === 0,
      `${bumps()} invalidations`
    )

    // Emptying a topic must retire the heading: the memory map advertises `##`
    // headings, so a heading with nothing under it invites a recall for a fact
    // that no longer exists.
    const emptied = await store.forget('people', 'Lives in Jeddah')
    ok('forget succeeds on the last fact of a section', emptied.ok, err(emptied))
    const pruned = await read(root, `${KNOWLEDGE_REL}/people.md`)
    ok('…the emptied section heading is pruned', !pruned.includes('## Omar'), pruned)
    ok('…and THAT change does invalidate the memory map', bumps() === 1, `${bumps()} invalidations`)
  }

  // ── Never guess which belief was meant ──────────────────────────────
  {
    const { root } = await makeWorkspace()
    const { store } = storeFor(root)
    await write(
      root,
      `${KNOWLEDGE_REL}/technical.md`,
      [
        '# Technical',
        '',
        '## Databases',
        '- Uses Postgres for the API.',
        '- Uses Postgres for analytics.',
        ''
      ].join('\n')
    )
    const before = await read(root, `${KNOWLEDGE_REL}/technical.md`)

    const ambiguous = await store.forget('technical', 'Uses Postgres')
    ok('an ambiguous find is refused, not guessed', !ambiguous.ok)
    ok('…and the error says why', err(ambiguous).includes('unique'), err(ambiguous))
    ok('…and the file is untouched', (await read(root, `${KNOWLEDGE_REL}/technical.md`)) === before)

    const missing = await store.edit('technical', 'Uses MySQL for the API', 'x')
    ok('a find that matches nothing is refused', !missing.ok)
    ok(
      '…and the error offers the closest real lines instead of failing blind',
      err(missing).includes('Postgres'),
      err(missing)
    )

    // A model retyping a bullet from memory gets the words right and the
    // spacing wrong; that must still resolve rather than dead-end.
    const sloppy = await store.edit(
      'technical',
      'uses   postgres for   analytics.',
      '- Uses SQLite for analytics.'
    )
    ok('whitespace/case-sloppy matching still resolves a unique line', sloppy.ok, err(sloppy))
    const fixed = await read(root, `${KNOWLEDGE_REL}/technical.md`)
    ok('…the correction landed', fixed.includes('SQLite for analytics'), fixed)
    ok('…and the other Postgres fact is untouched', fixed.includes('Postgres for the API'), fixed)
  }

  // ── forget cannot blank a file ──────────────────────────────────────
  {
    const { root } = await makeWorkspace()
    const { store } = storeFor(root)
    await write(
      root,
      `${KNOWLEDGE_REL}/decisions.md`,
      '# Decisions\n\n## Stack\n- Chose Electron.\n'
    )
    const wipe = await store.forget('decisions', 'Chose Electron')
    ok('forgetting the only remaining fact is refused', !wipe.ok)
    ok('…and points at the deliberate path', err(wipe).includes('knowledge_rewrite'), err(wipe))
    ok(
      '…and the fact is still there',
      (await read(root, `${KNOWLEDGE_REL}/decisions.md`)).includes('Chose Electron')
    )
  }

  // ── Playbook: five sections, provenance, ceiling ────────────────────
  {
    const { root } = await makeWorkspace()
    const { store } = storeFor(root)

    const noSection = await store.add('playbook', 'Never send the digest before 07:00.')
    ok('a playbook entry with no section is refused', !noSection.ok)
    ok(
      '…and the five valid sections are named',
      err(noSection).includes('User dislikes'),
      err(noSection)
    )

    const invented = await store.add('playbook', 'x', { section: 'Lessons' })
    ok('an invented playbook section is refused', !invented.ok, err(invented))

    const added = await store.add('playbook', 'Never send the digest before 07:00.', {
      section: 'Avoid'
    })
    ok('a well-formed playbook entry lands', added.ok, err(added))
    const pb = await read(root, PLAYBOOK_REL)
    ok(
      '…the file is seeded with all five sections',
      /## Do[\s\S]*## Avoid[\s\S]*## User likes[\s\S]*## User dislikes[\s\S]*## Recipes/.test(pb),
      pb
    )
    ok('…the entry is under Avoid', /## Avoid\n- Never send the digest/.test(pb), pb)
    ok(
      '…and the provenance stamp the nightly decay pass reads is applied in code',
      /\(user-said, \d{4}-\d{2}-\d{2}\)/.test(pb),
      pb
    )

    // The same lesson re-learned tomorrow is the same entry. Without the
    // stamp-insensitive dedup, the playbook accumulates near-identical lines
    // differing only by date — the exact failure mode the reflection rewrite
    // was built to end.
    const again = await store.add('playbook', 'Never send the digest before 07:00.', {
      section: 'Avoid',
      source: 'inferred'
    })
    ok('re-adding the same lesson is a no-op, stamp notwithstanding', again.ok, err(again))
    ok(
      '…exactly one copy exists',
      (await read(root, PLAYBOOK_REL)).split('Never send the digest').length - 1 === 1
    )

    // The playbook rides in every prompt; growth past the ceiling is refused,
    // but a file already over budget must always be able to shrink.
    const bulk = `# Playbook\n\n## Do\n${'- '.padEnd(80, 'x')}\n`.repeat(1)
    const huge = `# Playbook\n\n## Do\n${Array.from({ length: 400 }, (_, i) => `- Lesson number ${i} padded out to make this file large.`).join('\n')}\n`
    const over = await store.rewrite('playbook', huge)
    ok('a rewrite past the ceiling is refused', !over.ok)
    ok(
      '…naming the ceiling and that it rides in every prompt',
      err(over).includes('every prompt'),
      err(over)
    )
    ok(
      '…and the playbook still has its original entry',
      (await read(root, PLAYBOOK_REL)).includes('07:00')
    )
    void bulk

    // Shrink-from-over-budget: seed an oversized file directly, then confirm a
    // smaller (still-over) rewrite is allowed — otherwise an oversized file
    // would be permanently unfixable.
    await write(root, PLAYBOOK_REL, huge)
    const shrink = await store.rewrite(
      'playbook',
      `# Playbook\n\n## Do\n${Array.from({ length: 300 }, (_, i) => `- Lesson number ${i} padded out to make this file large.`).join('\n')}\n`
    )
    ok('shrinking an already-oversized playbook is allowed', shrink.ok, err(shrink))
  }

  // ── Rewrite: complete files only, structure normalized ──────────────
  {
    const { root } = await makeWorkspace()
    const { store, bumps } = storeFor(root)
    await write(
      root,
      `${KNOWLEDGE_REL}/projects.md`,
      '# Projects\n\n## Wolffish\n- Electron app.\n'
    )

    const fragment = await store.rewrite('projects', '- Just this one bullet.')
    ok('a rewrite missing the header is refused as a fragment', !fragment.ok)
    ok(
      '…and says what a complete file looks like',
      err(fragment).includes('# Projects'),
      err(fragment)
    )

    // The invariant the deep clean needs and models keep breaking: a flat
    // rewrite gets its labelled bullets promoted to `## Entity` sections in
    // CODE, because the memory map keys on those headings.
    const flat = await store.rewrite(
      'projects',
      '# Projects\n\n- **Wolffish** — Electron app, shipping 1.0.\n- **Atlas** — research spike.\n'
    )
    ok('a flat rewrite is accepted', flat.ok, err(flat))
    const body = await read(root, `${KNOWLEDGE_REL}/projects.md`)
    ok(
      '…and normalized to `## Entity` sections in code',
      body.includes('## Wolffish') && body.includes('## Atlas'),
      body
    )
    ok('…the facts survive the promotion', body.includes('shipping 1.0'), body)
    ok('…a heading change invalidates the memory map', bumps() === 1, `${bumps()} invalidations`)
  }

  // ── Backup and restore: the safety net under "unlearn" ──────────────
  {
    const { root } = await makeWorkspace()
    const { store } = storeFor(root)
    const original = '# Preferences\n\n## Tone\n- Prefers terse answers.\n'
    await write(root, `${KNOWLEDGE_REL}/preferences.md`, original)

    const nothingYet = await store.restore('preferences')
    ok('restore with no backup is a clear no-op error', !nothingYet.ok, err(nothingYet))

    await store.edit('preferences', 'Prefers terse answers.', '- Prefers long, detailed answers.')
    ok(
      'the pre-edit bytes are kept as .bak',
      (await read(root, `${KNOWLEDGE_REL}/preferences.md.bak`)).includes('terse'),
      await read(root, `${KNOWLEDGE_REL}/preferences.md.bak`)
    )

    const undone = await store.restore('preferences')
    ok('restore succeeds', undone.ok, err(undone))
    ok(
      '…the wrong edit is gone',
      (await read(root, `${KNOWLEDGE_REL}/preferences.md`)).includes('terse')
    )

    // Restore is a SWAP, so an accidental restore is itself undoable.
    const redone = await store.restore('preferences')
    ok('restoring again swaps forward', redone.ok, err(redone))
    ok(
      '…back to the edited version',
      (await read(root, `${KNOWLEDGE_REL}/preferences.md`)).includes('long, detailed')
    )
  }

  // ── Two turns amending the same file at once ────────────────────────
  {
    // Wolffish runs concurrent conversations, so two turns really can amend
    // one knowledge file in the same instant. If the plan is computed from
    // bytes read OUTSIDE the file's write queue, both reads see the original
    // and the second write silently resurrects what the first forgot — the
    // classic two-writers clobber, invisible because both calls report success.
    const { root } = await makeWorkspace()
    const { store } = storeFor(root)
    await write(
      root,
      `${KNOWLEDGE_REL}/technical.md`,
      '# Technical\n\n## Stack\n- Runs on Node 24.\n- Uses Vite for builds.\n- Ships with electron-builder.\n'
    )

    const [a, b] = await Promise.all([
      store.forget('technical', 'Runs on Node 24'),
      store.forget('technical', 'Uses Vite for builds')
    ])
    ok('both concurrent forgets report success', a.ok && b.ok, `${err(a)} / ${err(b)}`)
    const after = await read(root, `${KNOWLEDGE_REL}/technical.md`)
    ok('…the first forget was not clobbered by the second', !after.includes('Node 24'), after)
    ok('…and the second landed too', !after.includes('Vite'), after)
    ok('…while the untouched fact survives', after.includes('electron-builder'), after)
  }

  // ── Forgetting a topic takes its facts with it ──────────────────────
  {
    // "Forget everything about Omar" targeting the heading must not drop the
    // heading alone: his facts would silently re-home under the person above
    // him, which is worse than not forgetting at all.
    const { root } = await makeWorkspace()
    const { store } = storeFor(root)
    await write(
      root,
      `${KNOWLEDGE_REL}/people.md`,
      '# People\n\n## Sana (wife)\n- Prefers voice notes.\n\n## Omar (brother)\n- Lives in Jeddah.\n- Allergic to shellfish.\n\n## Layla (colleague)\n- Runs the design review.\n'
    )
    const dropped = await store.forget('people', '## Omar (brother)')
    ok('forgetting a topic heading succeeds', dropped.ok, err(dropped))
    const after = await read(root, `${KNOWLEDGE_REL}/people.md`)
    ok('…the heading is gone', !after.includes('Omar'), after)
    ok('…and so are its facts, not orphaned under Sana', !after.includes('Jeddah'), after)
    ok('…', !after.includes('shellfish'), after)
    ok('…the topic after it is untouched', after.includes('Runs the design review'), after)
    ok('…and so is the topic before it', after.includes('Prefers voice notes'), after)
  }

  // ── An unsectioned add into a sectioned file is a misfile ───────────
  {
    const { root } = await makeWorkspace()
    const { store } = storeFor(root)
    await write(
      root,
      `${KNOWLEDGE_REL}/people.md`,
      '# People\n\n## Sana (wife)\n- Prefers voice notes.\n\n## Omar (brother)\n- Lives in Jeddah.\n'
    )
    // Appending at the end of a file organized by topic reads as belonging to
    // the LAST topic — a fact about Sana filed under Omar. Ask, don't guess.
    const unsectioned = await store.add('people', 'Sana started a new job.')
    ok('an unsectioned add into a sectioned file is refused', !unsectioned.ok)
    ok(
      '…and the error lists the sections to choose from',
      err(unsectioned).includes('Sana (wife)') && err(unsectioned).includes('Omar (brother)'),
      err(unsectioned)
    )
    const placed = await store.add('people', 'Started a new job.', { section: 'Sana (wife)' })
    ok('…and the sectioned form lands', placed.ok, err(placed))
    const after = await read(root, `${KNOWLEDGE_REL}/people.md`)
    ok(
      '…under the right topic',
      /## Sana \(wife\)\n- Prefers voice notes\.\n- Started a new job\./.test(after),
      after
    )

    // An empty file has no topics to misfile into, so no section is required.
    const fresh = await storeFor(root).store.add('projects', 'Wolffish ships in August.')
    ok('an unsectioned add into an EMPTY file is fine', fresh.ok, err(fresh))
  }

  // ── Interop with memory_save (the pre-existing note path) ──────────
  {
    // memory_save → hippocampus.promoteToKnowledge writes the SAME five files
    // these tools edit. One store, two writers — so they have to agree about
    // duplicates and must not clobber each other.
    const { root } = await makeWorkspace()
    const { store } = storeFor(root)
    const hippocampus = new Hippocampus({ workspaceRoot: root })

    await hippocampus.promoteToKnowledge('technical', 'Runs Node 24 on the mini.')
    const noted = await read(root, `${KNOWLEDGE_REL}/technical.md`)
    ok(
      'memory_save seeds the file with a header and a flat bullet',
      noted.includes('# Technical'),
      noted
    )

    // The misfile this placement rule exists to end: memory_save used to append
    // at end-of-file, so a note about one subject landed under whichever `##`
    // topic happened to be last — "Sana started a new job" filed under
    // "## Omar (brother)". An unfiled note must claim nothing.
    await write(
      root,
      `${KNOWLEDGE_REL}/people.md`,
      '# People\n\n## Sana (wife)\n- Prefers voice notes.\n\n## Omar (brother)\n- Lives in Jeddah.\n'
    )
    await hippocampus.promoteToKnowledge('people', 'Sana started a new job.')
    const unfiled = await read(root, `${KNOWLEDGE_REL}/people.md`)
    ok(
      'an unfiled note lands in the preamble, not under the last topic',
      /# People\n+- Sana started a new job\.\n+## Sana \(wife\)/.test(unfiled),
      unfiled
    )
    ok('…so it is not falsely attributed to Omar', !/Jeddah[\s\S]*new job/.test(unfiled), unfiled)

    // And with a topic it goes exactly where it belongs — the same placement
    // rule knowledge_add uses, so a note and a filed add cannot disagree.
    await hippocampus.promoteToKnowledge('people', 'Allergic to shellfish.', 'Omar (brother)')
    const filed = await read(root, `${KNOWLEDGE_REL}/people.md`)
    ok(
      'a note WITH a topic lands under that topic',
      /## Omar \(brother\)\n- Lives in Jeddah\.\n- Allergic to shellfish\./.test(filed),
      filed
    )
    // Case-insensitive so "sana (wife)" doesn't fork a second heading.
    await hippocampus.promoteToKnowledge('people', 'Speaks French.', 'sana (WIFE)')
    const cased = await read(root, `${KNOWLEDGE_REL}/people.md`)
    ok(
      '…matching an existing topic case-insensitively rather than forking it',
      cased.split(/^## /gm).length - 1 === 2 &&
        /Prefers voice notes\.\n- Speaks French\./.test(cased),
      cased
    )
    // A genuinely new topic creates its own heading.
    await hippocampus.promoteToKnowledge('people', 'Runs the design review.', 'Layla (colleague)')
    ok(
      'a new topic gets its own heading',
      (await read(root, `${KNOWLEDGE_REL}/people.md`)).includes('## Layla (colleague)')
    )

    // A note saved one way and re-added the other is ONE belief, not two.
    const dupe = await store.add('technical', 'Runs Node 24 on the mini.')
    ok('re-adding a memory_save fact through knowledge_add is a no-op', dupe.ok, err(dupe))
    ok(
      '…exactly one copy on disk',
      (await read(root, `${KNOWLEDGE_REL}/technical.md`)).split('Node 24').length - 1 === 1,
      await read(root, `${KNOWLEDGE_REL}/technical.md`)
    )

    // The reverse direction: a fact these tools wrote must be visible to
    // memory_save's own dedup, or the nightly note path would re-add it.
    await store.add('technical', 'Builds with Vite.')
    await hippocampus.promoteToKnowledge('technical', 'Builds with Vite.')
    ok(
      'memory_save does not duplicate a fact knowledge_add wrote',
      (await read(root, `${KNOWLEDGE_REL}/technical.md`)).split('Builds with Vite').length - 1 ===
        1,
      await read(root, `${KNOWLEDGE_REL}/technical.md`)
    )

    // Both writers go through diskWriter on the same path, so they share one
    // queue — a note landing mid-forget must not resurrect what was forgotten.
    const [, forgotten] = await Promise.all([
      hippocampus.promoteToKnowledge('technical', 'Uses electron-builder.'),
      store.forget('technical', 'Runs Node 24 on the mini.')
    ])
    ok('a concurrent note and forget both land', forgotten.ok, err(forgotten))
    const final = await read(root, `${KNOWLEDGE_REL}/technical.md`)
    ok('…the note is there', final.includes('electron-builder'), final)
    ok('…and the forgotten fact stayed forgotten', !final.includes('Node 24'), final)
  }

  // ── Prose files keep their shape ────────────────────────────────────
  {
    const { root } = await makeWorkspace()
    const { store } = storeFor(root)
    await write(root, 'brain/prefrontal/agents.md', '<!--\n  Your file.\n-->\n')

    const dictated = await store.add('instructions', 'Always CC Omar on client email.')
    ok('a standing instruction lands in agents.md', dictated.ok, err(dictated))
    const body = await read(root, 'brain/prefrontal/agents.md')
    ok('…as prose, not force-bulleted', body.includes('\nAlways CC Omar on client email.'), body)
    ok('…and the user’s own comment block is preserved', body.includes('Your file.'), body)

    const listed = await store.list()
    const instructions = listed.find((r) => r.target === 'instructions')
    ok('list reports the file as riding in every prompt', instructions?.everyPrompt === true)
    ok('list reports a real size', (instructions?.bytes ?? 0) > 0, String(instructions?.bytes))
    const people = listed.find((r) => r.target === 'people')
    ok('list reports an untouched target as empty rather than failing', people?.bytes === 0)
    ok(
      'list covers every target',
      listed.length === KNOWLEDGE_TARGETS.length,
      String(listed.length)
    )
  }

  // ── edit is not a delete ────────────────────────────────────────────
  {
    const { root } = await makeWorkspace()
    const { store } = storeFor(root)
    await write(root, `${KNOWLEDGE_REL}/user.md`, '# User\n\n## Basics\n- Based in Riyadh.\n')
    await write(root, 'brain/identity/user.md', '# User\n\nBased in Riyadh.\n')
    const blanked = await store.edit('user', 'Based in Riyadh.', '   ')
    ok('an empty replacement is refused', !blanked.ok)
    ok('…and points at forget instead', err(blanked).includes('knowledge_forget'), err(blanked))
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
