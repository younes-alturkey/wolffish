---
name: utilities
description: Small built-in utility tools that don't belong to a bigger capability — delivering files to the user as attachments, and pushing openable folder/file location cards.
triggers:
  - send file
  - send the file
  - attach
  - attachment
  - deliver file
  - share file
  - upload file
  - here is the file
  - here's the file
  - open folder
  - open the folder
  - reveal in finder
  - show in finder
  - show the folder
tools:
  - name: send_file
    readOnly: true
    description: "Deliver a file to the user as a downloadable attachment in the conversation they are talking to you in — it renders in the in-app chat and the CLI, and is uploaded/sent natively on WhatsApp and Telegram. Works for ANY file type (documents, images, audio, video, archives, code, text, etc.). THIS IS THE ONLY WAY A FILE REACHES THE USER: no tool auto-delivers its output, so every file you create, convert, edit, or download for the user MUST be sent with this call once the work is done. Never end a task by just naming a saved path. No size limit in-app or in the CLI; WhatsApp and Telegram refuse files over their own upload ceilings and tell the user where the file is. Pass the file path — absolute, ~/-relative, or workspace-relative."
    parameters:
      file:
        type: string
        description: "Path to the file to deliver. Absolute (/Users/you/report.pdf), home-relative (~/Desktop/report.pdf), or workspace-relative (files/report.pdf)."
        required: true
  - name: show_path
    readOnly: true
    description: "Push an openable location card for a folder or file on disk into the in-app chat: a folder gets an Open button (opens it in the OS file manager), a file gets a Reveal button (opens its folder with the file selected, like Reveal in Finder). Use it whenever the user would want to jump to a location — a folder you created or organized, a batch of outputs, a file deliberately left in place instead of sent. The path must exist. In-app desktop chat only — on WhatsApp/Telegram nothing renders, so name the path in prose there instead."
    parameters:
      path:
        type: string
        description: "Folder or file to show. Absolute (/Users/you/Projects), home-relative (~/Downloads), or workspace-relative (files/)."
        required: true
  - name: wait
    readOnly: true
    description: >-
      Pause this turn for as long as you need, then carry on exactly where you left off.
      NO MAXIMUM — ten seconds or four hours, you decide; ask for the wait the job actually
      needs and never chop one long wait into a poll loop. While it runs the chat shows a card
      with your reason, a countdown to the moment you will wake, and a box the user can type
      into to end the wait early; anything they send from anywhere (that box, the composer,
      their phone, Telegram, WhatsApp) wakes you at once and arrives as their next message.
      USE IT whenever the next step is simply not possible yet and WILL be after some time has
      passed, and you intend to finish the job yourself in this same turn: a build, deploy,
      render, upload or scan you kicked off and must let run; a rate limit or cooldown to ride
      out; a page, inbox, feed or file you must re-check after a while; anything the user asked
      you to do "in a bit", "after N minutes", or "once that finishes". This is the ONLY way to
      pause and keep everything — the conversation, the files you opened, what you already
      worked out, the rest of your plan. PREFER IT over shell sleep commands (they show the user
      nothing and cannot be interrupted), over polling the same tool over and over, and over
      telling the user you will come back later. DO NOT use it to look busy, to pad a reply, or
      before an action you could take right now. TWO THINGS THIS IS NOT: (1) an action that must
      land AFTER your reply is sent — restarting or quitting something, anything that would cut
      off the message announcing it — use countdown_start; (2) a job for hours or days from now,
      or one you can hand over in writing — use automation_create with a one-time schedule
      ("In (2h)", "Once (...)"): it starts a fresh run later that begins with only what you wrote
      into its instruction, so spell that out self-contained (it can look up earlier runs and past
      conversations once it is running). Between those two: if what you would have to hand over is
      a whole working state you already have here, wait; if a paragraph covers it, schedule it and
      free this turn.
    parameters:
      reason:
        type: string
        description: >-
          Why you are waiting, in one short line the user will read as the card's title — e.g.
          "Letting the deploy finish", "Waiting out the API cooldown", "Giving the render 10
          minutes". Required: a pause with no explanation is indistinguishable from a hang.
        required: true
      seconds:
        type: number
        description: >-
          How long to wait, in seconds. No maximum. Pass the duration in ONE unit — seconds,
          minutes or hours — never the same duration restated in two of them. Several DIFFERENT
          units add up, so use that only for a composite like hours 1 + minutes 30.
      minutes:
        type: number
        description: "How long to wait, in minutes, instead of seconds. Adds to hours for a composite duration."
      hours:
        type: number
        description: "How long to wait, in hours, instead of seconds. Adds to minutes for a composite duration."
