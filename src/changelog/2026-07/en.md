## v1.0.232 — 2026-07-27

### Settings Tabs That Say What They Hold

Two tabs in settings were named after parts of a brain rather than after anything you would go looking for. **Cellebrum** — the page listing every skill, plugin, and tool Wolffish can call on — is now **Capabilities**, and **Hippocampus**, where the memory compaction schedule lives, is now **Knowledge**. The pages themselves are unchanged down to the last switch; only the words you navigate by have moved into plain English, so finding the place where you import a skill no longer depends on knowing which lobe the developer had in mind. The **Data** page follows suit — its storage breakdown now reports what memory costs you under **Knowledge** — and the import panel drops its instruction to add skills "to the Cellebrum" in favour of simply **adding them here**. Wolffish's inner workings keep their anatomical names; what changed is the labels you actually click.

### Room at the Bottom of the Conversations List

Scroll to the end of the **Conversations** page and the last row stopped flush against the window's edge, close enough to look cut off rather than finished. The list now **keeps a margin of space past its final row**, so the bottom of a long scroll reads as the bottom.

## v1.0.231 — 2026-07-25

### Find a Conversation by When It Happened

Every conversation list was one long stack sorted newest-first — which reads perfectly down to about the twentieth row and not at all after that, where finding last Tuesday's chat meant scrolling and squinting at "5 days ago" stamps. All three lists — the **right-hand rail**, the **Conversations page**, and a **project's conversation list** — now break themselves into **dated groups**: **Today**, **Yesterday**, **Previous 7 days**, **Previous 30 days**, then **Previous 3 months**, **Previous 6 months**, **Previous year**, and **Older**. The windows **widen as they recede**, deliberately — recent work is the kind you look for by its exact day, older work by roughly its era — so the list stays scannable however far back it runs. A heading only appears when something sits under it, and the **numbered chips keep counting straight through** those headings, so a conversation's number is still its place in the whole list rather than its place in one group. The **collapsed rail** keeps its chips-only look and marks each boundary with a **thin rule** instead of a heading. Groups are cut on **calendar days**, so something from eleven last night reads as **Yesterday** rather than falling inside a rolling twenty-four hours.

## v1.0.230 — 2026-07-25

### Zoom Into What You're Looking At

An image in a conversation opened big and stopped there — a screenshot with small print, a diagram with the one label you needed, and no way past whatever the screen happened to give you. The expanded view now **zooms to your cursor**: scroll and the pixel under the pointer stays exactly where it is, up to **eight times** in, then **drag to pan** around what you've magnified. A small toolbar carries the **live percentage** with zoom in, zoom out, and a press to snap back; `+`, `-`, and `0` do the same from the keyboard, and a **double-click** jumps in or back out. **Videos got the same surface** — a new expand button opens the player there, sized to **the picture's real shape** rather than an assumed widescreen, native controls and all. **PDFs expand too**, to a full 80% of the window, where the built-in viewer keeps its own scrolling and paging. Escape or a click outside closes any of them, and a drag that happens to end outside the frame no longer counts as that click.

### One Conversation, One Story, Whichever List You Read It In

The right-hand rail, the **History** page, and a project's conversation list each had their own idea of what to show, and only the rail was genuinely live. All three now share **one definition**, so a conversation reads identically wherever you meet it — and each of them **keeps up on its own**. Start a chat in the app, message from **WhatsApp or Telegram**, or let an **automation or a saved procedure** open one: the row appears **the moment its first turn starts**, carrying the same **pulsing chip**, instead of surfacing only once the work was already over. On the **Projects** page the **conversation counts and "last used" stamps** used to freeze the instant the page loaded — a reply arriving while you sat looking at it changed nothing on screen — and they **refresh themselves live** now. The small **source emoji** on a numbered chip, a project's icon or an automation's, used to appear only after a full re-index; it's there from the start.

### Report a Bug Without Opening the Conversation First

The **bug button** that packs up everything about a conversation that went wrong was reachable only from inside that conversation — which meant reopening it, and on the History page that's most of them. Every row there now carries **its own bug button**, so you can hand over a bundle for a conversation you aren't in. It rests for the chat you currently have open, because the composer's own button belongs to that one, and for a conversation whose very first turn is still running, which has nothing saved yet to collect. The export itself got steadier in three places: the collecting screen no longer **spins forever over an archive that already landed** — switching away and back was enough to cause it — returning to a run **already in flight now attaches to it** instead of reporting failure for work that was about to succeed, and the optional step that **asks the model what it thinks went wrong** gives up after ninety seconds, so a stalled provider costs the bundle one section rather than the whole export.

### Point at a Folder Mid-Answer

Handing Wolffish a **working folder** was locked the moment it started answering: the button went grey, and the folder you wanted it to look in had to wait for the turn to end. Adding one is **live now**, exactly like attaching a file or recording a take — the folder rides your **next queued message** rather than the running one. **Removing** a folder is still held while a turn is going, and deliberately so: the agent may be reading files in there this second, and the delete button says as much when you hover it.

### Windows: PDF Tools and Shell Commands, Unstuck

Two Windows-only faults, both of which looked like nothing was wrong at all. **Every PDF tool** — reading, searching, rendering a page — failed on its very first call, because a file path was assembled with the platform's own separator where the PDF engine insists on one particular character. The identical code was perfectly healthy on macOS and Linux, which is exactly why it stayed hidden. And a **shell command** that printed anything to the error stream — which is how `npm`, `git`, `pip`, and `ffmpeg` report ordinary progress — could be **reported as failed when it had fully succeeded**, its real output buried under error noise, whenever a stray `2>&1` was appended out of habit. That redirect never bought anything here, since both streams already come back together, so it's now **dropped before the command runs** and written down so the habit stops.

### The Project Dialog Stops Shifting Under You

Adding a file to a project moved everything below it twice — once when the progress bar appeared, again when that bar gave way to the finished file's row. The progress card and the file list now **share one shell and one row height**, so the block claims its space once and simply keeps it. And the **copy button** on a project's standing instructions used to sit parked over the first line the entire time you were writing; it now **appears when you hover** the block, like every other code block in the app.

## v1.0.229 — 2026-07-25

### One Button Packs Up Everything That Went Wrong

When a conversation goes sideways, explaining it to the developer used to be your job — which log, which file, which prompt, and where on earth any of them live. A new **bug button** sits beside the export button in every chat and does the whole errand for you: one press bundles **that conversation and nothing else** — the transcript, the event log for the days it spans plus a slice filtered down to its own turns, the **records of every task it spawned**, the **memory** the agent was working from, the **prompts and instructions** it actually built, and your **settings** — into a single zip you can forward as it is. Two things stay out on purpose: **every credential is redacted**, replaced by a length marker and never the value, and **attachment media is left behind**, so the archive is safe to hand over and small enough to send. On a cloud model it also asks **the model itself what it thinks went wrong** and tucks that opinion into the bundle. A card at the end lists what went in, and **reveals the archive** or **saves a copy** wherever you want it.

### Big Files Say So While They Copy

Attach something large — a video, a hefty PDF, a folder-sized archive — and the composer used to sit **completely blank** while it was copied into Wolffish, until the chip simply appeared seconds or minutes later with nothing in between to say anything was happening. Every file you pick, drop, or paste now **claims its chip the instant you choose it**, carrying a **filling ring and a live percentage** counting real bytes, and hands over to the finished attachment the moment those bytes land. **Send waits for them** — the button rests, the Enter key is caught too, and a tooltip says why — because a message sent mid-copy would have quietly gone without the file. Stopping a running turn is never blocked. **Project files** got the same treatment: adding files to a project draws **one bar across the whole batch**, tells you **which file of how many** is moving, and holds the Add files button until the copy is done.

### Record While It's Still Working

