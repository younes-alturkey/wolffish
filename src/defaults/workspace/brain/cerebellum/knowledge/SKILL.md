---
name: knowledge
description: Maintain your own long-term memory — record a new belief, correct a wrong fact, unlearn a lesson, edit your playbook, identity and standing instructions
triggers:
  - remember that
  - remember this
  - remember i
  - note that
  - keep in mind
  - make a note
  - write that down
  - add to your
  - save that
  - for future reference
  - going forward
  - forget that
  - forget about
  - stop doing
  - stop saying
  - unlearn
  - that is wrong
  - that's wrong
  - you got that wrong
  - not true anymore
  - no longer true
  - it changed
  - update what you know
  - correct your memory
  - fix your memory
  - wrong about
  - remember instead
  - from now on
  - always do
  - never do
  - stop assuming
  - your playbook
  - playbook
  - lesson
  - your instructions
  - custom instructions
  - your personality
  - your character
  - your soul
  - who you think i am
  - what you know about me
  - what do you believe
  - long term memory
  - knowledge file
  - amend
  - retire that
  - drop that
tools:
  - name: knowledge_list
    readOnly: true
    description: 'Map every long-term belief file you can edit: what each governs, its size and ceiling, its section headings (the anchors you edit by), and whether it rides in every prompt. Start here when the user corrects you and you are not sure which file holds the belief.'
    parameters: {}
  - name: knowledge_read
    readOnly: true
    description: Read one long-term file in full, verbatim. Always read before editing — knowledge_edit and knowledge_forget need the entry copied exactly.
    parameters:
      target:
        type: string
        required: true
        enum: [playbook, instructions, soul, user, projects, people, preferences, technical, decisions]
        description: Which file to read
  - name: knowledge_add
    description: 'Record a new durable belief: a behavioural lesson (playbook), a standing procedure the user dictates (instructions), a fact about them or about you. Files the entry under the right section, which is what keeps a fact about one person from landing under another — memory_save is the quicker path only for a plain fact in a file with no sections yet.'
    parameters:
      target:
        type: string
        required: true
        enum: [playbook, instructions, soul, user, projects, people, preferences, technical, decisions]
        description: Which file to add to
      entry:
        type: string
        required: true
        description: One tight, self-contained line
      section:
        type: string
        required: false
        description: 'Section heading to file it under (created if missing). REQUIRED for playbook — one of: Do, Avoid, User likes, User dislikes, Recipes.'
      source:
        type: string
        required: false
        enum: [user-said, inferred]
        description: 'Playbook only — where the lesson came from (default user-said). Stamped with today''s date automatically; inferred entries decay after 30 days.'
  - name: knowledge_edit
    description: 'Amend an existing entry in place — the correction path when a belief is stale or partly wrong. `find` must match exactly one entry; copy it verbatim from knowledge_read.'
    parameters:
      target:
        type: string
        required: true
        enum: [playbook, instructions, soul, user, projects, people, preferences, technical, decisions]
        description: Which file holds the entry
      find:
        type: string
        required: true
        description: The existing entry, copied verbatim (a unique excerpt is enough)
      replace:
        type: string
        required: true
        description: The corrected entry that replaces it
  - name: knowledge_forget
    description: 'UNLEARN — delete an entry outright. Use when a belief is simply wrong, no longer true, or the user tells you to stop doing something you learned. The whole entry goes; a section left empty is pruned. The previous version is kept, so knowledge_restore undoes it.'
    parameters:
      target:
        type: string
        required: true
        enum: [playbook, instructions, soul, user, projects, people, preferences, technical, decisions]
        description: Which file holds the entry
      find:
        type: string
        required: true
        description: The entry to remove, copied verbatim (a unique excerpt is enough)
  - name: knowledge_rewrite
    description: 'Replace a whole file — the restructuring path when many entries need merging, re-homing, or reordering at once. Send the COMPLETE file including its "# Header" line. Prefer knowledge_edit/knowledge_forget for anything smaller.'
    parameters:
      target:
        type: string
        required: true
        enum: [playbook, instructions, soul, user, projects, people, preferences, technical, decisions]
        description: Which file to replace
      content:
        type: string
        required: true
        description: 'The complete new file content, starting with its "# Header" line'
  - name: knowledge_restore
    description: Undo the last change to a file by swapping it with its backup. Restoring again swaps back, so it is safe to try.
    parameters:
      target:
        type: string
        required: true
        enum: [playbook, instructions, soul, user, projects, people, preferences, technical, decisions]
        description: Which file to restore
