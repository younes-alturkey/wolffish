---
name: automations
version: 1.0.0
description: YOU OWN THIS. Wolffish's scheduled automations (the heartbeat) — list, create, edit, pause, resume, delete, check status, and run jobs that fire on a schedule and run autonomously. These tools are the ONLY supported way to change an automation; heartbeat.md is the file they manage, so read it freely but never change a job by editing it. Reach for them by INTENT whenever a need or issue touches a schedule, a recurring job, or the heartbeat — even when the user never says "automation".
triggers:
  - automation
  - automations
  - automate
  - schedule
  - scheduled
  - heartbeat
  - cron
  - recurring
  - every morning
  - every day
  - each morning
  - each day
  - every hour
  - every week
  - daily
  - nightly
  - weekly
  - remind me
  - background job
  - run automatically
  - on a schedule
  - from now on
  - do this every
  - change the schedule
  - change schedules
  - is not running
  - did it run
  - when does it run
  - that job
  - the heartbeat
  - make it automatic
  - set a reminder
  - stop that job
  - run it now
  - test the job
  - not firing
  - run automatically
  - heartbeat.md
  - the heartbeat file
  - brainstem
  - my automations
  - scheduled job
  - scheduled jobs
  - disable that job
  - turn off that job
  - pause that job
  - remove that job
  - change the time
  - what automations
  - edit the heartbeat
tools:
  - name: automation_list
    readOnly: true
    description: List every configured automation — active AND paused, numbered in the order they appear in heartbeat.md — with its name, its schedule, the plain-English timing, the instruction it runs, any files and working folders attached to it, and whether it's valid, paused, or currently running.
    parameters: {}
  - name: automation_create
    description: Create a new automation that runs on a schedule — the ONLY supported way to add one (never add one by writing its heading into heartbeat.md). Provide a short name, the schedule and the instruction to run.
    parameters:
      name:
        type: string
        description: 'A short human name for this automation — what the user sees on its card (e.g. "Morning digest", "Invoice filer"). Two to four words naming the JOB, never the schedule. Required.'
      schedule:
        type: string
        description: 'YOU pick one-time vs recurring from the user''s wording. ONE-TIME (runs once, then deletes itself) for "in 15 min", "in 2 days", "at 3pm", "tomorrow", "remind me once": "In (15m)" / "In (2h)" / "In (2d)" (relative — minutes, hours, days) or "Once (2026-06-27 14:30)" (absolute, 24h local). RECURRING for "every", "each", "daily", "from now on": "Every (5m)" / "Every (2h)" · "Hourly (30)" · "Daily (08:00)" / "Nightly (23:00)" · "Weekday (09:00)" · "Weekly (Monday 09:30)" · "Monthly (1 09:00)" · "Cron (0 9 * * 1,3,5)" · "Startup". SEVERAL TIMES a day/week/month is ONE heading with a comma list: "Daily (08:00, 14:00, 20:00)" · "Weekday (09:00, 17:00)" · "Weekly (Monday, Wednesday, Friday 09:00)" · "Monthly (1, 15 09:00)" (days and times can both be lists). Default to one-time for a specific future moment. NOT for a wait you can sit through: an automation starts a FRESH run later that begins with only what you write into its instruction, so write it self-contained. When what you would have to hand over is a whole working state you already have — the files you opened, what you worked out, the rest of your plan — call `wait` and keep working in this turn instead.'
      instruction:
        type: string
        description: What to do when it fires — plain natural-language instruction, exactly as you'd phrase a task to yourself. It runs as an autonomous turn with tools available and tool calls auto-approved. No markdown headings (no lines starting with "## ") and no "---" separator lines.
      mode:
        type: string
        required: false
        enum: ['single', 'workflow']
        description: Which chat mode the automation runs in — 'single' (one model, direct) or 'workflow' (the run can plan phases and drive parallel agents). Omit to use whatever mode the chat is in right now.
      icon:
        type: string
        required: false
        description: 'A single emoji for this automation — YOU pick one that fits what it does (📧 for an inbox sweep, 📰 for a news digest, 💌 for a message sender). Shown on its card and stamped on its run conversations. One emoji, no spaces. Omitted or invalid ⇒ the default 🫀.'
  - name: automation_edit
    description: Change an existing automation's name, schedule, instruction or mode, or PAUSE and RESUME it with `enabled` — the ONLY supported way to change one (never change a job by rewriting heartbeat.md). Identify it by the number from automation_list or its exact schedule label.
    parameters:
      identifier:
        type: string
        description: The automation to edit — its 1-based number from automation_list, or its exact schedule label (e.g. "Daily (08:00)").
      name:
        type: string
        required: false
        description: New display name. Omit to keep the current one.
      schedule:
        type: string
        required: false
        description: New schedule (same forms as automation_create, including "In (...)" / "Once (...)" for one-time). Omit to keep the current schedule.
      instruction:
        type: string
        required: false
        description: New instruction body. Omit to keep the current instruction.
      mode:
        type: string
        required: false
        enum: ['single', 'workflow']
        description: Change which chat mode the automation runs in ('single' or 'workflow'). Omit to keep its current mode.
      enabled:
        type: boolean
        required: false
        description: false PAUSES the automation — it stays listed (here and on the Automations page) but stops firing, exactly like the page's off switch; true RESUMES a paused one. Omit to leave it as it is. Combines with the other changes, so a paused one-time job whose moment has passed resumes with a new schedule in the same call.

  - name: automation_delete
    description: Permanently remove an automation so it stops firing. Identify it by its number from automation_list or its exact schedule label.
    parameters:
      identifier:
        type: string
        description: The automation to delete — its 1-based number from automation_list, or its exact schedule label.
  - name: automation_check
    readOnly: true
    description: Check runtime status — which automation (if any) is running right now, and how each one's last run went (completed, failed, or skipped). Use this to verify an automation works or to see recent activity.
    parameters: {}
  - name: automation_run
    description: Run an automation immediately, right now, instead of waiting for its schedule — the way to test one. Runs in the background as a sealed conversation. Identify it by number or schedule label. A paused automation can't run until it is resumed.
    parameters:
      identifier:
        type: string
        description: The automation to run now — its 1-based number from automation_list, or its exact schedule label.