The microphone used to go dark the moment Wolffish started answering — a thought you wanted to record had to wait for the turn to end, and remembering to come back to it was your problem. **Recording stays live now**, exactly like attaching. Start a take mid-answer and it **waits in the row above the composer**, with a **play button and its length** so you can hear it back before it goes, and it **sends itself the moment the turn finishes** — uploaded, transcribed, and answered in its proper place in the queue. Discard it instead and the recording is dropped for good, along with the audio it was holding.

### Show Me the Figure

Ask about a diagram, chart, algorithm, or table inside a PDF and Wolffish could only ever read you the words around it. It can **render the page itself as an image** now — the figure exactly as printed, at whatever zoom the small print calls for — and send that straight into the conversation. This is the fix for a quiet failure: a textbook figure is usually **drawn, not stored**, so there is no picture inside the file to pull out and the old image extraction correctly came back with nothing. Extraction itself got sharper too — it now works on **the pages you name** rather than the entire book, and **skips the tiny fragments** (glyphs, rules, bullets) that used to bury the one figure you wanted under thousands of unusable files.

## v1.0.228 — 2026-07-24

### Workflow Mode, Working Again

Put Wolffish in **workflow mode** — where it splits a big task into slices and runs them across **parallel agents it steers itself** — and in the previous version the delegation quietly never happened: the tools it uses to **plan phases, spawn agents, and gather their results had failed to load**, so the mode fell back to working alone with no hint of why. The cause was a tiny formatting slip in an internal file; it's **fixed**, and workflow mode plans, delegates, and collects work the way it should again.

### Core Capabilities Can't Be Switched Off by Accident

Wolffish's settings let you turn individual capabilities on and off — but a handful are **load-bearing**: the workflow engine, your secrets, skills, projects, automations, procedures, and the shared tools the rest leans on. Those now wear a **"Core" badge**, **settle at the bottom of the list** out of your way, and **can no longer be turned off** — a locked **"Always on"** marker sits where their switch used to be. Everything you added yourself stays exactly as toggleable as before; only the essentials are protected, so a stray click can't quietly pull the floor out from under a feature you depend on.

## v1.0.227 — 2026-07-24

### Nothing You Send Has to Be Resent

Message Wolffish from **Telegram or WhatsApp** while it's still working on the last thing you asked, and it used to bounce back a polite "hold on, I'm busy" — the message was never kept, and remembering to type it again was your problem. It's **queued** now, exactly like the in-app composer: a reply confirms it landed and tells you **where it sits in line**, and it runs on its own turn the moment the current task finishes, **in the order you sent it**. Files and voice notes queue with it — they're **downloaded and transcribed the instant they arrive**, so nothing goes stale while it waits. Two commands keep you in charge: **`/cancel`** drops everything waiting and leaves the running task alone, while **`/stop`** stops the run and lets the queue carry on — and `/stop` now tells you how many messages are lined up behind it. Starting or switching conversations — `/new`, `/resume`, `/delete`, a project switch — **clears the queue along with it** and says so out loud, because a message typed into one conversation should never land in another. One habit to unlearn: on Telegram `/cancel` used to be another name for `/stop`, and it has a job of its own now.

### The Chat on Your Phone, Live on Your Desk

Open a conversation the app doesn't own — one **Telegram or WhatsApp is answering right now**, or an automation is working through — and it used to look finished and idle: a composer ready to send, no sign anything was happening, and the entire reply landing in one lump when the run ended. It **reads as live now**. The reply **streams into the feed as it's written**, a working bubble stands in until the first words arrive, and the app knows a run is in flight **even if you opened the window in the middle of one**. The chrome follows suit: the **Stop button genuinely stops it**, whichever device started it, and a message you type mid-run **queues and sends itself** the moment that run lands — one conversation, one order of events, no matter where the turn came from.

### A Stuck Agent Says So

In workflow mode, a delegated agent that got stuck — re-issuing the **same tool call over and over** with nothing to show for it — used to be invisible. The master sat blocked waiting for a result that was never coming, and a run could burn a long time before anyone noticed. Both ends are told now. The spinning agent gets a **note in its own feed** that it's repeating itself and should wrap up with whatever it has, and the master is **woken out of its wait** with the agent's name, the call it keeps making, and how many times — then decides for itself: **wait a little longer** for partial findings, or **cancel it** and cover that slice another way. Nothing is capped and nothing is killed automatically — the decision stays where it belongs.

### Memory Compaction Shows Its Work

Wolffish tidies its own memory on a **daily and weekly** schedule, and until now it did that entirely out of sight — you could see the schedule, never the result. The compaction settings now carry a **card for each job's last real run**: **when it ran**, **how long it took**, the **tokens in and out**, and **the output it actually produced**. Skipped or failed passes never overwrite a card, so what you're reading is always the last pass that did something — and its timestamp stays honest about how long ago that was. The **background side-calls got quicker** too: naming a conversation and writing a summary are quick utility jobs, so they now run **with reasoning off** on your configured Brain, whatever reasoning level you've picked for chat.

## v1.0.226 — 2026-07-23

### Low on Disk? Warned, Not Walled

Launching Wolffish with less than **5 GB free** used to mean a locked door — the low-space screen had no way past it short of actually deleting files. It's a **warning** now, not a wall: a new **"Continue anyway"** button closes it and takes you straight to your usual screen, with a plain note on what you're signing up for — with space that tight, **models, saves, and downloads can fail** until room is freed. The choice is yours, and it lasts exactly one sitting: the warning still greets **every launch** while the disk stays low. **Recalculate** learned to answer out loud, too — every re-check now ends in a toast, a green **"enough to continue"** with the exact free amount when you've cleared the bar, the familiar still-low warning when you haven't.

### One Arabic Label, Mended

A garbled character had crept into the Arabic label for **recording a voice note** — broken replacement marks sat in the middle of the phrase. It reads **«تسجيل رسالة صوتية»** again, as it should.

## v1.0.225 — 2026-07-22

### Background Runs Stop Taking Over

When an automation fired, the whole app used to step aside — a full-screen "chat is paused" takeover you could only watch until the run ended. That's gone. A background run now surfaces as a **floating live card** pinned quietly over the top of the screen: pulsing icon, the job's name and mode, and a **live feed of what it's doing right now** — while the rest of Wolffish stays **fully usable**. Click the card and it expands into a **full activity panel**; press Escape or click away and it folds back to the card **without losing a line of history** — the run keeps going either way. Procedure runs deliberately stay out of sight — a saved prompt doing its job needs no stage — though a run that fails still raises a toast saying what broke.

### Three at Once, the Rest in Line

Background jobs used to run strictly one at a time — a slow nightly digest could make the whole schedule late. The engine now runs **up to three jobs side by side**, each with its own card, and everything past three **waits in a visible queue** — a row under the cards counts what's waiting and names it, and **nothing is ever dropped**: a queued job runs the moment a slot frees, and a job that fires while it's already running or waiting folds into the pending run instead of piling up copies. The Automations page plays along — a job that's currently running or queued shows a **note on its card**, and its play button rests until the run is done.

### An Edit Counts, Whoever Makes It

The "Edited" stamp on an automation card used to notice only edits made in the card editor itself — rewrite the file in the markdown view, ask Wolffish to retune a schedule, or touch it in an outside editor, and the stamp played dumb. The stamps now come **from the engine, which watches the file itself**: any hand that changes a job — the dialog, the markdown editor, **Wolffish's own tools**, an external editor, even a change made **while the app was closed** — stamps it, while merely switching a job on or off correctly counts for nothing. The pages caught up too: **Automations, Procedures, and Projects all refresh themselves live** when something changes under them — ask Wolffish mid-chat to add an automation and watch the card appear — and project cards now carry their own **"Edited"** time next to when they were last used. One small kindness in the card editor as well: the schedule field **no longer flashes red mid-keystroke** — it waits out your typing pause before calling a schedule wrong.

### Admin Rights Reach the Agents

