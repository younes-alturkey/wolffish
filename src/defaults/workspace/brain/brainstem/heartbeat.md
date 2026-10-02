# Heartbeat

Wolffish's autonomic schedule. Each `##` heading defines a scheduled job —
the heading IS the schedule, the body is the instruction. The brainstem parses
the headings, registers the jobs, and routes each body through the full agent
pipeline when the job fires.

The body is plain text (no markdown bullets needed). The agent receives it as a
user message and decides what tools to call. Heartbeat jobs **auto-approve** tool
calls that would normally need confirmation, and each run is a **sealed
conversation** visible in history.

Behavior worth knowing:
- **One at a time, queued.** Jobs never overlap; if one fires while another is
  running it waits in line and runs next — it's never dropped.
- **Missed runs catch up.** If the app was off when a job was due, it runs once
  on the next launch — collapsed (a recurring job that missed several fires runs
  a single catch-up), for misses within the last 24 hours.
- **One-time jobs self-delete.** A `Once (YYYY-MM-DD HH:MM)` heading fires a
  single time, then removes its own entry from this file.
- **Per-job mode.** An optional FIRST body line `mode: single` or
  `mode: workflow` picks how the job runs — `single` (one model, direct) or
  `workflow` (the run can plan phases and drive parallel agents). The line is
  stripped before the instruction reaches the agent. Without it, the job
  follows whatever chat mode is active when it fires. The Heartbeat page has
  a per-job toggle for this.

**Wolffish: manage these jobs with the `automation_*` tools, always.** Add,
reschedule, reword, pause or resume, delete, run one now, or work out why it
missed — that is list / create / edit (pausing and resuming are edit with
`enabled`) / delete / check / run, every time, no exceptions. The
tools validate the schedule, reload the scheduler live and keep the Automations
page in step; a change written straight into this file skips all of that, and the
next writer overwrites it. That's about the operation, not the file — reading this
file is encouraged, and editing it by hand is fine when the file itself is what
you're working on.

