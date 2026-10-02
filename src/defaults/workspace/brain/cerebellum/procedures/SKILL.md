---
name: procedures
description: YOU OWN THIS. Manage Wolffish's saved procedures — reusable prompts the user runs on demand from the Procedures page. List, view, create, edit, delete, and run them. Reach for it by INTENT whenever a need or issue involves saving, re-running, or organizing a reusable prompt — even when the user never says "procedure".
triggers:
  - procedure
  - procedures
  - saved prompt
  - saved prompts
  - reusable prompt
  - prompt template
  - playbook
  - run my
  - run the
  - save this prompt
  - save this as
  - save it so i can run
  - save that as
  - make that reusable
  - run it again
  - my saved prompt
  - the saved one
  - reusable
  - keep that prompt
  - template for
  - do this again
  - i'll want this again
  - save my prompt
tools:
  - name: procedure_list
    readOnly: true
    description: List every saved procedure — its number, title, and a one-line preview of the prompt. Start here so you reference one by the right number or title.
    parameters: {}
  - name: procedure_view
    readOnly: true
    description: Show one procedure's full title and complete prompt (the list only previews). Identify it by number, exact title, or id.
    parameters:
      identifier:
        type: string
        description: The procedure to view — its 1-based number from procedure_list, its exact title, or its id.
  - name: procedure_create
    description: Save a new procedure — a reusable prompt the user can run on demand. Provide a short title and the full prompt.
    parameters:
      title:
        type: string
        description: A short, descriptive name for the procedure (required — shown on its card).
      prompt:
        type: string
        description: The full prompt to run when the procedure is played. Write it self-contained — a run starts a brand-new conversation with no prior context.
  - name: procedure_edit
    description: Change a procedure's title and/or prompt. Identify it by number, exact title, or id. Omit whichever field you want to keep.
    parameters:
      identifier:
        type: string
        description: The procedure to edit — its 1-based number from procedure_list, its exact title, or its id.
      title:
        type: string
        required: false
        description: New title. Omit to keep the current one. Cannot be empty.
      prompt:
        type: string
        required: false
        description: New prompt body. Omit to keep the current one.
  - name: procedure_delete
    description: Permanently delete a saved procedure. Identify it by number, exact title, or id.
    parameters:
      identifier:
        type: string
        description: The procedure to delete — its 1-based number from procedure_list, its exact title, or its id.
  - name: procedure_run
    description: Run a saved procedure right now — its prompt runs to completion by itself in a background sealed conversation that appears in history, while this conversation continues. Identify it by number, title, or id.
    parameters:
      identifier:
        type: string
        description: The procedure to run — its 1-based number from procedure_list, its exact title, or its id.
confirm_patterns:
  - pattern: '^procedure_delete\s'
    reason: Permanently deletes a saved procedure the user may want to keep
---

# Procedures — saved prompts, run on demand

**You own this.** Reach for it by intent whenever a need or issue involves
saving, re-running, or organizing a reusable prompt — even if the user never
names it. The `procedure_*` tools manage procedures; don't route to a manual
prompt re-run when a saved one exists.

A **procedure** is a reusable prompt the user has saved to run whenever they
want — a "summarize my open PRs", a "draft my weekly update", a "triage my
inbox". Unlike an [automation](../automations/SKILL.md), a procedure has **no
schedule**: it does not fire on its own. It sits on the Procedures page until
someone runs it — the user by hitting **Play**, or you with `procedure_run`.

Each procedure is just `{ title, prompt }`. You manage them with the
`procedure_*` tools; you never hand-edit storage.

## Procedure vs automation — pick the right one

- **Procedure** — the user wants to *save a prompt and run it manually, on
  demand, again and again*. "Save this as a procedure", "make a saved prompt
  for X", "I want to be able to run this whenever." No timing words.
- **Automation** — the user wants something to happen **on a schedule, by
  itself**: "every morning", "each day at 9", "in 15 minutes", "from now on".
  That's the `automations` capability, not this one.
- **Neither** — a one-off task the user wants done *right now* is just work you
  do now. Don't save a procedure for it unless they ask to keep it.