confirm_patterns:
  - pattern: 'automation_delete'
    reason: Permanently removing an automation stops it from ever firing again
---

# Automations — your heartbeat, on a schedule

**You own this.** Reach for it by intent whenever a need or issue touches a
schedule, a recurring job, or the heartbeat — even if the user never names it.

**Managing an automation is always a tool call.** `automation_create`,
`automation_edit`, `automation_delete`, `automation_run`, `automation_list`,
`automation_check` — every OPERATION on a job goes through them, every time, no
exceptions and no "quick edit". They own the parts that are easy to miss by hand:
schedule validation, the live scheduler reload, the per-job settings markers and
the app's edit stamps. Skip them and the Automations page and the running
scheduler quietly disagree with the file — until the next writer (the page, a
toggle, a sync) overwrites your change without a word.

That governs the operation, not the file. `brain/brainstem/heartbeat.md` stays
readable and is often the clearest answer to "what's scheduled?" — and when the
task really is the file rather than the setting (the user wants to see or
hand-edit the raw markdown, or a bulk restructure the tools don't cover), open it
as the file it is. What you don't do is reach for it to do a job the tools do.

**Pausing and resuming are tool calls too.** "Turn that job off", "pause the
digest", "stop it for now" is `automation_edit` with `enabled: false` — the job
stays in the file and on the Automations page, switched off (the same `<!-- -->`
the page's own switch writes), and stops firing; `enabled: true` turns it back
on. `automation_list` shows paused jobs in their place, numbered like the rest,
so you can always find one to resume. Pause rather than delete whenever the user
might want the job back — `automation_delete` is permanent. A paused one-time
job whose moment has passed can't simply resume (the scheduler would retire it
unrun); resume it with a new `schedule` in the same `automation_edit` call.

An **automation** is a scheduled job that runs **by itself**, with no one in the
chat. Together they are Wolffish's *heartbeat*: the background work that keeps
happening — a morning briefing at 08:00, an inbox sweep every 15 minutes, a
Friday retrospective. Each automation is one entry in
`brain/brainstem/heartbeat.md`: a `## <schedule>` heading and, below it, a plain
instruction. The brainstem parses that file, registers a cron job for each
entry, and when a job fires it runs the instruction as a full autonomous agent
turn. You manage all of this with the `automation_*` tools.

An entry's body may START with setting-marker lines the user configured from
the Automations page — `mode: single|workflow`, `project: <id>` (the run gets
that project's context and its conversation registers under the project),
`icon: <emoji>` (the card/badge emoji), and the repeatable `file: <path>` /
`dir: <path>`. They are settings, not instruction text. The `automation_*`
tools preserve them automatically — one more reason management belongs to the
tools.

**Files and working folders (`file:` / `dir:`).** These are what the user
attached to an automation from the Automations page — the automation's own
reference material, exactly like a project's files:

- `file: <path>` — a file COPIED into the workspace when it was attached, so it
  can't move out from under the run. When the automation fires, the run is told
  the name, size and path of each one and **reads them with its own tools** —
  the content is never pasted into the prompt. Attach and detach happen in the
  app, not here; `automation_list` shows what an automation carries.
- `dir: <path>` — a working folder. Each fire gets a **fresh listing** of its
  top level, the same way a working folder picked in chat does, so the run sees
  the folder as it is at that moment. This is where an automation that produces
  or consumes files should work.

When you write an instruction for an automation that has these, write it
against them: say "the attached report", "the folder", and let the run look.
Don't restate a file's contents into the prompt — it would go stale the moment
the file changed, which is the whole reason the attachment exists.

## One-time vs recurring — YOU decide

This is the most important call when creating an automation, and it's yours to
make from how the user phrased it:

- **One-time** (the job runs once, then **deletes itself**). Use it whenever the
  user names a single future moment: "in 15 minutes", "at 3pm", "tonight",
  "tomorrow morning", "remind me once". Forms: `In (15m)` / `In (2h)` for a
  relative delay, or `Once (2026-06-27 14:30)` for an absolute time. After it
  fires it's gone — you won't see it in `automation_list` anymore.
- **Recurring** (fires on a repeating schedule, forever, until deleted). Use it
  only when the user clearly wants repetition: "every morning", "each day",
  "every 15 minutes", "from now on", "daily". Forms: `Every`, `Hourly`, `Daily`,
  `Nightly`, `Weekday`, `Weekly`, `Monthly`, `Cron`, `Startup`.

**Default to one-time for a specific future moment.** "Send me X in 15 minutes"
is a one-shot (`In (15m)`), NOT a `Daily` job — making it recurring would spam
the user every day. Only reach for a recurring form when the user actually asked
for something that repeats.

## How an automation actually runs

- **It runs autonomously.** When a job fires there's no user in the loop. The
  instruction becomes a user message to yourself; you decide what tools to call
  and do the work. It happens in a **sealed conversation** that shows up in
  history, so the user can see what ran.
- **Tool calls are auto-approved.** Inside an automation, calls that would
  normally pop an approval card just run. That is power and risk: an automation
  that deletes files or sends messages will do so unattended. Write instructions
  you'd be comfortable running with no one watching, and confirm anything
  destructive with the user *before* you schedule it.
- **Up to three at once, queued — never dropped.** Jobs run up to three at a
  time. If a job fires while all three slots are busy, it **queues** and runs
  as soon as a slot frees (coalesced per job, so a slow job can't pile up its
  own backlog). You don't have to spread jobs out to avoid collisions anymore.
- **Missed runs catch up.** If the app was off when a job was due, it runs once
  on the next launch (collapsed — a recurring job that missed several fires runs
  a single catch-up, not one per missed tick), as long as the missed time was
  within the last 24 hours. Older misses are dropped.
- **Times are 24-hour, in the system's local timezone.** `Daily (08:00)` is 8am
  where the user is.
- **Startup jobs** run once, immediately, every time Wolffish launches.

## The tools

- `automation_list` — see every automation: its schedule, plain-English timing,
  the instruction, and whether it's valid and running. **Start here** before
  editing or deleting, so you use the right number/label.
- `automation_create` — add a new one (schedule + instruction). See the syntax
  below; the schedule must be one of the exact forms.
- `automation_edit` — change a schedule and/or an instruction. Identify the job
  by its number from `automation_list` or its exact label.
- `automation_delete` — remove one for good (asks the user to confirm).
- `automation_check` — runtime status: what's running now, and how each job's
  last run went. This is how you confirm an automation is healthy.
- `automation_run` — run one **right now** without waiting for its schedule.
  This is how you **test** a new automation. It is **fire-and-forget**: it
  starts the job in the background (its own sealed conversation) and returns
  immediately. The job finishes on its own and shows up in history. **Do not
  poll** `automation_check` in a loop afterward waiting for it — you can't pause
  between tool calls, so looping just burns turns and can't make it finish
  sooner. Fire it, tell the user it's running, and stop.

## Schedule syntax (the heading)

The `schedule` you pass is the text of the `##` heading. These are the **only**
valid forms — anything else is rejected.

**One-time** (runs once, then self-deletes):

| Form                          | Fires…                                       | Example                    |
| ----------------------------- | -------------------------------------------- | -------------------------- |
| `In (Nm)` / `In (Nh)` / `In (Nd)` | once, N minutes / hours / days from now  | `In (15m)` · `In (2h)` · `In (2d)` |
| `Once (YYYY-MM-DD HH:MM)`     | once, at that absolute local date-time       | `Once (2026-06-27 14:30)`  |

`In (...)` is just shorthand — it's converted to an absolute `Once (...)` at the
moment you create it, so it survives restarts. The unit is `m` (minutes), `h`
(hours), or `d` (days). The fire time must be in the future and within 30 days
(for further out, use a recurring form).

**Recurring** (fires forever until deleted):

| Form                     | Fires…                                            | Example                 |
| ------------------------ | ------------------------------------------------- | ----------------------- |
| `Startup`                | once, immediately, on every app launch            | `Startup`               |
| `Every (Nm)`             | every N minutes                                   | `Every (5m)`            |
| `Every (Nh)`             | every N hours (at minute 0)                       | `Every (2h)`            |
| `Hourly (MM)`            | once an hour, at minute MM                        | `Hourly (30)`           |
| `Daily (HH:MM)`          | once a day at HH:MM                               | `Daily (08:00)`         |
| `Nightly (HH:MM)`        | same as Daily — reads nicer for late times        | `Nightly (23:00)`       |
| `Weekday (HH:MM)`        | Mon–Fri only, at HH:MM                            | `Weekday (09:00)`       |
| `Weekly (Day HH:MM)`     | once a week on Day (Sunday…Saturday) at HH:MM      | `Weekly (Monday 09:30)` |
| `Monthly (DD HH:MM)`     | once a month on day DD (1–31) at HH:MM             | `Monthly (1 09:00)`     |
| `Cron (expr)`            | a raw 5-field cron expression — for anything else  | `Cron (0 9 * * 1,3,5)`  |

**Several times a day, week or month — ONE heading, comma lists.** "Three
times a day", "Mondays and Thursdays", "the 1st and the 15th" are all a single
automation, never three copies:

| Form                                  | Fires…                                             | Example                                    |
| ------------------------------------- | -------------------------------------------------- | ------------------------------------------ |
| `Daily (HH:MM, HH:MM, …)`             | every day at each listed time                      | `Daily (08:00, 14:00, 20:00)`              |
| `Weekday (HH:MM, HH:MM, …)`           | Mon–Fri at each listed time                        | `Weekday (09:00, 17:00)`                   |
| `Weekly (Day, Day, … HH:MM)`          | each listed day (full name or Mon/Tue/…) at HH:MM  | `Weekly (Monday, Wednesday, Friday 09:00)` |
| `Monthly (DD, DD, … HH:MM)`           | each listed day of the month at HH:MM              | `Monthly (1, 15 09:00)`                    |

Days and times can BOTH be lists — every listed day runs at every listed time
(`Weekly (Monday, Friday 09:00, 17:00)` = four runs a week). The times need not
share a minute (`Daily (08:00, 12:30, 18:00)` is fine). `Cron (…)` accepts
several expressions joined by `;` for anything the lists can't say.

Cron is `minute hour day-of-month month day-of-week`. Reach for it only when no
simpler form fits (e.g. `Cron (0 9 * * 1,3,5)` = 9am Mon/Wed/Fri). If you pass a
malformed or out-of-range schedule (`Every (0m)`, `Daily (99:99)`, a past
`Once`), `automation_create`/`automation_edit` reject it and list the valid
forms — fix it and retry.

## Writing the instruction

The instruction is plain natural language — write it the way you'd brief
yourself on a task. It runs with your full toolset, so name what you want done,
not how to do it step by step.

- **Be concrete and self-contained.** The job has no chat context — "summarize
  *my* overnight emails and save to today's daily log" beats "summarize them".
- **Say where output goes.** To a file? To memory (an episode / daily log)? To
  the user on a channel? If it should reach the user, say so — and remember that
  reaching them out-of-band means a channel send tool (`telegram_send` /
  `whatsapp_send`), which only works if that channel is connected.
- **Keep it safe to run unattended.** Favor read/summarize/notify over
  irreversible actions. Anything destructive should have been agreed with the
  user first.
- **No markdown headings** in the body (a line starting with `## ` would be read
  as the next automation), and **no `---` separator lines** (the parser drops
  them). Normal sentences and `-` bullets are fine.

## Create → test → verify, in one turn

Like any change, an automation isn't done until you've seen it work. Because
`automation_run` executes it on demand, you can prove it out immediately instead
of waiting hours for the schedule:

1. **Create** — `automation_create(schedule, instruction)`. Read the result; a
   rejected schedule means it wasn't written — fix the syntax and retry.
2. **Confirm it registered** — `automation_list` shows it with a valid schedule.
2. **Test it** — `automation_run(<it>)` to fire it now. (Skip this if running it
   for real would have side effects the user hasn't approved — e.g. it messages
   someone — or if it's a **one-time** job: don't test-run those, they fire
   themselves at the set time and a manual run just consumes it early. In those
   cases reason through the instruction instead.) This is
   **fire-and-forget** — it returns at once and the job runs in the background.
   **Do not loop `automation_check` waiting for it to finish** — you can't pause
   between calls, so polling just spends turns for nothing. Tell the user it's
   running and move on.
3. **Check the outcome later, once** — when the user asks how it went (or on a
   later turn), `automation_check` shows the last run as `completed` or `failed`
   (with the error). If it failed, `automation_edit` the instruction or schedule
   and run it again. A single check is enough; never re-check in a loop.
4. **Conclude** — tell the user what you scheduled, when it fires, and (if you
   tested it) that you fired a test run they can see in history.

## Good practice

- **Confirm before scheduling recurring autonomous work.** An automation acts on
  the user's behalf forever, unattended. Before creating one, make sure the user
  actually asked for something *recurring* (they said "every…", "each…", "from
  now on…", "remind me…"), and that the schedule and instruction match what they
  meant. A one-off task is not an automation — just do it now.
- **Search your existing automations first.** `automation_list` before creating
  — don't add a second near-duplicate of a job that already exists; edit the
  existing one instead.
- **Don't stack many heavy jobs on the same tick** — three run at once; the
  rest queue behind them. Spread them out, or combine them into one
  instruction.
- **Memory compaction is not here.** The daily/weekly memory consolidation jobs
  are configured in Settings → Hippocampus → Compaction, not in this file, and
  won't appear in `automation_list`.