Wolffish keeps one **saved admin session** per app run — you type your password into the system dialog once, and sudo commands authenticate app-side from then on. That session is now **genuinely app-wide**: workflow agents and scheduled runs — automations, procedures — elevate through the **same session as the chat**, so a delegated task that needs admin rights just runs instead of coming back with "this needs elevation." Agents are told as much, too: sudo is not a blocker, run the command, and only a real "operation not permitted" from the system counts as one.

## v1.0.224 — 2026-07-22

### Projects: A Standing Brief for Your Work

Some work isn't a conversation — it's a dozen conversations sharing one context: the same instructions repeated, the same files re-attached, the same background re-explained. **Projects** give that work a home. A project is a **name, an emoji, standing instructions, and a set of files**; every conversation inside it starts already briefed — the instructions ride each turn, and the files are known by name and read on demand rather than stuffed into context. Create and tend them on the new **Projects page**; in the chat, **hovering the new-conversation button fans out your projects** so a chat starts inside one from the very first word, and the sidebar and History **group and badge** every conversation under its project. Saved procedures and scheduled automations can be **bound to a project** too — their runs land under it, briefed like everything else. From your phone, **`/project`** on WhatsApp and Telegram lists your projects by number: pick one to start a conversation inside it, `/project close` to leave — and `/new` inside a project deliberately stays inside it. Wolffish itself got the same hands: **eight `project_*` tools** let you build and stock a whole project by just asking for it.

### Files the Size of Books

Hand Wolffish a huge file — a 3,000-page PDF, an hour of audio, a giant spreadsheet — and the old pipeline would try to **swallow it whole into the model's context**, which meant freezing, choking, or a flat refusal at an arbitrary size cap. That pipeline is gone. **No attachment content is ever injected automatically now.** Every file becomes a compact **reference note** — name, location, and real facts, like a page count probed lazily from the PDF's own index even when the file is enormous — and Wolffish **reads on demand**: `pdf_info`, `pdf_search`, and a cached `pdf_read` dig through thousand-page documents a page range at a time; `file_read` streams any slice of a giant text file; and vision models **pull an image's pixels only when they actually look**, with `image_view`. The arbitrary gates fell with it — the **100 MB** document and spreadsheet caps and the **500 MB** audio cap are gone. And because a deep read of a big file takes real time, Wolffish now **narrates it**: what it's about to extract, what each round turned up — no more minutes of silence that read like a hang.

### Automations, Now With Faces

The Automations page has been **rebuilt around cards**: each job is a card wearing **an emoji of its own** — 📧 for the inbox sweep, 📰 for the news digest — with its schedule and instruction in plain view, and the raw markdown file one click away for the purists. Editing happens in a proper **dialog**: schedule **chips** for daily, weekly, monthly, intervals, and full cron, a real **time input**, and a live **next-run preview** that shows exactly when the job will fire *before* you save. The emoji isn't decoration, either — an automation **stamps its icon on every conversation its runs create**, so the sidebar tells you at a glance which job an overnight run belongs to. **Procedures got the same treatment** — an emoji per procedure, stamped on its runs — and both can be **bound to a project**.

### Several Questions, One Card

When Wolffish needs more than one decision from you, it used to mean a chain of question cards, each waiting on the last. `ask_user` now takes **a list of questions**: in the app they arrive as **one card with chip tabs** — flip through, answer everything, and it resolves in a single reply. On WhatsApp and Telegram the same request walks you through the questions **one message at a time, in order**, collecting every answer before the work continues. Quizzes run through it now too: **all the questions in one card, graded and explained afterward** — never again a quiz pasted as text with the answers hiding a scroll below.

### Replies That Fold

Chat replies can now use a careful slice of real HTML: **collapsible sections** with a clickable summary — long appendices folded politely out of the way — plus **highlighted text**, keyboard keys like `Ctrl`+`C`, and proper sub- and superscripts. It's a **sanitized** subset: scripts, styles, frames, and event handlers are stripped outright, and an unknown tag degrades to its text instead of breaking the message. The **PDF export renders the exact same subset**, so an exported conversation shows what the feed showed.

### A Card That Opens the Folder

When the deliverable is a **place** rather than an attachable file — a folder Wolffish scaffolded, a sorted Downloads, a batch of outputs, a file deliberately left where you asked — it now pushes a **location card**: a folder gets an **Open** button straight into your file manager, a file gets **Reveal**, opening its folder with the file selected. The old behavior tried to **guess paths out of prose** and drew cards for whatever looked path-shaped — sometimes wrong, sometimes missing, never intentional. That guessing is deleted: a card exists now exactly **because Wolffish chose to hand you the place**, through a real tool with a checked, existing path.

## v1.0.223 — 2026-07-19

### Keep Typing While Wolffish Works

The composer used to lock the moment a turn started — grayed out, nothing to do but watch. Now it stays open the whole time: type your next message mid-run and Enter **queues it in a tidy row above the composer**, where it waits its turn and **sends itself the moment the current run ends**. Queue several and they go out one by one, in order — and one click removes a waiting message you've thought better of before it ever sends. Attachments keep pace: **the attach button, drag-and-drop, and paste all stay live during a run**, and staged files ride out with the queued message instead of interrupting the running one. Stopping a run counts as ending it, so **Stop advances the queue too** — your queued follow-up steps straight into the room the stop just made.

### A Zoom That Fits the Picture

Clicking an image to see it big used to open a general-purpose dialog — the picture floating in a titled box, with **empty bars** wherever its shape and the box's disagreed. The zoom is now a proper lightbox: a clean overlay whose **frame hugs the image's exact proportions**, growing it until it reaches 80% of the window on whichever edge gets there first — no title bar, no letterboxing, just the picture. A click anywhere outside it — or Escape — dismisses it. The same lightbox serves **both the chat and the workspace file viewer**, so an image reads the same wherever you meet it.

## v1.0.222 — 2026-07-19

### Your Spending, Added Up For You

The Usage panel always knew what every call cost — it just left the adding to you, one provider card at a time. A new **Costs** section now does the arithmetic for the range you're viewing: **Total Spend**, **Top Day Spend** with the date it happened, and your **Daily Average** across the days you actually used Wolffish. The total **counts Brave search fees too**, so it genuinely equals the sum of the cards below it instead of quietly dropping the one paid service that isn't a model. The stats above got a proper **Overview** heading to sit under, and the new cards **load under the same skeletons** as everything else, so the panel doesn't jump when the figures land.

## v1.0.221 — 2026-07-17

### Kimi K3, a Million Tokens Wide

Moonshot's new flagship **Kimi K3** is supported in full from day one: a **million-token context window**, room for **131K tokens of output**, **vision**, and its new three-step reasoning dial — **off, high, or max** — on the same brain button every other model uses. Turning it off genuinely turns it off, something Moonshot's own docs say K3 can't do — Wolffish verified it against the live API rather than take the manual's word. K3 is now the Kimi provider's **default model**, priced correctly in Usage down to the cached-token discount, and reachable through OpenRouter as well. Sight, it turns out, doesn't begin at K3 either: **everything from k2.5 onward is natively multimodal** with nothing in the name to say so, so images now flow to k2.5, k2.6, and the k2.7 code models instead of being quietly stripped as text-only. And the model picker stopped burying the flagship — Moonshot stamps its whole catalog with one shared release date, which left the list in arbitrary API order; it now reads **newest first**.

### One Conversation, Two Writers, Nothing Lost

Last release made every conversation continuable anywhere — which means a conversation can now be **written from two places at once**: a Telegram message landing while the same thread runs a turn in the app. The persistence underneath has been rebuilt for exactly that. **Every message now carries a permanent identity**, and when two copies of a transcript meet on disk they **merge message by message** — both sides' additions survive, in order — instead of whoever saves last winning wholesale. The rolling summary is pinned to the precise message where its coverage ends, so a message merged in ahead of it can no longer silently shift what the summary claims to cover. A window holding a stale copy of a conversation **can no longer save it back over a finished turn**, either — that exact loss happened once, and both the window and the disk now refuse any save that would shrink history. Existing conversations pick up their identities **on first launch, invisibly**.