When in doubt, ask: does the user want to **re-run this on demand later**
(procedure) or have it **run automatically on a clock** (automation)?

## How a run works

`procedure_run` executes the saved prompt through the **same machinery a
triggered automation uses**:

- **It runs to completion on its own.** The prompt becomes a fresh, self-
  contained conversation — no chat history from here carries in. You (as that
  run) decide what tools to call and do the work end to end.
- **It's a sealed background conversation that lands in history.** The user can
  open it later to see exactly what ran.
- **This conversation keeps going.** `procedure_run` is **fire-and-forget**: it
  returns the moment the run is queued, so you carry on with the user here. It
  does **not** hand you the run's result — don't wait for it.
- **Tool calls are auto-approved inside the run.** Like an automation, a run
  acts unattended: a procedure that sends messages or deletes files will do so
  with no one watching. Only run prompts that are safe to execute unattended;
  confirm anything destructive with the user first.
- **Up to three at once, coalesced.** Runs go through the bounded run pool
  shared with automations (three concurrent slots): if every slot is busy, the
  procedure queues (and a second run of the *same* procedure while it's in
  flight is folded in, not run twice). If it didn't start immediately, say so —
  don't retry in a loop.
- **Do NOT poll.** You can't pause between tool calls, so looping to "watch" a
  run just burns turns and can't make it finish sooner. Fire it, tell the user
  it's running, and move on. If they later ask how it went, point them to the
  conversation in history.

## Files and working folders

A procedure can carry its own reference material, attached by the user in the
app (Procedures page, or the phone's Procedures screen). `procedure_list` shows
what each one carries:

- **Files** are COPIED into the workspace when attached, so a procedure can't
  dangle on a moved original. Every run — `procedure_run` and the Play button
  alike — is told each file's name, size and path, and **reads them with its own
  tools**. The content is never pasted into the prompt.
- **Working folders** are references, not copies. Each run gets a **fresh
  listing** of every one, the same way a working folder picked in chat does — so
  the run sees the folder as it is at that moment. This is where a procedure
  that produces or consumes files should work.

Write a procedure's prompt AGAINST them: say "the attached spreadsheet", "the
folder", and let the run look. Don't restate a file's contents into the prompt —
it would go stale the moment the file changed, which is the whole reason the
attachment exists. Attaching and detaching happen in the app, not from here.

## The tools

- `procedure_list` — see every procedure: number, title, prompt preview.
  **Start here** before viewing, editing, deleting, or running, so you use the
  right number/title.
- `procedure_view` — read one procedure's full prompt (the list only previews).
- `procedure_create` — save a new one (title + prompt). The title is required;
  write the prompt **self-contained**, since a run has no prior context.
- `procedure_edit` — change a title and/or a prompt. Omit whichever you keep.
- `procedure_delete` — remove one for good (asks the user to confirm).
- `procedure_run` — run one **now**, in the background. Fire-and-forget; the run
  finishes on its own and shows up in history. **Do not poll** for it.

## Writing a good procedure prompt

The prompt runs with your full toolset and **no chat context**, so write it the
way you'd brief yourself cold:

- **Be concrete and self-contained.** "Summarize *my* unread GitHub notifications
  and post the digest to the daily log" beats "summarize them".
- **Say where output goes** — a file, memory, or the user on a channel
  (`telegram_send` / `whatsapp_send`, only if that channel is connected).
- **Keep it safe to run unattended.** Favor read/summarize/notify over
  irreversible actions; a run auto-approves its tool calls.

## Create → confirm, in one turn

1. **Create** — `procedure_create(title, prompt)`. A required title, a self-
   contained prompt.
2. **Confirm** — `procedure_list` (or `procedure_view`) shows it saved.
3. **Optionally test** — `procedure_run(<it>)` fires it now (fire-and-forget;
   don't poll). Skip the test if running it for real would have side effects the
   user hasn't approved (e.g. it messages someone) — reason through the prompt
   instead.
4. **Conclude** — tell the user it's saved and how to run it (Play on the
   Procedures page, or ask you to run it).