(From chat, this is also how you ask for it: "every morning at 8", "in 2 days
remind me", "turn that job off". The schedule forms are below.)

Memory compaction (daily and weekly) is configured separately in
Settings > Hippocampus > Compaction and is not part of this file.

---


<!--
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXAMPLES — Uncomment any heading + body block to activate it.
All times are 24-hour format and use the system's local timezone.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


── STARTUP ────────────────────────────────────────────────────────────
Runs once when the brainstem initializes. No cron — fires immediately
on startup then never again until the next restart.

## Startup

Check all connected integrations (Telegram, WhatsApp, email) and
report any that failed to initialize. Summarize status in a short
memo to memory.


── ONE-TIME ───────────────────────────────────────────────────────────
Fires a single time at an absolute local date-time, then deletes its own
entry from this file. Format: Once (<YYYY-MM-DD> <HH>:<MM>)
When asking Wolffish, you can also say "in 15 minutes" / "in 2 hours" /
"in 2 days" — it converts that to an absolute Once for you. (The relative
"In (…)" form isn't hand-writable here, since it couldn't survive a restart.)

## Once (2026-12-31 23:30)

Wish me a happy new year and give me a short recap of my biggest wins
this year, drawn from my episodes and knowledge files.


── EVERY (MINUTES) ────────────────────────────────────────────────────
Runs on a repeating interval of N minutes.
Format: Every (<number>m)

## Every (5m)

Check all of my emails inboxes for new messages. If any arrived in the last 5
minutes, triage them by urgency and draft replies for anything
marked critical.

## Every (15m)

Poll the deployment pipeline. If any stage is stuck or failed,
summarize the failure and notify me.


── EVERY (HOURS) ──────────────────────────────────────────────────────
Runs on a repeating interval of N hours.
Format: Every (<number>h)

## Every (2h)

Scan open pull requests for stale reviews. If any PR has been
waiting for review longer than 24 hours, bump the reviewer with
a polite reminder.

## Every (6h)

Check system resource usage (CPU, memory, disk). If any metric
exceeds 85%, log a warning and suggest cleanup actions.


── HOURLY ─────────────────────────────────────────────────────────────
Runs once per hour at the specified minute mark.
Format: Hourly (<mm>)    — colon is optional.

## Hourly (00)

Fetch the latest news headlines relevant to my industry and save
a brief digest to today's daily log.

## Hourly (30)

Check my calendar for any meetings starting in the next 30 minutes.
If one exists, prepare a brief with attendee context and agenda.


── DAILY / NIGHTLY ────────────────────────────────────────────────────
Runs once per day at the specified time. "Daily" and "Nightly" are
interchangeable — both map to the same schedule kind.
Format: Daily (<HH>:<MM>) or Nightly (<HH>:<MM>)

Several times a day is ONE heading — list the times with commas:
Daily (08:00, 14:00, 20:00). The times need not share a minute.

The first example also shows the optional per-job mode line: as the FIRST
body line, `mode: workflow` runs the job as a multi-agent workflow and
`mode: single` as a plain single-model turn. Any job form can carry it;
omit it to follow the current chat mode.

## Daily (08:00)

mode: workflow

Good morning routine. Summarize overnight messages, list today's
calendar events, and highlight the top 3 priorities from my task
list.

## Daily (13:00)

Midday checkpoint. Review progress on today's priorities. If any
task is blocked, suggest next steps or escalation paths.

## Nightly (23:00)

End-of-day wrap-up. Compile what was accomplished today, what
rolled over, and draft tomorrow's priority list. Save to the
daily log.

## Daily (08:00, 14:00, 20:00)

Three times a day: sweep the inbox and flag anything that needs
a reply before the next sweep.


── WEEKDAY ────────────────────────────────────────────────────────────
Runs Monday through Friday at the specified time. Does not fire
on Saturday or Sunday.
Format: Weekday (<HH>:<MM>)    — or a comma list: Weekday (09:00, 17:00)

## Weekday (09:00)

Standup prep. Summarize what I did yesterday, what's planned for
today, and list any blockers. Format as a standup update ready
to paste.

## Weekday (17:00)

End-of-workday review. Check if any Slack threads or emails need
a response before I sign off. Flag anything urgent.


── WEEKLY ─────────────────────────────────────────────────────────────
Runs once per week on the specified day and time.
Format: Weekly (<DayName> <HH>:<MM>)
Days: Sunday, Monday, Tuesday, Wednesday, Thursday, Friday, Saturday
(case-insensitive; Sun, Mon, Tue, Wed, Thu, Fri, Sat also work)

Several days a week is ONE heading — list the days with commas:
Weekly (Monday, Wednesday, Friday 09:00). Times can be a list too:
every listed day runs at every listed time.

## Weekly (Monday 09:30)

Weekly planning. Review the backlog, identify the top priorities
for this week, and draft a plan broken into daily goals.

## Weekly (Friday 16:00)

Weekly retrospective. Summarize what shipped this week, what
slipped, and any lessons learned. Save to the weekly log.

## Weekly (Sunday 20:00)

Prepare for the week ahead. Review next week's calendar for
conflicts, check deadlines, and pre-read materials for Monday
meetings.

## Weekly (Monday, Wednesday, Friday 09:00)

Three times a week: check competitor updates and summarize any
notable changes in their public offerings.


── MONTHLY ────────────────────────────────────────────────────────────
Runs once per month on the specified day at the specified time.
Format: Monthly (<DD> <HH>:<MM>)    — DD is day of month (1–31).

Several days a month is ONE heading — list the days with commas:
Monthly (1, 15 09:00). Keep days within 1–28 so no month is skipped.

## Monthly (1 09:00)

First of the month review. Compile last month's metrics —
tasks completed, messages handled, response times. Generate
a one-page summary and save to the monthly archive.

## Monthly (15 10:00)

Mid-month checkpoint. Review progress against monthly goals.
If any goal is at risk, suggest corrective actions or scope
adjustments.


── CRON (RAW EXPRESSION) ──────────────────────────────────────────────
For advanced scheduling not covered above. Uses standard 5-field
cron syntax: <minute> <hour> <day-of-month> <month> <day-of-week>
Format: Cron (<expression>)    — join several with ";" to combine them

## Cron (0 9 * * 1,3,5)

Run on Monday, Wednesday, and Friday at 09:00. Check competitor
updates and summarize any notable changes in their public
offerings.

## Cron (0 */4 * * *)

Run every 4 hours (at :00). Health-check all active background
processes and long-running jobs. Restart any that have stalled.

## Cron (30 8 1-7 * 1)

Run at 08:30 on the first Monday of every month (day 1–7 AND
Monday). Generate the monthly team report and prepare it for
review.

## Cron (0 12 * * 0)

Run at noon every Sunday. Archive completed tasks from the past
week and clean up stale drafts older than 7 days.

-->