### "Try Again" Picks Up Where It Broke

When a provider dies mid-turn — overloaded, timing out, erroring — the red card in the chat now carries a **Try again** button. One click **continues the conversation from the break**: Wolffish is told what failed, checks what already completed — files written, tool results in hand, plans made — and **carries on without redoing finished work**, instead of you retyping the request and watching the whole task start over from nothing.

### The Meter Knows What Each Agent Spent

In workflow mode, the context meter's card used to fold every agent's spend into a single line. It now carries a **Workflow section — one row per agent**, each with its live status dot, its token count and cost, and a bar scaled against the run's biggest spender — with the run's totals underneath: tool calls, tokens, cost. Close the conversation and come back, and the section **restores with the rest of the meter** whenever the last turn was a workflow run.

### The Memory Index, Minding Its Manners

The one-time memory-index rebuild after an update takes over the chat screen — but the conversations rail kept **floating on top of the takeover**, and every open conversation drew **its own duplicate copy** of the overlay. It now renders once, at app level, and the rail steps aside exactly as it does for a running automation. The index's health warning calmed down too: "database growing large" used to trip at a size any established install sails past in normal use — the bar now sits **twenty times higher**, where crossing it actually means something.

### Settings That Say What They Mean

In the Arabic settings, `/resume` and `/delete` sat as raw left-to-right fragments in the middle of right-to-left sentences, breaking the line around them. They're now **proper command chips that hold their shape** inside Arabic text. And the verbose-toggle description on all three channels caught up with what the clean feed actually delivers — **replies and the files Wolffish sends, nothing else** — instead of still claiming errors ride along too.

## v1.0.220 — 2026-07-16

### Your Phone Conversations, Continued at Your Desk

A conversation that started on WhatsApp or Telegram — or one an automation ran overnight — used to open in the app as a **museum piece**: you could read it, and that was all, the composer replaced by a note telling you to go back to your phone. That restriction is gone. **Every conversation is a conversation now**, wherever it began: open a Telegram thread on your desktop and keep typing, pick up an automation's run and ask it the follow-up question, carry on a procedure's output with a real keyboard. A finished automation run **stops being a sealed record the moment you continue it**, so it summarizes and grows like any other chat instead of replaying its whole transcript forever. Voice notes survive the trip intact — a conversation continued in the app **hands its audio back untouched** rather than stripping what made it a voice note. And if a message lands on your phone while that same conversation sits open on your desk, **the new tail simply appears**.

### A `/resume` That Reaches Every Conversation

`/resume` used to offer ten conversations from the channel you typed it on, and nothing else. It now lists **every conversation Wolffish has** — Telegram, WhatsApp, in-app, automations, procedure runs — **newest first, twenty-five to a page**, with `next` for the page after that. Each row **says where it came from**, because a title alone can't tell you whether you're about to resume a phone chat or last night's automation. The numbering **runs continuously across pages** — item 26 opens page two, and a number you saw on page one still picks it after you've moved on — while a number you have **never actually been shown selects nothing at all**, which matters most for `/delete`, where the wrong pick is unrecoverable. Automations, which vastly outnumber real chats, are **kept out of `/resume` by default** — a new toggle in both channels' settings — while staying in `/delete` and in the app.

### Reply to Wolffish, Land Where You Meant To

When Wolffish messages you out of the blue — a heartbeat reporting a finished job, a conversation in the app dropping you a note — your reply used to land in **whatever conversation that chat happened to be sitting on**, arriving with no idea what it was answering. Now **sending to a channel points that chat at the conversation doing the sending**, so you reply and you're already in the right place. The idle clock restarts as part of it, too, so the very next thing you send **can't be bounced straight back out** by the staleness guard.

### The End of "Untitled"

Roughly **one in five Telegram conversations — and one in ten on WhatsApp — was stranded permanently as "Untitled."** The cause was a small, expensive accident: the naming call never had its reasoning mode set, so it silently defaulted to **high effort — every title was a full reasoning call**, thinking hard about five words. That ran long enough to blow the fifteen-second deadline, and a title that missed its deadline wrote **nothing at all** — leaving the placeholder on a chat that would never get another turn to fix it. Naming is **labelling, not reasoning**: the call now runs with thinking off, lands in about a second, and has thirty seconds it no longer needs. A title that somehow still runs late **degrades to a readable slice of your own message** instead of to nothing. The ones already stranded are **healed on launch**, deterministically, without a single model call. And a photo sent with no caption gets named too — from **the filename you sent**, which usually says plenty — on the two channels where "Untitled" would otherwise be forever.

### Every Conversation Wears Its Origin

The conversations rail and the History page now mark each conversation with **a small badge showing where it came from** — Telegram, WhatsApp, an automation, a procedure run. In-app chats stay unmarked: the app is the default, not a badge worth calling out.

### Arabic That Reads Like Arabic

Every size Wolffish shows you — a model's download, your workspace on disk, free space, transfer speed, the Whisper model sizes — was hardcoded English: **"1.5 GB" sitting there in the middle of an Arabic sentence**. All of it now reads natively. The bidirectional-text bug underneath is fixed as well: forcing left-to-right onto an Arabic size **tore each numeral away from its unit**, stranding "4.0" at the far end of the line from the words it belonged to. Hardware specs lost their false precision too — **"16 GB", not "16.0 GB"** — and a small model no longer rounds down to a meaningless "0 GB".

### Settings Numbers That Tell the Truth

The CPU figure in Data was **measuring its own homework**: it sampled while walking every file in your workspace to total the sizes, so an idle Wolffish reported **93% CPU when the truth was 0.3%**. It now samples once that walk is done. It was also reporting a share of **one** core, so a busy moment on a twelve-core machine read as a nonsense **141%** — it's now a share of your whole CPU, with a **"Less than 0.1%"** floor so a small real load reads as a small real load instead of a dead gauge. Usage, meanwhile, **paints the instant you open it** — every range warmed at launch — so the loading skeleton is gone from the panel you check most.

## v1.0.219 — 2026-07-14

### A Resume That Actually Sticks

On WhatsApp and Telegram, `/resume` swaps you back into an older conversation — but the idle-refresh guard didn't get the memo. That guard watches how long a conversation has sat untouched and, past the threshold, quietly starts you a fresh one; and a resumed conversation is, by definition, an old one. So the very next message you sent would trip the guard and **bounce you straight back out of the conversation you had just resumed** — a resume that undid itself, with a polite note suggesting you try `/resume`. Now picking a conversation to resume **restarts its idle clock on the spot**, so the guard sees it for what it is — a conversation you're actively continuing — and your next message lands exactly where you meant it to, on both channels alike.

## v1.0.218 — 2026-07-13

### Remote Connections That Take an API Key

Many remote MCP servers don't want a sign-in — they want a key: an `x-api-key`, a pre-issued token, an `Authorization` value copied from a dashboard. Until now Wolffish only spoke OAuth, so those servers sat forever on "requires sign-in" with nothing to click that could help. Now every remote connection has **Headers** — add them while creating the connection or any time after, right on its card — and they **ride every request**, so a server satisfied by its key **connects outright: no sign-in, no browser, nothing to approve**. Supply your own `Authorization` header and it owns the connection's auth completely — Wolffish steps its whole sign-in machinery aside so a stored token can never fight your key. And a connection stuck on "requires sign-in" doesn't need tearing down: **paste the fresh value, hit Save, and it reconnects on the spot**.

### Keys That Stay Off-Screen and On-Origin

Mark a header value **sensitive** and it renders masked in settings, with an eye to peek — a display courtesy for shared screens; the value itself is stored in plain text like the rest of Wolffish's credentials. Two quieter guards work underneath. Validation catches the junk that breaks connections mysteriously — **the invisible characters that ride along with a pasted token**, line breaks, duplicate names — before anything is saved, instead of letting it fail deep inside the connection with no visible reason. And headers are **pinned to the server's own address**: whatever other hosts the sign-in machinery may consult along the way, your key is never sent anywhere but the server it belongs to.