confirm_patterns:
  # Deliberately narrow. Every write is reported in its own output and is one
  # knowledge_restore from undone, so gating ordinary corrections would put a
  # modal in front of the most common case ("that's wrong, she moved"). Only
  # two things earn a prompt: replacing a whole file at once, and the agent
  # editing its own character.
  - pattern: '^knowledge_rewrite\s'
    reason: Replaces an entire long-term memory file in one write
  - pattern: '^knowledge_(edit|forget)\s.*"target"\s*:\s*"soul"'
    reason: Changes your own character file, which rides in every prompt
---

# Knowledge — maintain what you believe

Everything you carry long-term is yours to write: **add** a new belief, **amend**
one that has gone stale, **forget** one that is no longer true. These seven tools
are the only way to do any of it without waiting for the nightly pass. Nine
files, one fixed list — nothing else is reachable, and every write keeps a
backup.

## The files

| Target | Holds | In every prompt |
|---|---|---|
| `playbook` | Behavioural lessons: Do / Avoid / User likes / User dislikes / Recipes | yes |
| `instructions` | Standing custom procedures; outrank the core contract | yes |
| `soul` | Your character, voice, manner | yes |
| `user` | The durable profile of who the user is | yes |
| `projects` `people` `preferences` `technical` `decisions` | Curated long-term facts | headings only |

`knowledge_list` prints this live, with sizes and section anchors.

## Which file — the boundary that matters

- A lesson about **how you should behave** → `playbook`. ("Avoid: don't send
  the digest before 07:00.")
- A **fact about the user or the world** → the matching knowledge file.
  ("People → Sana: moved to Riyadh in June.")
- A **standing procedure the user dictates** → `instructions`. ("Always reply
  in Arabic on LinkedIn.")
- Something about **your own manner** → `soul`.

Putting a behaviour rule in a knowledge file makes it invisible to your habits;
putting a fact in the playbook burns the character budget that rides in every
prompt. When unsure: behaviour → playbook, world → knowledge.

## When to reach for these

The trigger is the user telling you to keep, change, or drop something:

- *"Remember I always want invoices as PDF"* → `knowledge_add` to `preferences`.
- *"Sana's birthday is in March"* → `knowledge_add` to `people` under her section.
- *"From now on, always CC Omar"* → `knowledge_add` to `instructions`.
- *"Stop opening every reply with a summary"* → `knowledge_add` to `playbook`
  under `Avoid` — or `knowledge_forget` the `Do` entry that taught it.
- *"That's wrong, she works at X now"* → `knowledge_edit` on `people`.
- *"You keep believing I use Postgres — I moved to SQLite"* → `knowledge_edit`
  on `technical`.
- *"Forget what I said about the 6am digest"* → `knowledge_forget` on `playbook`.

Do it in the same turn they say it. Something you only acknowledge in prose is
gone the moment the conversation ends.

You can also add unprompted, when a turn genuinely teaches you something durable
about the user or their world — that is the same instinct as `memory_save`, just
filed under the right topic. Adding needs no invitation; **removing does**.

## Rules

- **Read before you write.** `knowledge_edit` and `knowledge_forget` need the
  entry copied verbatim, and they refuse an ambiguous match rather than guess
  which belief you meant. Copy from `knowledge_read`, don't retype from memory.
- **Forget beats contradict.** Two entries that disagree is worse than one that
  is missing. When something is no longer true, remove it — don't add a newer
  line beside it.
- **Never delete on your own initiative what the user did not challenge.** These
  tools exist to follow corrections, not to prune what you find inconvenient.
  Pruning by judgement is the nightly deep clean's job.
- **One entry per fact.** If the same belief already exists elsewhere in the
  file, edit that entry instead of adding a second. Re-adding a line you have
  already learned is a no-op, not a duplicate.
- **File it under a topic.** In a knowledge file already organized by `##`
  headings, `knowledge_add` requires a `section` — an entry appended at the end
  reads as belonging to whoever happens to be last, which is how a fact about
  one person ends up filed under another. Pass an existing heading or a new one.
- **Forgetting a `## Heading` forgets the whole topic**, its facts included.
  That is usually what "forget everything about X" means — if you only want one
  fact gone, target that line instead.
- The playbook is capped and rides in every prompt: a write that pushes it over
  the ceiling is refused. Compress or forget something first.
- `soul`, `user`, and `instructions` are the user's own files — they own them,
  you amend them on their instruction. Say what you changed.
- Anything you write here is permanent and re-read every turn. No secrets, keys,
  tokens, or passwords, ever.
- Wrong edit? `knowledge_restore` swaps the file back. Restoring again swaps
  forward, so it is always safe to try.

## What you still cannot edit

`agents.core.md` (the core contract) and the workflow role files are rewritten
by the app on every launch — editing them is pointless, so they are not in the
list. The nightly reflection day-files and `reviewed.json` are the raw audit
trail: rewriting history is not the same as amending a belief. To read any of
them, use `memory_get` or `file_read`.