---

# Utilities

A grab-bag of small, always-available helpers that are too small to each be
their own capability. Add new general-purpose utility tools here rather than
spinning up a new capability for every one-off.

## `send_file` — deliver a file to the user

Use `send_file` to actually hand a file to the user inside the conversation. Saving a
file to disk and telling the user "saved to …/files/report.pdf" is **not** delivery —
on WhatsApp and Telegram the user never sees the file, and even in the app the path is
not the file. `send_file` closes that gap on every channel at once.

### When to call it — the default, every time

Call `send_file` for **any** file you created, edited, converted, downloaded, or saved — a
Python/PIL image edit, an ImageMagick call, a shell/script output, a download, a file saved
outside the workspace (the Desktop, etc.), a pre-existing file the user asked for. Deliver it as
the last real step, then write your short wrap-up. A file the user can't see is a failed task —
**when in doubt, send it.**

**Re-deliver every version when the user is iterating.** If they're refining a file — you edit,
regenerate, "make it red", "now orange" — call `send_file` on the **updated** file each time,
even if you delivered a file at that same path in an earlier turn. Each new version is a new
result the user must see. A new turn, a different file, or an edited version always gets sent.

**Chart cards.** A file whose name ends in `.chart.json` is a chart spec: `send_file` delivers
it as an interactive chart card in the in-app chat (on WhatsApp/Telegram it arrives as a plain
document, so prefer a text table there). The spec format and when to chart live in the core
`dataviz` tool's manual — call `dataviz` before authoring one.

### When NOT to call it — almost never

NOTHING auto-attaches anymore: no generation tool (pdf, browser_pdf, ffmpeg, image/meme
generation, shell `open`) delivers its own output. If you don't call `send_file`, the user
receives nothing — on every channel. The only reasons to skip it: (1) you already sent this
exact file this turn (the runtime status lists your sends), or (2) the user explicitly asked
for the file to be placed somewhere without delivery — and if you're merely unsure, ASK
whether they want it sent rather than silently withholding it.

### Notes

- Pass any path: absolute, `~/`-relative, or workspace-relative. Files outside the
  workspace are copied into `files/` automatically so the in-app viewer can load them.
- No size limit in the in-app chat or the CLI — both read the file straight off local disk.
  WhatsApp and Telegram enforce their own upload ceilings: an oversized video is re-encoded
  to fit, anything else is refused with its path so you can tell the user where it lives.

## `show_path` — push an openable location card

`show_path` renders a card in the in-app chat with the folder/file name, its path, and a
button: **Open** for a folder (opens it in the OS file manager) or **Reveal** for a file
(opens its parent folder with the file selected). Nothing is parsed from your prose —
this card exists ONLY when you call the tool, so call it whenever the user would want to
jump to a location:

- You created or organized a **folder** (a project scaffold, a sorted Downloads, a batch
  of outputs) — folders can't be attached with `send_file`, so this card IS their delivery.
- You placed a file at a user-named spot instead of sending it, or a file is too large for
  `send_file` — show where it lives.

The path must exist — the call fails on a typo or a not-yet-created path. **In-app desktop
chat only**: on WhatsApp/Telegram the card doesn't render (there's no desktop to open), so
name the path in prose there instead. `show_path` complements `send_file`, never replaces
it — a deliverable FILE still gets `send_file`.