## v1.0.217 — 2026-07-12

### The Drawn Divider Line, Banished From Your Phone

Wolffish loved decorating channel reports with horizontal rules — a ━━━━━ over the summary, a ═════ under the verdict. On a phone those lines are a trap: the narrow chat bubble **wraps every long bar into several broken lines of stray characters**, turning a tidy report into rubble — and because a divider is perfectly valid text, every format check so far stamped it "valid" and let it through (a security-audit report reached Telegram exactly this way). Both channels now treat a drawn divider as what it really is — **a message that will arrive broken** — and hold it back before it goes out, on WhatsApp and Telegram alike. Wolffish is taught the right habit up front, too: **a blank line separates sections; an emoji plus a bold line makes a header**. Quoted code keeps its box-drawing — a CLI table inside a code block is content, not decoration — and short dashes in prose stay untouched.

### A Workflow Card Only When Agents Run

In workflow mode, declaring a plan draws a **live card** in the chat — phases across the top, agents lighting up beneath them as they work. But that card renders **agent telemetry and nothing else**, so when Wolffish declared phases and then quietly did the work itself, you were left with a finished task sitting over a card frozen on **"No agents spawned yet."** Planning now means committing: the moment a plan exists with no agents behind it, the tool itself answers back that the card it just drew is empty and that the phase work belongs in agents — and when doing the work solo is the right call, Wolffish now skips the machinery entirely: **no plan, no card, just the work and a running narration**.

## v1.0.216 — 2026-07-12

### New Chats Appear the Instant They Start

The moment a conversation begins — you hit send in the app, or a message lands on WhatsApp or Telegram — its row now **shows up in the sidebar instantly**, activity chip already pulsing. Until now Wolffish named the conversation first (a short model call), and for those one to four seconds a brand-new chat lived nowhere you could see it: a dead untitled row, or nothing at all. Now the row lands first and **the title catches up in place** a moment later — and once a real title is showing, it never flips back to "Untitled."

### A Conversation List That's Never Stale

The conversations rail and the History page now **refresh themselves the moment a conversation changes on disk** — created, renamed, grown, or deleted — wherever the change came from. History used to take **one snapshot when you opened it** and never update; the rail only redrew when chat activity nudged it. So a conversation born where no window was watching — a **heartbeat run on its schedule, a saved procedure firing overnight** — could sit invisible until something else happened to shake the list. Now every path reports through the same door, and both lists simply follow along, live.

### History, Painted Before You Blink

Opening History now **paints your conversations instantly** from the last visit and refreshes silently in the background — the loading skeleton only ever appears on the first open after launch. Deleting a conversation **removes the row on the spot**, too: no more deleted row flashing back for half a beat while the index caught up.

## v1.0.215 — 2026-07-11

### Channel Messages That Can't Leave Broken

Wolffish is the only thing standing between its own markup and what lands on your phone — and until now it could still send a message it *knew* was malformed, because the format check was Wolffish's to run and Wolffish could skip it. That check now runs **automatically on every WhatsApp and Telegram send, reply, caption, and edit**, and a message that would reach you visibly broken is **held back before it goes out**. On Telegram that stops the markup that makes the Bot API reject the whole message and deliver it as raw tag soup — and it now catches a subtler failure that slipped past every earlier check: **formatting tags written as `&lt;b&gt;` entities**, which Telegram delivers as the literal text `<b>` instead of bold (the exact slip that once turned an email digest into a wall of visible tags). On WhatsApp — which renders **no HTML at all** — a stray `<b>` or `&amp;` that used to arrive as literal characters is caught the same way. And the gate **can never lose a message**: if Wolffish can't get the markup right after a couple of tries it sends the message anyway rather than going silent, so the worst case is raw markup, never nothing at all. When the "markup" is really the content — a code snippet or a tag you're showing on purpose — Wolffish can wave it straight through untouched.

### Wolffish Reads the Manual First

Before taking on anything with real substance, Wolffish now opens its own **working manual as its first move** — a discipline for reading what you actually asked rather than the literal words, breaking a problem into pieces it can check one by one, verifying its own claims a second way before stating them, and leading with the answer instead of burying it. On multi-step work it also **lays out a short plan in its reply first** — the phases, and how it'll know each one landed — before it starts changing anything. The result is steadier, less confidently-wrong work on exactly the hard, ambiguous, high-stakes tasks where a plausible-but-wrong answer costs the most, while quick asks — a hello, a one-line lookup — stay quick and skip the ceremony.

## v1.0.214 — 2026-07-11

### Right-Click a Typo, Get the Fix

Wolffish has always underlined misspelled words with the familiar red squiggle — but that was where it stopped; there was no way to actually correct one. Now **right-click any misspelled word and Wolffish offers the fixes** — the same suggestions the underline was implying — and picking one **swaps the word in place**, undo and all. There's an **Add to dictionary** entry too, for the names and terms you'd rather it stopped flagging. It reaches **every place you type prose**: the chat composer, the expanded editor, the prompt editors in Heartbeat and Procedures, the full-screen markdown editor, and markdown files opened in the viewer. Credential and URL fields are left untouched — you don't want a spellchecker second-guessing an API key. And it behaves the same on **macOS, Windows, and Linux**: macOS leans on the system speller and works offline out of the box, while Windows and Linux fetch their dictionary once on first launch and then run identically — everything Wolffish stores stays inside `~/.wolffish`.

### The Mode Toggle, Where You Expect It

On a saved procedure's card, the single/workflow mode toggle sat on the opposite side from where the very same control lives on a heartbeat's card. It now matches — the run, edit, and delete icons first, then the mode toggle at the end — so the two lists finally read the same way.

## v1.0.213 — 2026-07-10

### Notion Reads Whatever You Point At

Point Wolffish at a Notion **database** and it used to dead-end — it tried to open it as a page, hit Notion's own "that's a database, not a page," and had no way to recover. Now reading any Notion link **just works whether it's a page or a database**: Wolffish notices which one it's holding and returns the right thing — no retry, no error handed back to you. And there's a dedicated way to read a database's **schema, its columns and their types** — exactly what Wolffish needs before it can add a row, and the only way to see the shape of a database that's still empty (querying an empty one returns nothing).

### A Direct Line to the Rest of Notion

For the corners Wolffish's built-in Notion tools don't reach — a single block, an over-long relation list, newer parts of the API like data sources — there's now a **raw line straight to Notion**. It's pinned to Notion's own servers, it can't be pointed anywhere else, and every write or delete still asks before it runs. Newer API surfaces the built-in tools predate are reachable through it too. You won't usually see it — Wolffish reaches for the purpose-built tools first — but when something niche comes up, it's no longer a wall.

### Notion Actions That Stop Failing Quietly

A cluster of Notion actions that used to fail without saying why now either work or tell you exactly what's missing. Creating a page **no longer stalls on "parent is required"**: Wolffish takes the destination however it's phrased, and when it genuinely doesn't have one it says precisely what to pass and where to find it — instead of firing the same broken call again and again. Editing a block that was missing a piece used to claim success while **changing nothing**; now it says what it needs. And a Notion search with no size set comes back with a **tidy handful** instead of a hundred results you didn't ask for.

## v1.0.212 — 2026-07-10

### PDFs That Come Out Designed, Not Dumped

When you ask Wolffish for a PDF, it now builds a **designed document** by default — a colored header band, cards, chips, and badges laid out in HTML and rendered to PDF — instead of reaching for the plain black-and-white builder that made everything look like a data dump. That plain path is still there for when you genuinely want plain, but it's no longer the default. Three things that used to wreck a generated PDF are fixed at the source: a **gradient-colored title** that printed as a solid purple block now stays a clean solid color (gradients belong on backgrounds, never on text); the page **bleeds its color edge to edge** with no white bars framing it; and content is laid out in whole blocks that **break onto a new page cleanly** — with real breathing room at the top — instead of starting jammed against the edge or getting sliced in half. The full recipe now lives in Wolffish's own instructions, so it holds whether the PDF comes from an in-app chat, a heartbeat, or a channel.

## v1.0.211 — 2026-07-10

### Logs and Files for Every Run

The **Logs and Files** button now sits in the composer at all times. It shows a live count, and when a chat has nothing yet it simply goes quiet — disabled and reading **0** — instead of vanishing. The bigger change is where it works: heartbeats, WhatsApp, Telegram, and saved procedures now surface their **event log** and their **files** exactly like an in-app chat. Until now those runs showed neither — their timeline was never recorded, so there was nothing to open — which meant the work an automation did while you weren't watching left no trace you could inspect. Open one now and you can read every step it took.

### View Files, Now a Full File Log

**View Files** used to list only the files Wolffish handed you with an explicit delivery marker. Now it's a complete log of every file a run touched — the ones it **produced, converted, and sent to a channel** too. So a heartbeat that builds a report and mails the PDF to Telegram shows both the report *and* the PDF, listed in the order they appeared so the drawer reads like a timeline of the run's files. Paths that live outside the workspace or never reached disk are quietly skipped, and a file that showed up twice — once as it was made, once as it was sent — now collapses to a single entry instead of appearing doubled.

## v1.0.210 — 2026-07-09

### GIFs That Actually Send — and Play as GIFs

WhatsApp has no real "GIF" type — a GIF there is a short, muted, looping video — so handing it an animated GIF as a plain image was a message it quietly dropped. That's why a GIF could report "sent" and never reach the other phone. Now Wolffish transcodes the GIF to mp4 and sends it the way WhatsApp expects: a **looping animation** that lands and plays. Short clips loop as a GIF; anything longer rides as a normal video so it still arrives whole. The **ffmpeg** that does the conversion self-installs the first time it's needed, and if it ever can't run, the GIF is still delivered as a file rather than disappearing. Telegram got the matching fix — a GIF sent through the image tool now goes out as an **animation** instead of a frozen still.

### A "Sent" You Can Trust

A WhatsApp send used to call itself a success the instant the message was queued locally — before WhatsApp had confirmed a thing — so a send that never actually left could still be reported as delivered. Now every WhatsApp send **waits for WhatsApp's own server acknowledgement**: a send the server rejects is surfaced as a real failure, one that goes unconfirmed is flagged as unconfirmed (never claimed as delivered), and only a server-confirmed send reports a clean success. It covers everything Wolffish sends — text, images, GIFs, documents, voice notes, and replies — so a message silently falling into the void can't be logged as done anymore.

## v1.0.209 — 2026-07-09

### Grok 4.5, xAI's New Frontier

xAI's newest frontier model joins the lineup. **Grok 4.5** reasons always-on — you can't switch its thinking off, but you can dial it with the brain button between a lighter **on** and a heavier **high** — it reads images, and it carries a **500K-token** context window. It arrives as the default xAI model, ahead of Grok 4.3, and it's reachable on both fronts: connect xAI directly or go through OpenRouter. Its price shows straight in the model picker — $2 in / $6 out per million tokens, $0.50 cached — all of it verified against xAI live rather than guessed. While we were in there, we filled in the cached-input price for the *whole* Grok line, which used to sit blank on every card, and moved the "frontier" badge onto 4.5 where it now belongs.

### Telegram Captions, Formatted Like Everything Else

A caption you send under a photo, document, video, or audio file on Telegram now renders its formatting — the exact same HTML subset every other Telegram message uses — instead of arriving with the tags showing literally. And when a caption's markup is malformed, the **file still reaches you**: rather than failing the whole send, Wolffish delivers the attachment with the caption dropped to plain text and notes to fix the markup next time, so a formatting slip never costs you the file itself. The pre-send `telegram_check_format` check and Wolffish's own formatting rules now cover captions the same way they cover message text, and the WhatsApp caption guidance got the same sharpening. Switching your model over Telegram is safer too — the confirmation line now escapes the model and provider names, so an id carrying a stray `<` or `&` can't bounce the whole message.

## v1.0.208 — 2026-07-08

### Channel Messages That Never Arrive as Tag Soup

On WhatsApp and Telegram, Wolffish is the only formatter standing between it and you — and now it can proofread its own markup before a message ever goes out. Two new tools, **`telegram_check_format`** and **`whatsapp_check_format`**, validate a message against the channel's exact rules *without sending it*: each returns "clean" or the precise list of what's wrong, and neither changes a thing — Wolffish fixes its own text and re-checks. On Telegram that catches the mistakes that make the Bot API reject the **whole** message and deliver it as raw tag soup: a stray wrapper like `</message>`, a leaked `<p>`/`<br>`/`<h2>`, an unclosed or orphaned tag, a bare `<` or `&` that should have been escaped. On WhatsApp it catches leaked Markdown that arrives as ugly literal syntax — `**double asterisks**`, `#` headings, `[text](url)` links, `| tables |`, `---` rules, a language tag stuck after a code fence. Both are pure checks that need no live connection, so they work even on background runs — a heartbeat digest, a workflow turn — exactly where a formatting slip used to sail through unnoticed. The upshot: fewer garbled messages, and when one would have garbled, it's caught before you ever see it.

## v1.0.207 — 2026-07-07

### Set Your Model and Mode from WhatsApp and Telegram

The pickers that live beside the chat input came to the channels. Two new commands steer a chat without ever opening the app. **`/mode`** switches between Single and Workflow — send it bare to see which you're in, or `/mode workflow` to change. **`/model`** lists every cloud model across every provider you've connected, numbered; reply with a number to switch, with the one you're on marked. In a hurry, `/model opus` filters by name and, when it pins a single match, switches straight to it. Choosing a cloud model this way also flips local-only off, so the model you asked for is the model you get. Listing is always allowed, even mid-turn; switching waits for the current turn to finish, since the model and mode are shared across the whole app. Both channels' `/help` and command menus now carry the two commands.

### A Quieter Clean Feed

Verbose off now means exactly what it says: Wolffish's own words and the files it hands you, and nothing else. Tool cards — successful, failed, and denied alike — no longer surface on the clean feed, and neither do the "here's a path" cards that used to appear whenever a file location was merely mentioned in passing. The rule is consistent everywhere now: in-app, WhatsApp, Telegram, and PDF export all draw the same clean feed. Flip verbose on and every card, error, and detail is back — and the model always receives the full result either way; this only changes what *you're* shown. Workflow progress is the one thing that always shows through: its phase and per-agent updates aren't tool mechanics, so they land in every mode.

## v1.0.206 — 2026-07-07

### Conversations, Running Side by Side

Wolffish is no longer a single chat window that empties when you open another. Every conversation now runs **concurrently**: each keeps its own feed, composer, context meter, and in-flight turn, all mounted at once. Start a second chat while the first is still streaming, flip back to it, and both are exactly where you left them — switching conversations never pauses, resets, or drops a turn that's mid-flight. A conversation only ever advances when *its* turn does.

### The Conversations Rail

A new rail down the right edge lists every conversation you have, across every channel, newest first. Each carries a small numbered status chip that tells you what it's doing at a glance: it **pulses** while a turn is running and settles into a color when it's done — green for finished, red for failed, amber for stopped — and holds that color for the rest of your session. Collapsed, the rail is just the chips; expanded, each shows its title. Click any one to jump straight to it — including a conversation still mid-turn that hasn't been written to disk yet, which the rail reopens by its live session rather than dead-ending on a missing file. It mirrors the left nav rail exactly, so the two frame the app symmetrically.

### Every Conversation Names Itself

Conversations title themselves now. The moment one begins, Wolffish reads your first message and writes a short, specific title for it — so the rail and the History page read like a table of contents instead of a wall of identical "New chat" rows. The titling runs quietly in the background on your chosen model; its cost is recorded on your usage ledger but is walled off from the conversation's own context meter, so naming a chat never eats into its window. If the model can't be reached, the title falls back to a trimmed slice of your opening line, and a later turn tries again — a chat is never stuck nameless because of one blip.

### Channels Stop Waiting in Line

Until now every turn everywhere was serialized into a single queue: a Telegram message landing in the middle of an in-app turn had to wait for it to finish. That queue is now **per conversation**. A single conversation is still one ordered transcript — its own turns take their turns — but *different* conversations run in parallel, in any mix of in-app, WhatsApp, and Telegram. Your morning WhatsApp thread and a long in-app task no longer block each other. Every turn also reports its live status back to the app, which is what lets the rail's chips pulse for channel runs and not just the one on your screen.

### Sidebars, Squared Up

Both rails were rebuilt to match. They're mirror-symmetric now — the same widths, both defaulting to collapsed, and they **snap** open and closed instead of animating a width that used to make the icons visibly jump mid-slide. Each rail ends cleanly at the top of the action bar rather than running behind it. The History page joined the family too: it shows the same live status chips and shares one open-or-activate path with the rail, so resuming a conversation there behaves identically to opening it from the sidebar.

### Sweat the Details

- Running procedure and heartbeat overlays now wear a **Single / Workflow** badge, so you can see at a glance which mode an automated run is executing in — and a job with no marker shows the global mode it's inheriting.
- The Arabic interface caught up on the "automated task — read only" notice shown on heartbeat runs.
- Opening a conversation warms its file cards before it paints, so a resumed chat lands fully formed instead of popping its attachments in one by one.

## v1.0.205 — 2026-07-06

### Workflow Mode: One Master, Many Agents

Orchestrator mode is gone, and what replaces it is bigger than a rename. In **Workflow mode**, your model becomes the master of a run it designs itself: it declares the phases of its plan, spawns live agents that work in parallel, collects each one's report the moment it lands, sends follow-ups, and cancels anything no longer worth finishing. Each agent is a real, bounded task — and the master picks **the right model for each one individually**, from every provider you've connected: it sees a catalog of your models with their context windows, reasoning support, and vision, and chooses accordingly — a frontier model to verify, a fast cheap one to sweep. The agents work in silence; you hear one voice, the master's, which weaves everything into the reply you actually read.

The old machinery went with it: the fixed "worker model" slot, the greedy and autonomous toggles, the orchestrator's settings — all retired. If you were running orchestrator mode, you wake up in workflow mode, and leftovers from the old system are swept out of your workspace automatically.

### The Workflow Card

Every workflow run gets one card in the chat. Collapsed, it's a single quiet header; open, it's the whole run: the phase plan as chips that move from pending to active to done, and a live table with a row per agent — its name and task, the model it runs on, its phase, elapsed time, tokens, tool calls, and cost — with run totals up top. Every number is drawn from the harness's own telemetry, never from what the model claims, so the card you watch live and the card you reopen next week are the same card. It prints, too: PDF export renders the finished run as a clean static table.

### Pick Your Model and Mode Where You Type

The Brain settings page — the drag-and-drop model slots — is gone, and choosing what runs your conversation moved to where the conversation happens. Beside the chat input: a **Local/Cloud switch** showing exactly what's active, which opens into a searchable catalog of every model on every provider you've connected — capability badges, context sizes, one click to switch. Next to it, a **mode pill** — Single or Workflow — one click, effective from your next message. And the reasoning button grew up: instead of blind-cycling through efforts, hover it for a card of every level the current model supports — Off, On, High, Max — each explained, one click to pick.

### Every Job Chooses Its Own Mode

A heartbeat automation and a saved procedure can each carry their own mode now. Toggle Single/Workflow per job on the Heartbeat page and per procedure next to its Play button — the morning digest stays a quick single-model run while the weekly deep-dive fans out into agents. Under the hood it's one plain-text marker line (`mode: workflow`) at the top of the job, so Wolffish can set it by conversation too when you ask it to schedule something. Jobs without a marker simply follow the global mode.

### Workflows on WhatsApp and Telegram

The old per-worker narration retired with its mode. In its place, workflow runs report progress the deterministic way: a message when the run starts with its phase plan, one as each phase completes, a verdict line per agent as it lands (with verbose on — model, duration, tool calls), and a closing summary with totals. Verbose off keeps the feed clean as always: the master's answer, nothing else.

### Sweat the Details

- GitHub and Notion connection tests no longer fail into the void: a failed test now leaves a red alert with the reason on the connection card until you fix the token or a test passes — and the message follows your app language.
- `.txt` attachments now open in a proper line-numbered text viewer instead of a bare file card.
- Each workflow agent's context is budgeted against **its own model's** window — a small-window agent is no longer measured against the master's.
- Agents fail honestly and fast — no hidden retry loops; the master decides whether to re-run, re-scope, or move on.
- The attachments grid breathes: wider tiles, more spacing.
- The clocks on running procedure and heartbeat overlays follow your app language's time format.
- Model names show compactly everywhere the pickers list them, and error messages got shorter and plainer.
- The drag-and-drop libraries the old Brain page needed are out of the app entirely.

## v1.0.204 — 2026-07-05

### Save Any Conversation as a PDF

A new download button in the chat footer turns the conversation you're looking at into a PDF — the same feed, faithfully: your messages, Wolffish's replies, tool cards, code blocks, and file attachments, laid out for print and offline reading. One click and it's saved.

### The Usage Meter, Rebuilt

The old opt-in "Show in-chat analytics" strip is gone, and with it the setting that hid it. In its place, the context pill beside the chat input is always there — and now it opens. Hover or pin it for the full picture: how much of your model's context window is in use and exactly where auto-compaction will trigger — drawn as a tick, so the percentage and the trigger are finally the same number — how much of that context arrived warm from cache versus freshly ingested, and a running ledger for this turn, last turn, and all time of input and output tokens, API calls, tool calls, and cost. When the orchestrator is running, its workers and background summaries get their own sub-totals. It's the honest answer to "what is this conversation actually doing," one glance away.

### Watch Your Workers on WhatsApp and Telegram

When Wolffish runs in orchestrator mode, its background workers used to be invisible on the channels — you saw only the final reply. Now, with verbose mode on, each worker narrates its own thread: its prose and tool cards arrive as labeled messages, coalesced per worker so concurrent workers never scramble into one another, mirroring the subagent rail you see in the app. Verbose off still gives you the clean feed — the orchestrator's answer, and nothing else.

### Send an Image to Any Model

The capability gate that rejected images on non-vision models is gone. Attach an image to any model, on any surface — in-app, WhatsApp, Telegram — and it goes through. A model that can't see the pixels now receives the file's name and location plus guidance on the tools that can read it, and tells you plainly what it can and can't do with it, instead of bouncing your upload with an error.

### Offline, Treated as a State

Losing your connection is a condition, not a blip — so the offline notice now behaves like one. It's a sticky warning pinned to the top of the window with its own close button, and it stays until the connection returns, at which point it's swapped in place for a brief "connection restored." Wolffish itself now knows when it's offline, too: instead of burning turns on tools that need the internet, it leans on what works without it — memory, your files, the shell. And every toast can now be dismissed with a click.

## v1.0.203 — 2026-07-04

### A New Brain Economy: Lean Context, Total Recall

Wolffish's entire relationship with its own memory and tools has been rebuilt. Until now, every single message — even a scheduled hourly job — carried a ~95,000-token payload: the full catalog of every tool it owns (twice), yesterday's activity logs pasted in wholesale, and a 40KB operating manual. That's gone. A fresh conversation now starts at roughly **9,000 tokens — a 10× reduction** — carrying only the essentials: who it is, who you are, your learned preferences, a map of what it remembers, and an index of what it can do.

Nothing was lost — the opposite. Everything Wolffish has ever done, said, produced, or spent is now in one indexed store it can search in milliseconds: every conversation **including every tool call and its output**, daily activity, long-term knowledge, task runs, generated files, even its own LLM costs. New tools — `memory_search`, `memory_get`, `conversation_list`, `conversation_read`, `memory_save`, `usage_report` — retrieve any of it surgically, on demand. Say "send me the flight plan" and Wolffish searches its past for it unprompted, whether that was yesterday or a month ago. Ask "what did today cost?" and it answers from its own ledger — something it simply couldn't do before.

Tools went the same way. Instead of shipping all 300+ tool definitions with every request, Wolffish keeps ~30 essentials loaded and **finds the rest when it needs them** — `tool_search("resize a video")` loads ffmpeg mid-task, usable that same turn. Connecting an MCP server with 500 tools now costs one line of context instead of inflating every request forever. The architecture scales to thousands of tools and gigabytes of history without slowing down.

### Long Conversations Stop Paying Rent

A conversation that outgrows the context window used to re-summarize itself from scratch on **every message** — a hidden LLM call each time, forever. Now the summary is computed once, saved with the conversation, and reused; the compressed turns stay retrievable verbatim via `conversation_read`, so even a detail from fifty messages ago is one lookup away. Old bulky tool outputs and attachments in a long chat also step aside into compact pointers instead of re-uploading themselves every turn — and re-attached images and PDFs are no longer re-encoded from disk on every single message.

### Your Files, Hand-Delivered — Never Auto-Dumped

File delivery is now entirely Wolffish's own decision, not hidden plumbing. Previously, some tools quietly auto-attached whatever file path appeared in their output — files could reach your Telegram or WhatsApp without Wolffish ever deciding to send them, and worse, the machinery sometimes talked Wolffish *out* of sending its own work. All of that is gone. Now there is exactly one rule, and Wolffish follows it: **when it produces a file for you — a PDF, a converted video, a spreadsheet, even a tiny text file — it sends it to your conversation the moment the work is done**, rendered natively wherever you are: a file card in-app, a real upload on Telegram and WhatsApp. If you explicitly asked for a file to just be saved somewhere, it respects that and tells you where it is. No more "saved to ~/some/path" dead ends, and no more surprise attachments you never asked to receive.

### Local Models: One System, No Training Wheels

The two "Stateless local models" and "Restrict local models" settings are gone. Local models now run the exact same system as cloud models — same lean context, same tools, same memory — because the context is finally small enough for them to handle. A locally-run model will tell you honestly when a task is beyond it and suggest a capable model, but if you insist, nothing is withheld. Models with very small context windows automatically get a slimmed bootstrap toolset instead of being lobotomized.

### Sweat the Details

- Working-folder listings no longer silently invalidate the prompt cache on every message.
- Automation runs are now recorded durably — "why did last week's job fail?" finally has an answer.
- The memory index no longer rebuilds from scratch at every launch; it updates incrementally as files change (full rebuild of the entire workspace takes ~1.5s when needed).
- The context meter now measures against the same budget compaction actually enforces.
- Duplicate facts no longer pile up in the knowledge files, and the weekly review writes a digest instead of pasting seven days of raw logs.
- Incoming WhatsApp messages are now part of Wolffish's searchable memory — "what did she say on WhatsApp?" just works.
- Reading a past conversation supports a full-detail mode, and the complete untruncated transcript is always one call away.
- The History page now loads its list from the memory index — instant, no matter how many conversations you have.
- The context meter shows your model's full context window (a 1M model reads 1M).
- Hardened against the weird stuff: corrupt files, empty workspaces, Arabic search, malformed data — thirty new edge-case tests, all passing.
- Fixed: task-history indexing (every record was silently empty), memory-search ranking (better matches scored lower), doubled `mcp-mcp-` names for MCP servers, a ghost `channel_status` tool the model was told to call but couldn't, and cloud-provider PDFs being needlessly flattened to plain text.

## v1.0.202 — 2026-07-02

### MCP: Connect Any Tool Server, and It Just Works

A new **MCP** page in Settings connects Model Context Protocol servers — the growing ecosystem of tool servers for everything from databases to design apps to domain knowledge. Paste a command (for a server that runs on your machine) or a URL (for a remote one) and Wolffish connects on the spot: no separate "connect" step, no test button you have to remember, no restart. Every tool the server exposes is available to Wolffish — in normal chat and to orchestrator workers alike — on your very next message.

Connections look after themselves. If a server crashes or a remote endpoint drops, its tools quietly step aside and Wolffish reconnects in the background with steadily-spaced retries — no error modals, no flashing status, nothing you have to do. When it comes back, the tools return on their own. If a remote server needs sign-in, Wolffish walks you through it the way any modern app would: one **Sign in** button, your browser opens, and you come back connected. One misbehaving server can never affect another or the app — every connection is isolated. Servers are namespaced so two of them can never collide, and removing a connection cleans up everything it touched.

Wolffish can also manage these connections for you by conversation — "connect the tafsir MCP server," "which MCP servers are on?", "disable that one," "remove it" — through a new `mcp` capability. Whatever it does shows up on the MCP settings page live, and whatever you do there is visible to it.

### Network Status, Quietly Handled

Wolffish now tells you when your connection drops and when it's back — one small toast each way, only on real transitions, never on a normal launch. And when a background run (an automation or procedure) fails because of the network or a provider, the notification now says *why* in plain words — "no internet connection," "rate-limited," "invalid API key" — instead of a raw machine error.

## v1.0.201 — 2026-07-01

### Procedures: Prompts You Save and Run On Demand

A new **Procedures** page (the Play button in the sidebar) holds prompts you want to reuse — write one once, then hit **Play** to run it in a fresh conversation any time. Runs execute in the background under a live overlay with a timer and a color-coded activity log, land in History marked with a Play icon, and never touch the chat you're in. Wolffish can manage them by conversation too — "save this as a procedure," "run my morning brief" — through a new `procedures` capability.

### Connect Multiple GitHub and Notion Accounts

The GitHub and Notion settings panels now hold any number of connections, each with its own label — "Personal," "Work" — and a per-connection **Test** button that shows the account it resolves to. Every GitHub and Notion tool takes an optional connection label to pick the account, and picks automatically when only one is linked. Existing setups migrate on their own.

### WhatsApp Messages in WhatsApp's Own Formatting

Replies on WhatsApp no longer arrive as raw Markdown — `**bold**` asterisk soup, `#` headings, broken tables. Wolffish now writes in WhatsApp's native style (_bold_, _italic_, plain lists), and everything it sends passes through a converter that translates any leftover Markdown — headings, links, tables, task lists — into clean WhatsApp text.

### WhatsApp Now Accepts Any File You Send It

Send a PDF, document, image, video, audio file, or sticker over WhatsApp and Wolffish downloads and reads it like an in-app attachment — previously only voice notes made it through, and anything else was silently dropped. Files that arrive without a name or extension are typed from the media itself, and Telegram gained the same nameless-file handling.

### Every File in a Conversation, One Click Away

A new files button in the chat footer opens everything the conversation holds — your uploads and every file Wolffish produced — in a full-width grid. The timeline beside it now spans the whole conversation, with a collapsible divider per prompt instead of resetting every turn.

### HTML Attachments

You can now attach `.html` files. They open in the code viewer with a one-click toggle between the sandboxed page preview and the highlighted source.

### Fixes & Polish

Background runs — procedures and automations — are now fully isolated from the live chat: they can't skew its context meter, hijack its Stop button, or overwrite a conversation created in the same second. A file a tool already delivered is no longer re-sent in the same turn, and the agent now reliably hands you every file it produces. A turn can no longer end silently mid-task with no message. Chat stays live while you visit Settings and other pages — the context meter and timeline no longer reload, and playing media pauses on the way out. Long conversations render noticeably faster, file cards show readable type labels like "DOCX" instead of raw MIME strings, and durations read naturally ("0.3s", "1m 12s").
