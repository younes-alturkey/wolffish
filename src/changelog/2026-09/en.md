## v1.0.318 — 2026-09-30 `Latest`

### A Stopped Call Says It Was Stopped, Not That It Failed

Press Stop while a tool call is running and the card it left behind said **"Failed"** in red — the same verdict a command gets when it genuinely breaks, on a call that did exactly what you asked and quit. The model's own stops read the same way: when it ended a long-running call with call_stop and read the result back, the card wore red for a decision, not a defect.

Tool cards now have a **fifth state: "Stopped"**, in amber, for a call that was ended on purpose. The pill says who did it — **"Stopped by you"** when you pressed Stop, **"Stopped by Wolffish"** when the model called call_stop — and a short line under the header says why, so a stopped card never reads as broken. Whatever the call had printed up to the stop stays visible, in plain text rather than error red. The same state carries into the **terminal client** and the **PDF export**, and a stopped call shows a stop mark rather than a warning in **WhatsApp and Telegram**. Nothing is hidden from the model: a stopped call is still reported to it as one that did not complete, so a continued conversation stays honest about what ran.

## v1.0.317 — 2026-09-26

### The Network Tab Says When It Started Watching

Attach the debugger to a page that had already loaded, ask for its network requests, and the answer was **"no requests since the last navigation"** — which reads as "this page called nothing", when a Next.js app had just pulled thirty assets. The truth is simpler: capture can only start the moment the debugger attaches, and nothing before that instant is recoverable. The tool knew that and did not say it, so the model tried again, got the same empty list, and concluded the feature was broken.

The list now **reports its own capture window**. When the page loaded before capture began, the empty result says exactly that and tells the model what to do: **reload the page or navigate on**, then list again. The tool's own description says the same, so the model no longer expects a page's load to be in a buffer that started after it. The bundled extension is updated to **0.1.69** with this; reload it once from chrome://extensions.

### A Missing Request Id Is Not Retried Three Times

Ask for a network request by an id that is not in the buffer and the error was correct, but the retry logic treated it as transient and **tried the same lookup three times** before giving up. It is a local array lookup and cannot change on a retry, so it now fails once and moves on.

## v1.0.316 — 2026-09-26

### The Extension Panel No Longer Opens a Tab Every Time You Look at It

Open the browser extension panel with Chrome connected and **a blank tab appeared in your browser** — another one on every visit, and another each time the connection blinked. The panel runs a readiness check when it opens, and part of that check asks the extension which tab a command would land on. The extension answered that question the way it answers it for real work: **if the conversation had no tab yet, it made one.** A diagnostic was opening pages nobody asked for.

The check now **only looks at tabs that already exist** — the conversation's own tab if it is still open, otherwise the one you are looking at — and skips that part of the probe when there is nothing to look at. The bundled extension is updated to **0.1.68** with the fix; reload it once from chrome://extensions and the panel stays quiet.

## v1.0.315 — 2026-09-25

### Long Commands Check In Instead of Holding Wolffish Hostage

A single tool call used to be a black box for as long as it ran. Ask for a folder and the search could crawl your entire home directory for an hour, and **nothing in Wolffish could tell the model it was happening** — it was frozen inside the call, unable to read your messages, unable to notice, unable to stop. **Every tool call now checks in.** A call that runs past its check-in time (two minutes by default, and the model sets it per call to whatever the job should reasonably need) keeps running exactly as it was, but the model gets a report instead of a wait: how long it has been going, **what it has printed so far** — a shell command shows its output rate and its last lines — and a handle. Then the model decides, at a real stop point: keep waiting on it, stop it, or carry on with other work while it runs.

Nothing is capped and nothing is killed for it. An hour-long build is an hour of check-ins the model chose to wait through, each one after reading the progress. What changes is the reflex: most steps finish in seconds, so a check-in on a search or a listing almost always means the command was wrong — too broad, hung on a prompt — and the model now **stops it and takes a narrower route** instead of sitting blind. A parked call the model moves on from is named in its runtime status every step until it reads the result or ends it, and pressing Stop on a turn stops whatever that turn parked.

You can see it happen. **The tool card shows "Still running"** in amber with the handle and a clock that keeps counting, on the desktop, in the terminal and on your phone, and it updates in place with the real result and total duration the moment the call lands.

## v1.0.314 — 2026-09-24

### A Finished Turn No Longer Reports Itself as Failed

When a run's work was already done and delivered, Wolffish could still end the turn with an error: **a "Provider rejected" card, on a run that had succeeded.** The cause was internal. Finishing a turn is a tool call — the model's way of saying "everything is delivered and nothing further is needed" — and when that call arrived **alongside other calls in the same batch**, the request sent back to the provider declared it as a call that nothing would ever answer. No provider accepts that shape, so the reply was refused and the refusal was written onto the turn as a failure. It was most visible on your phone, where a turn marked failed **showed the error and hid everything the turn had produced** — the finished report, the published post, the files — so the work looked lost when it was sitting intact in the transcript the whole time.

The close is now taken out of the request **before the message is built**, so the call the model uses to say "nothing further" can never appear in a request that cannot be accepted. Closing a turn alongside real work behaves exactly as it always meant to: **the work in the batch still runs, and then the turn ends.** A turn that succeeded reports success.

## v1.0.313 — 2026-09-23

### Notifications Arrive Whole

A notification's text was **cut off at 180 characters**, and the cut happened before it ever reached you — so the notifications page, which exists precisely so a message you missed can be read in full, could only ever show the shortened version. **That ceiling is gone.** What Wolffish writes travels whole now, and **the notifications page and a conversation's own notifications sheet show all of it**.

The lock-screen banner is still brief, because a banner is one line: your phone shows as much of a long notification as fits, exactly as it always did. What changed is that the short version is no longer the only version — **the full text is kept**, so a notification with something substantive to say says all of it, and you can still read it properly tonight.

## v1.0.312 — 2026-09-23

### Find Any Conversation by Its Title

A long history used to mean scrolling for the conversation you wanted. **The Conversations page and the conversations sheet now each have a search field** that narrows the list as you type. It matches **every word you type, in any order** — "release notes" finds "Notes for the new release" — and it ignores **case and accents**, so "cafe" finds "Café" and a bare Arabic word finds its vowelled spelling. The field stays put while the results move, and the page links above it in the sheet are never filtered away.

The terminal searches the same way. In a session, **`/conversations` followed by a few words** lists only the matching titles, and `/more` keeps paging through that search; `/conversations` on its own brings the whole list back. From the shell, **`wolffish conversations --search release notes`** (or `-s`) narrows the listing — no quotes needed — as JSON, as a table, or as the interactive menu, which opens already filtered.

### Wolffish Can Pause and Resume Your Automations

Ask Wolffish to **turn a scheduled job off** and it now switches it off exactly the way the Automations page's own switch does: the job **stays in its place, listed and paused**, and stops firing until you ask for it back — instead of being deleted, or edited by hand in the heartbeat file. Wolffish sees paused jobs too, so "turn the morning digest back on" finds it. A paused job can be reworded or rescheduled without switching it back on, and a paused one-time job whose moment has passed comes back **with a new time** rather than into a slot that is already gone.

Every other change to an automation also goes through Wolffish's automation tools now, never through a hand edit of the heartbeat file — so each one is **validated, applied to the scheduler at once and reflected on the page**, instead of occasionally skipping all three and being silently overwritten by the next change. The file stays yours to read, and to edit by hand when the file itself is what you're working on. Because the automations capability now carries a version, all of this **reaches installs that already exist**, not only fresh ones.

## v1.0.311 — 2026-09-22

### Wolffish Keeps Your Servers Running

A dev server you asked for used to live and die inside the one command that started it: the shell call ended, the turn ended, and whatever it launched was either gone or orphaned somewhere with no name, no log and no way to ask about it later. **Wolffish now manages long-lived processes as first-class things you own.** Give one a name and a command and it becomes a record that survives the turn, the conversation and the app itself — with its own log, its real process id, and a state you can read at any moment.

Each process carries **the policies that decide how it behaves without you**: a port picked for it from Wolffish's own band, or an exact one you name — taking it over from whoever holds it, once you confirm; a restart rule — **never, on failure, or always** — so a crashed server comes back on its own; whether it **keeps running or stops when you quit Wolffish**; and whether it **starts itself when you log into your computer**, as a real login unit your operating system owns. A readiness check means a start only reports success once the thing is actually answering, not merely spawned.

They are visible everywhere you work: a **Processes tab in your Library** with grouped rows and expandable detail, a **card in the conversation** that keeps showing its state after the turn ends, and `wolffish process` in the terminal for listing, starting, stopping, restarting, reading logs and setting autostart. A one-shot command that simply finished is **forgotten rather than filed** — a command is not a service, and your list stays the things that actually run.

### A Browser That Lives in the Conversation

Wolffish gains **a real browser inside the conversation** — a Chromium session it drives directly, reading an accessibility snapshot of the page rather than guessing over pixels, so it acts on the element it meant to. It appears as a card in the transcript with its own tabs and chrome, and you can take it over with your own mouse and keyboard whenever you want.

A browser that was used in a conversation **comes back with that conversation**. Where reopening previously restored a single page, it now brings back **every tab of the strip, in order, with the one you were on still in front** — so a conversation you left with six tabs of research open is the same conversation when you return to it.

### Your Phone Drives Both

Everything above reaches your phone. **Managed processes are fully drivable from it** — list, start, stop, stop all, restart, edit a definition, remove one, read a log tail — through the very functions the desktop's own page calls, so a Stop pressed on the phone and a Stop pressed on the desktop are one function, and what comes back is always the desktop's stored record rather than the phone's optimism. The registry pushes its own changes, so a process the model starts on the desktop re-lists on the phone by itself.

The conversation's browser reaches the phone too, as **a read-only card with a still frame** — one image per settled page load, captured only while a phone is actually paired, so the desktop alone never pays for a picture nobody is looking at.

### The Chips Show Where You Work, Not Only What Changed

The strip of folder chips over a transcript answered only half the question. A folder you had **attached to the conversation** stayed invisible until something inside it changed, so a chat you had just pointed at a repository showed an empty strip and looked like it was working nowhere. **Every working folder you attach now earns a chip from the first message on**, carrying no number while nothing in it has changed yet, and picking up the count the moment it does.

The two halves meet on one path instead of splitting into two chips: attach `wolffish-app/src/renderer`, edit a page underneath it, and the strip shows **`wolffish-app` once**, because an attached folder shows as the project it opens. A folder spelled three ways — plain, with a trailing slash, or starting with `~` — is **one chip**, and a `~` now resolves to your home directory everywhere a path is read, including the `dir:` line of an automation.

### Processes Come to Windows

Managed processes and login units now work on Windows. Starting one used to look like a command that had **already finished the instant it began**: the detached launch made PowerShell exit cleanly without running anything, and swallowed the output of every program it did start. A hidden launcher now hosts the command in its own console, keeps it clear of the job that dies with Wolffish, and **reports the real process id and the real exit code**. Login units, which needed administrator rights through the old route and were simply refused without them, are now **an ordinary per-user scheduled task** that runs hidden and stops through the same manager as everything else.

Several races surfaced while testing and are fixed alongside it: a late exit after a stop read as a crash and resurrected the process; a start that redefined a name which had just crashed raced its own pending restart and inherited the previous command's port and readiness rules; and a process that outlives Wolffish's own shutdown **is no longer written off as dead** on the way out.

### Two Capabilities Were Quietly Loading as Errors

The **shell** and **text-to-speech** capabilities each had an invalid line in their definition — a description that had grown a colon where the format cannot take one — and the result was not a warning but a silent failure: both loaded as errors, and **`shell_exec` was an unknown tool.** Both are fixed, and a test now parses **every bundled capability definition**, so a stray character can never again take a capability offline without saying so.

### Your Commit Messages Are Yours

Wolffish used to append a co-author line to every commit it helped you write, enforced by a hook that rewrote the message and a check that failed the build without it. Both are gone. **A commit message is yours now** — no tool credit is added, and nothing rewrites what you wrote.

## v1.0.310 — 2026-09-20

### An Automation Can Think As Hard As It Needs To

Every scheduled run, saved procedure and project used to inherit **whatever thinking level the chat happened to be set to** — so a nightly report that only needed a light pass could quietly run at maximum, and a deep analysis could run at minimum because you had switched the composer down earlier in the day. The effort a job deserves is a property of the job, not of the window you last typed in.

**Each automation, procedure and project now carries its own thinking level** — off, on, high or max — chosen from a switch right on its card, next to the mode toggle it already had. New ones start from **the mode you are running right now**, so nothing changes until you say so; after that the item decides, and its runs use it. Anything you saved before this release carries no setting and keeps following your chat exactly as it always did, so **nothing you already have behaves differently.**

### The Phone Sees the Same Switch

The same three cards on your phone carry the same control, reading and writing **the very same setting** — flip it on the desktop and the phone shows it, flip it on the phone and the desktop shows it, because they are one value seen from two places rather than two copies that take turns.

The levels your phone offers are **the ones your selected model actually honours**, sent from the desktop rather than guessed, so a card can never offer you a level the model would silently ignore.

### The Terminal Gets It Too

`wolffish procedures thinking <id> high` sets it from the command line, `wolffish procedures thinking <id> default` hands the decision back to your chat, and both the procedures and automations lists now show **a thinking column** so you can see at a glance what each one runs at — with the browsable menus gaining a picker for the same setting.

## v1.0.309 — 2026-09-20

### Saying Nothing No Longer Says Something

A model that had finished its work had no way to say so. The runtime told it to close with **an entirely empty response — zero characters**, and no provider carries an empty message: the content channel cannot be empty, which is why the app itself refuses to store one. So a finished turn had exactly one legal move left — **type a small stand-in for the silence and send it to you.** You have seen the results: `(no output)`, `(no content)`, `[Empty response]`, and most recently `[(empty — nothing further)]` stuck onto the end of a reply that had already finished. **The instruction was impossible, and the workaround was the bug.**

That instruction is gone. There is now a **`close_turn`** tool whose only job is to end the turn when everything you need is already said and delivered. Saying "nothing further" is a tool call — something a model can actually produce — instead of a zero-character message it cannot. The prompt no longer asks for the impossible and no longer prints the forbidden literals while forbidding them (printing one is how a model learns it); it names the correct action instead. This stays **model-led end to end**: nothing rewrites, strips or suppresses a character the model wrote. The model still decides when the turn is over — it just has a real way to say so.

### The Silence Detector Stopped Keeping a List

The guard that catches a faked silence worked from a **hand-written list of phrases**, and it kept losing the race: `(no output)` → `(no content)` → `[Empty response]` → `空空如也` → `[(empty — nothing further)]`, each one added to the list _after_ it reached you. The last one is the cleanest demonstration of why the approach could not work — the old pattern anchored on the word `empty` and **rejected anything after it**, so `empty — nothing further` matched nothing at all, no correction was ever sent to the model, and it kept doing it.

Detection is now **structural** rather than a vocabulary: a short bracketed group that closes a reply and is _about_ the absence of content trips it, whether or not anyone has seen that exact phrasing before. The same fix catches the shape that had been invisible: a marker **glued directly onto the end of prose** — `…just say the word. 🐟[(empty — nothing further)]` — which the old pattern missed because it required the bracket to start its own line. Ordinary parentheticals are still content: `The build ran clean (no output)` and `Blockers: (none)` are never second-guessed, in English or Chinese, because a false positive spends a correction on a model that was writing normally. The guard **observes and tells; it never edits** — the model sees what you saw and corrects itself.

### One Wrap-Up per Turn

A turn that wrote its closing answer, sent the phone notification and then **wrote the same news again** left you reading one paragraph twice — the turn's own contract made it likely: the wrap-up comes _after_ the file, the notification is the closing beat, so a model that followed all of it landed in a fresh step whose only exit was more prose, and it closed a second time. The one-wrap-up rule is now explicit in the prompt **and in the notification tool's own description** — the place a model actually reads at the moment it would break it. A landed notification is the finish line, not an intermission: say what is genuinely new, or call `close_turn` and stop.

### The Folder Chips Stop Sliding Down Into the Weeds

The strip of folder chips over a transcript is meant to answer one question — where did this run work? — and it had started answering a different one. On a chat with **no working folder set**, every chip was labeled by the **leaf of the path it happened to touch**, so the folders you actually worked in were invisible: `…/wolffish-app/.github/workflows/ci.yml` billed a chip reading **`workflows`**, `…/wolffish-app/src/lib/deep/nested/x.ts` billed one reading **`nested`**, and you had to click each chip and open it to find out what any of them meant. Worse, work spanning **two projects built the same way** put **two chips both named `src`** on the strip — `wolffish-app` and the cloud desktop each collapsed to their own second `src`, two identical labels over two different codebases, with nothing to tell them apart. Each touched directory now collapses to **the project folder that opens its tree**: the chip reads `wolffish-app`, `wolffish-cloud`, `capabilities`, and the counts add up across everything underneath. The scan runs **outermost boundary first** — the first `src`, `lib`, `test`, `docs` or dot-directory on the path — while containers like `apps` are passed straight through, so the cloud desktop still bills as **`desktop`** rather than as a generic `apps`, and a `.github` folder now folds into its project instead of claiming a chip of its own.

### A Finished Job No Longer Signs Off in Another Language

A scheduled run could do everything right — build the file, publish the post, write its notes — and then close with **a stray fragment in Chinese**: `空空如也`, "utterly empty", delivered to you as the run's final word. The guard that catches a model faking silence knew the English set phrases only, and **seven of the providers Wolffish talks to are Chinese labs** — deepseek, qwen, kimi and minimax among them — so a model reaching for the smallest stand-in it knew reached for one in its own language, and nothing ever saw it. The deeper cause sat underneath: Wolffish's own close-out reminder had been _ordering_ the silence — "end with an entirely empty response, zero characters" — and **a model that cannot emit a zero-token message answers that order with a placeholder**. The guard now knows the same set phrases in **Chinese, simplified and traditional**, bare or inside brackets, alone or trailing under real prose — it detects, never strips, so the model is told and corrects itself — while a real Chinese sentence, a single character or a phrase inside a sentence is content and is never second-guessed. The close-out notices were rewritten in the same spirit: they **hand over the facts and leave how the turn ends to the model**, keeping the one rule that is not a matter of taste — a typed stand-in for silence is a message, in every language.

### One Chip per Folder a Run Touched

Work a run does **deep inside a project** used to cost one chip per exact directory it touched, each labeled by its whole nested path: edit files in `src`, in `src/renderer/src` and in `src/renderer/src/lib`, and the strip over the transcript filled with `src`, `src/renderer/src` and `src/renderer/src/lib` — three narrow labels for one area of work, each counting only its own direct files. The strip now reads **one chip per top-level folder**: every touched directory collapses to its first segment under the working folder, the count is **the total across everything underneath**, and a click still opens the folder in your file manager. Paths outside the working folders keep a chip of their own, a file changed directly in the working folder still bills it, and a run that ranges across a whole project now costs a strip you can read at a glance instead of a scroll.

### The Controls Around a Running Turn Stop Playing Dead

Three controls around a running turn were lying about their state. The **PDF export button** sat greyed for as long as a turn or an export was in flight — a dead-looking control in a row of live ones; it now **isn't drawn while it can't work, and returns the moment it can**. The **send arrow beside Stop** stood there permanently, dimmed until you typed; it now **appears with your first keystroke or attachment**, which makes its arrival the sign that the message can go through to the running turn. And **leaving a project** no longer dims while its turn runs: exiting is a view switch — the project's session stays mounted and its turn keeps going in it — so the button **stays available**, because a running job is no more a reason to trap you in it.

### A Clearer Header for the Browser Side Panel

The browser side panel's connection state no longer hides at the end of the title row. It has **a line of its own under the header** — the same three states as before, told by the icon before the words: **a check mark while connected**, **a spinner while connecting**, and **a plug icon that pulses while the connection is down**. The conversation title beside it **truncates with an ellipsis** instead of shoving the row around, and the settings gear keeps its corner. The status now reads the same at a glance as it does word for word.

## v1.0.306 — 2026-09-18

### You Can Talk to a Job While It Works

Wolffish learned to take a message mid-turn a few versions ago — but only in a chat you had started yourself. **A scheduled automation, a procedure or a heartbeat job took none of it**, and those are exactly the runs that work unattended for minutes at a time and most need steering: _that post text is wrong, fix it before you publish._ Type into one and the message was refused outright — your bubble went up and came straight back down, and your words then waited, **on no screen at all**, until the run ended and the window sent them as a brand-new turn, far too late to matter. Those runs do not travel the same track a chat turn does, so nothing had ever registered them as steerable. They now **borrow the very same inbox**: the same acceptance, the same pending row, the same button to take a message back, and the same return of anything the job never got around to reading. Two rough edges on the chat side went with it. A message sent in **the sliver where a turn is closing** used to disappear with nothing to show for it, because the composer had already been emptied the moment you pressed Enter; it now **stays on screen saying it is waiting for the current turn to finish**, and taking it back hands the words to the composer rather than dropping them. And the instant a run actually reads your message, **it appears at the point it was read** — on the desktop, on your phone and in the terminal — instead of waiting out the pacing the rest of a turn pays.

### A Browser Group of Its Own for Every Job

Wolffish works in its own blue tab group rather than in your tabs — but there was **only ever one group**, so two jobs running side by side, or one starting right after another, **landed in each other's tab** and left one job's label standing over the other's work. Every conversation now gets **a group, a tab and a title of its own**: an automation browsing in the background never takes over the tab you are watching, and never renames it out from under you. The browser's side panel follows the same rule — it shows **the name of the conversation that actually ran the commands**, not whichever chat the app window happened to be sitting on, and a conversation named seconds ago shows that name straight away instead of `Untitled`.

### Cards That Stop Drifting From What They Describe

On the Automations, Procedures and Projects pages, the small grey detail line at the foot of each card was pinned to the card's floor so that every card in a row ended on the same line. What that actually bought was the opposite: **a card standing next to a taller neighbour opened a gap above the line**, and the detail floated away from the thing it belonged to. It now **sits directly beneath its own content**, so the wells line up across a row where that helps and the slack falls underneath, where nothing has to look at it.

## v1.0.305 — 2026-09-17

### The Stray Fragment at the End of a Finished Job

A scheduled run would do everything right — build the file, publish the post, write up its own notes — and then close with **a cryptic fragment like `[Empty response]`** where a clean ending belonged. Wolffish already watches for this: a model that means "nothing more to say" but cannot send a truly empty message sometimes types a stand-in for the silence instead, and when it does, it is told so on its next reply and corrects itself. The catch was that **every scheduled run gets a conversation of its own, closed the moment the run ends** — so the correction was addressed to a conversation that would never speak again, and was quietly thrown away. The check was catching every one of these and telling nobody, which is exactly why you saw it on automations and almost never in chat. That note now **reaches Wolffish wherever it next speaks**, carrying a line saying the slip happened somewhere else, so it never apologises to you for a message you never saw. Alongside it, the instructions Wolffish works from are firmer about the ordinary case: **a turn that did real work ends by talking to you** — what it did, what came of it, what failed or is still pending — and nothing is stapled on after that.

## v1.0.304 — 2026-09-17

### A Reply From Your Phone Reaches the Chat You Left Open

Continue a conversation on your phone while the desktop still has that conversation open, and the answer arrived everywhere except here: your prompt sat with **an empty bubble underneath it**, or with a reply that stopped mid-sentence, and the only cure was **quitting Wolffish entirely** — closing the window merely hides it, so the stale conversation on screen survives that. A turn running anywhere but this window streams itself into an open chat as a series of snapshots, and the desktop kept whichever snapshot came last; for a short answer that was the very first one, sent before a single word had been written. The finished reply did arrive moments later, and was **discarded because the chat recognised it and assumed it already had it**. An open conversation now **refreshes what it is already holding** against what was actually saved, instead of only adding what it has never seen — and a turn run from your phone **sends one last snapshot the instant it finishes** rather than stopping half a second short. The same correction covers a reply written on Telegram or WhatsApp, or by a scheduled automation, while you have that conversation open in front of you.

## v1.0.303 — 2026-09-17

### Wolffish Can Wait

Until now there was no honest way for Wolffish to be idle. A build it had just started, a rate limit to ride out, a render that needed ten minutes — the only options were a shell `sleep` you could neither see nor interrupt, calling the same tool over and over, or giving up and saying it would come back later, which meant starting again from nothing. There is now a **`wait`** tool with **no ceiling on it** — ten seconds or four hours, whatever the job actually needs, asked for once rather than chopped into a polling loop. While it runs the chat shows **a card saying why it is idle and when it will wake**, counting down, with **a box you can type into to wake it at once**. Anything you send from anywhere does the same — that box, the composer, your phone, Telegram, WhatsApp — and your message arrives as the very next thing it reads, in the order you sent it. The whole turn survives the pause: the files it had open, what it had already worked out, the rest of its plan. The card reaches disk within a second of the wait starting, so an hour-long wait outlives a crash or a restart, and it appears in the terminal, on your phone and in a PDF export like every other card. Three things that used to blur together now have edges: **waiting** keeps this turn, **a countdown** is for an action that must land after the reply is sent, and **a one-time automation** is for hours or days from now, starting fresh from what was written into it.

### Wolffish Taps You on the Shoulder

Until now Wolffish had no way of reaching you once you looked away. A turn would finish, or an approval card would go up and wait, and unless the window happened to be in front of you nothing said so — the work just sat there. Wolffish now uses **the signal your operating system already has for exactly this**: on macOS the **Dock icon bounces**, on Windows the **taskbar button flashes**, and on Linux the launcher entry is marked urgent wherever your desktop honours it. Two moments earn it and nothing else does. **A turn ending** is news, so it gets a glance — one bounce, then quiet. **A card that cannot go on without you**, an approval or a question, is a demand rather than news, so it keeps bouncing until you actually come back. None of it happens while you are already looking at the window, the signal is withdrawn the moment you return or answer the card, and a card left waiting **keeps its bounce even if another conversation finishes** while it waits. Turns that arrived from your phone, from Telegram or WhatsApp, or from a scheduled automation never do this: each already has its own way of reaching you, and none of them is a window sitting here waiting for you.

### Word Documents That Look Composed

A generated .docx was correct and plain; this is a typography pass over the whole engine. Headings are now **three voices rather than three sizes** — a section claim with a rule beneath it, an accent heading inside a section, and a letterspaced caps label for a short head over a list or a table. The default is a **pair** of typefaces, Cambria over Calibri, because one typeface doing every job is the flattest a document can look. Margins open to **1.25 inches** and the text sets on **130% leading**, both decisions about line length: at one inch an A4 line runs past ninety characters, wider than anyone reads comfortably. Tables lost the spreadsheet look — **no vertical rules, no striped rows, no fills** — keeping letterspaced caps column heads over a rule with hairlines between rows, the same system the PDF documents use so a report and its PDF match; and **a column of figures right-aligns itself**, heading included, so digits line up against digits. A cover now carries **a label-and-value row across a hairline** — who it is for, the date, the scope — sits a third of the way down the page, and **no longer prints a page number or a running head on itself**, so the first page of real content is page 1. The contents page can stop forcing a break after itself, which in a three-page brief was spending a whole page on four lines.

## v1.0.302 — 2026-09-17

### Spreadsheet Colours and Deck Proportions, Corrected

Two small things the new document viewers got wrong. A cell whose number format asks for a colour **by number** rather than by name — `[Color 3]` instead of `[Red]` — was painted from the wrong list, so it came out the wrong colour, and any number past the eighth came out with **no colour at all**; it now reads the palette Excel actually means. And a deck whose **first slide could not be drawn** took its shape from a guess rather than from the deck, so a 4:3 presentation was letterboxed into a widescreen card for every slide after it; the proportions now come from the first slide that really rendered.

### A Faster Start

The QR code library was being loaded **every time the app started**, because one of the two settings panels that draw a pairing code pulled it in eagerly. It is now fetched only when a code is actually on screen, which takes about **64 KB out of the startup bundle** — and makes the build quiet again, with no warnings left in it.

## v1.0.301 — 2026-09-17

### Slides, Documents and Spreadsheets Look Like Themselves Now

A .pptx, a .docx or an .xlsx in the chat used to be a grey file card with a name on it — you had to open it somewhere else to find out what was in it. All three now **render as the document itself**, right where they land. A deck comes through as **its actual slides**, with chevrons to page through them and the whole thing again at full size when you expand it. A Word file is laid out as **real pages** — its own margins, headings, tables, images, headers and footers — with a chip telling you which page you are on, and the page fills the width of the card instead of floating on a grey desk. A spreadsheet arrives as **a grid that kept the file's formatting**: its fills, fonts, borders, number formats, merged cells, frozen panes, column widths and sheet tabs, each sheet in its own direction so an Arabic interface never flips a Western workbook. Everything the file painted keeps exactly the colours it chose; only ink that would be invisible on a dark background falls back to something readable. The same grid now powers the workspace viewer too, which until now flattened a workbook into plain HTML.

### Wolffish Makes PowerPoint Decks

There is a new **presentation** capability: read a deck, build one, edit it, and check it before you send it. Building is not a thin wrapper over a slide library — you say what each slide _is_ (a title, a section break, bullets, two columns, cards, stats, steps, a table, a chart, an image, a quote, a closing) and **the layout engine owns the geometry, the type scale and the palette**, so slides come out composed rather than assembled. The colour themes are **the same eight tested palettes the PDF documents use**, so a deck and its report look like they came from the same place. Reading works on anyone's deck — every slide's text and speaker notes, in order — and editing is exact-match text replacement that leaves PowerPoint's own structure untouched, because a generic rewrite is what makes PowerPoint refuse a file. A deck you upload is now read properly too, instead of being unzipped by hand.

### Word Documents That Stay Editable

A generated .docx used to be formatted the way a screenshot is formatted — every heading hand-styled, so changing the look meant changing every paragraph. Documents are now built on **real named Word styles**, which is how Word itself expects a document to be put together: open one, change the Heading 1 style, and **the whole document follows**. There is a design step that sets the document's look up front, a **structural check** that catches a broken file before you ever open it, and a **render-and-look pass** so Wolffish sees the page you will see. Three ways find-and-replace used to quietly corrupt a document have been found and fixed.

### Spreadsheets That Actually Recalculate

A workbook full of formulas could come back as **a grid of empty cells**: the formulas were written but no value was ever stored beside them, and anything that reads the file without opening Excel sees nothing. Every formula write now **recalculates the whole workbook** and stores the computed value with the formula — and the result **names any cell that evaluated to an error** (`#DIV/0!`, `#REF!`, `#VALUE!`) so it gets fixed before the file reaches you. Charts are now **native Excel charts** that Excel, Numbers and LibreOffice all draw and you can restyle, in seven kinds, instead of pictures pasted in. And Wolffish now works to a stated standard for what makes a workbook good: **formulas instead of numbers it worked out itself**, every assumption in its own labelled cell, and the analyst's colour convention — blue for inputs, black for formulas — in financial models.

### A Few Options, Side by Side, Ready to Copy

When the honest answer is _"here are three ways to write this"_, Wolffish used to stack three code blocks in a row and leave you scrolling between them. It now offers them as **one tabbed card**: lettered tabs across the top, the selected option underneath, and a copy button on each. The letters are the same everywhere, so _"I'd go with option C"_ points at the same thing on every screen. It follows you across surfaces — the card on your desktop and in the terminal, and **on Telegram and WhatsApp each option arrives as its own tap-to-copy message**, because tabs cannot exist there. It prints in a PDF export too, every option stacked in order.

### Wolffish Can Build a Tool Server, Not Just Connect to One

Wolffish could already connect to MCP servers — the standard way an outside service hands tools to an assistant. It can now **write one**. A scaffold command lays down a runnable server with its tools, its manifest and a README, and Wolffish then **connects to it through the same client you use** and calls its tools to see them work before handing it over. There is a written guide behind it, so what comes out follows the protocol rather than approximating it.

### A Notification Names the Conversation It Came From

A conversation that had sent five notifications could show a badge reading **2**. The phone was working out which conversation a notification belonged to by reading its **link** — but a link is where a _tap_ goes, and Wolffish deliberately leaves it off most mid-run notifications, so three of those five named no conversation at all and nothing counted them. Each notification now **carries its own conversation**, stamped by the desktop rather than chosen by the model, so the badge matches the notifications list. A tap still goes exactly where the link points, and an older desktop paired with a newer phone behaves precisely as it did before.

### The Browser Extension Gets a Settings Page

The extension's switches used to live at the bottom of the side panel, in the way of the thing you actually opened it for. They now have **their own settings page**, in a tab, split into what Wolffish shows on the page and what access it has to the browser — with a plain sentence saying why each one is needed. The on-page presence grew too: besides the pill and the cursor, the tab Wolffish is driving now carries **a soft blue glow around the edge of the window**, the same frame the desktop draws when it is using your screen, so a page being driven is obvious from across the room. It never shows up in Wolffish's own screenshots, and it respects a reduced-motion setting.

## v1.0.300 — 2026-09-16

### Wolffish Reads a Web Page as a Map of Things It Can Act On

Driving a page used to mean guessing at it: a CSS selector copied from a hunch, a click on visible text, and no way to tell whether anything happened. Wolffish now **reads the page as its accessibility tree** — the same structure a screen reader uses — and gets back every button, field, link and heading as one line with **a reference of its own**: `uid=3_4 textbox "Email" required`. It then acts on the reference, not on a guess — click it, fill it, type into it, hover it, screenshot just that element. Ask for something by description (_"the submit button"_, _"the email field"_) and it comes back with the matching references, best match first, so a three-thousand-line page costs one lookup rather than a read. Take the tree again after a click and **everything new since last time is marked with a star**, so Wolffish can see exactly what its own click opened. And every action now ends with **what the page actually did** — _navigated_, _changed_, or _no visible change_ — which turns the most common automation failure, clicking hopefully at the same wrong spot three times, into a single line that says re-aim.

### Forms That Actually Submit

Filling a form in a modern web app was a quiet failure waiting to happen: typing into a React field sets the text on screen, the framework never registers it, and the form posts **empty**. There are now two dedicated tools — one field, or a whole form in a single call — that go in **the way the framework expects**, handling text, dropdowns by their visible option, checkboxes, radios and rich-text boxes alike. The whole-form call reports how many fields landed and **names the ones that did not**. Submitting is a real submit event rather than a hunt for the button, and on a failed submit Wolffish checks whether your text is still in the field instead of retyping a long message from scratch.

### It Can Watch the Page, Not Just Touch It

With the browser debugger attached, Wolffish can now see what a page is **doing**: every network request it made with its status, size and timing — and the headers, post body and full response of any one of them — plus the page's own console output with stack traces. That is how you find the JSON endpoint behind an infinite scroll, or the failing POST behind a form that silently does nothing. It also answers the page's own **alert, confirm and prompt dialogs**, and can make a tab **pretend**: a phone viewport with touch, dark mode, a location (with no permission bubble), Slow 3G or offline, a throttled CPU — with a reminder line on every result afterwards so a tab left pretending is never forgotten. Screenshots got the same lift: **the entire scrollable page, or one element**, captured without bringing the tab to the front. The debugger itself is now **attached per tab and stays attached** — attach the tab you are working in once and keep going, instead of re-attaching at every step. Eleven new tools in this release, seventy-three in all.

### You Can See Where Wolffish Is Working, on the Page Itself

A page moving by itself is unsettling. The tab Wolffish is using now carries **a small pill reading "Wolffish is working in this tab" and a cursor that glides to each spot before it acts**, outlining the target — so you watch cause before effect rather than guessing at a result. It never appears in Wolffish's own screenshots, so what the model sees is the real page, and it disappears when the work stops. If you would rather not see it, there is a switch for it on the Browser Extension settings page.

### When the Browser Will Not Cooperate, Wolffish Names the Reason

_"Cannot access contents of the page."_ Some failures are not about the page at all — they are about the setup, and no amount of retrying fixes them. There is now a **readiness check**, on the settings page and available to Wolffish itself, that runs even with nothing connected: it looks at the extension server and its port, the browsers connected, whether the extension is missing, disabled, stale or blocked by policy, site access, incognito and local-file access, debugger availability, and on macOS the Screen Recording, Accessibility and Automation permissions. Each finding comes back as **a blocker, a limit or a note, with the steps to fix it** — and where Wolffish can fix it itself, or open the exact settings page for you, a **Fix** button does it and a **Verify** re-runs the check. Wolffish walks you through one blocker at a time in your own words instead of pasting a report. The connection between app and extension is also authenticated now with **a token minted per install**, so a stray copy of the extension cannot talk to your Wolffish.

### Inside the Page, Outside the Page

The extension stops at the edge of the page, and everything just outside it — the **native file picker**, an **OAuth or passkey popup**, a browser permission bubble, the built-in PDF viewer, a `chrome://` settings page — used to be where a browser task quietly stalled. Wolffish now knows that boundary and **crosses it on purpose**: extension tools inside the page, computer use for the window around it, and a line in the reply saying it did. The two have separate coordinate systems, so it re-aims on the side it is acting on rather than carrying a number across, holds the screen indicator up for the whole excursion instead of flickering it per click, and tells you before the first click that needs your approval.

### A Message You Send Mid-Turn Is Never Lost

Messaging Wolffish while it works had a hole in it. The message lived in memory and in the bubble on your screen — and nowhere else. So a desktop that quit or crashed before the agent read it, a phone that went to sleep or off the network at the wrong moment, or a run you stopped with the message still unread, could take **your words with it**, with no trace on either screen. Every mid-turn message is now **written to disk before you are told it was accepted**, and released only once it provably lives somewhere else — in the conversation as a real message, or in the transcript at the exact point it was read. Anything else is put back: re-sent as a normal turn through the channel it came from, or, when re-sending would restart work you deliberately stopped, **handed back into the composer as a draft** by whichever window next opens that conversation. A loop keeps asking until every message has a home, so a missed notification can delay one but not lose it.

### Documents Get Eight Tested Palettes and a Measured Page Check

Every styled PDF came out in the same blue. There are now **eight complete colour themes** — Steel, Teal, Forest, Indigo, Plum, Claret, Rust and Graphite — each a full token set with its contrast ratios checked and a specimen sheet rendered and looked at, dropping into the same components so nothing else about the document changes. Wolffish picks from the subject rather than for novelty, and a brand colour you name still wins. The bigger fix is underneath. A page could silently print its last paragraph **straight across its own footer** — the footer was pinned in place and the space reserved for it was only a comment, not a mechanism — and a page that came out a third empty looked perfectly composed in a thumbnail. Looking at rendered pages caught neither reliably; a document could survive three render-and-look cycles and still ship broken. The footer is now **a real part of the page that content cannot run under**, and Wolffish **measures every sheet before rendering it**, reporting how full each page is and whether anything was cut off — so both failures are caught as numbers instead of missed by eye.

## v1.0.299 — 2026-09-15

### Wolffish Can Run Your Mobile App, and Drive It

Wolffish now drives **iOS simulators and Android emulators and devices** with one vocabulary: boot a device, install an app and launch it with its logs attached, read the screen, touch it, and see what happened. Touches never go to a coordinate guessed off an old screenshot — Wolffish reads the app's **accessibility tree**, gets back every button, field and cell with a reference of its own, and taps the reference. Every touch returns **proof**: a close-up patch of the exact spot with a crosshair on it, and an objective verdict on whether the screen actually changed — _"Changed: no"_ means re-aim from a fresh look, not press again. Typing goes in as keystrokes for plain text and through the pasteboard for **Arabic, other scripts and emoji**, so what you asked for is what arrives. Beyond driving: screenshots and native-resolution zoom, video recording, the device log for crashes and print output, and **simulated locations, push notifications, permission grants, dark mode, the status bar and rotation**. Thirty-seven tools in all — iOS on macOS, Android everywhere.

### You See the Device Being Driven

A simulator moving by itself is unsettling if you do not know why. Whenever Wolffish is looking at or touching a device, a **blue frame sits around that device's window** with a pill reading _"Wolffish is driving iPhone 16 Pro"_, and a **ripple appears wherever a touch lands** — a stroke drawn across the screen for a swipe. It follows the window if you drag or resize it, clicks pass straight through it so it never gets in your way, and the tools that see or touch the device **refuse to run until it is up**. It comes down as the last act of the turn, and if a turn ever ends with it still on — finished, given up on, or failed — the app takes it down itself, so the frame on your screen always means what it says.

### Building an iOS App From Source, In One Call

Point Wolffish at a folder and it finds what is there: **Xcode workspaces and projects, Swift packages, Flutter, Expo, React Native and Gradle** — and how each one is run. For an Xcode app, a single call **builds it, installs it on the simulator and launches it with its logs streaming**; when the build fails, the errors come back as **file and line**, not a thousand lines of xcodebuild output. Scheme, project, configuration and device are set once for the conversation and then left out of every call after that. Whatever the framework, the loop closes the same way: run the app, then read and touch it on the device instead of guessing from the code.

### A Silent API Call No Longer Hangs Your Turn

A model provider can accept a request and then say **nothing at all** — one call measured here sat silent for ten minutes and returned a single token, another for four minutes and returned nothing — and the turn simply hung, because an open connection that never speaks looks exactly like one that is thinking. Wolffish now watches for it: **five minutes with no response whatsoever** and the request is dropped, the turn ends, and you get a card that says so. It is never retried automatically, because five minutes of silence is **your call to make** — so the card offers **Continue**, which carries on from exactly where things stopped. Nothing is lost: the files written, the tool results and the plan so far all still stand, and the note that resumes the conversation appears as a **quiet line in the feed**, never as something you said. Local models are exempt — a slow machine thinking about a long prompt is genuinely quiet.

### Computer Use Keeps Its Session, and Stops Retrying What It Cannot Fix

The screen driver's session expired after five idle minutes, and a single silent API call was enough to cross that line — after which **every** screen action refused, for the rest of the turn. The session is now kept alive for as long as the indicator is up, and if it does lapse, the next action **reconnects and repeats itself** without you ever seeing a failure. Refusals that cannot change on another attempt — a point outside the current picture, a key name the driver does not know, an action taken before the indicator is on — now come back **immediately, with the fix**, instead of burning three identical retries. Key names like _period_, _comma_ and _slash_ are understood now, and long text is typed **in one call**, with the character count reported, so a paragraph that arrived short is visible rather than silent.

## v1.0.298 — 2026-09-15

### Computer Use Stops Taking Your Mouse

Driving the screen used to mean surrendering it: every click moved **your pointer**, every keystroke went to whatever had focus, and a nudge of the mouse mid-action sent the click somewhere else. Computer use now delivers clicks, typing, shortcuts, scrolls and drags **straight to the target window in the background** — your pointer does not move, the window is not raised, and you keep working beside it. When an app genuinely cannot take background input, Wolffish steps down one rung on purpose — a brief foreground delivery with the pointer restored — and **says so in the result**, instead of failing quietly. Underneath sits a native driver for all three operating systems (macOS, Windows, Linux X11 and, where the compositor allows, Wayland), verified live on macOS and on Windows 11 against a real window with pixel-exact ground truth. Windows needed three of its own rules, all learned from that run: the hidden shell windows Windows keeps around (the Start menu, Search, a closed Settings) are never treated as targets; right and middle clicks, and typing into browsers and Electron apps, use the brief foreground delivery because those apps drop posted input; and whenever Wolffish does have to borrow the pointer, it puts it back where it was.

### A Shadow Cursor Shows Where Wolffish Is Working

The blue glow and the capture notice now travel with a **shadow cursor**: an arrow that glides to the exact point before every action, pulses on the press, and parks there afterwards, with a small label naming the target. You always see where Wolffish is about to act — and because it is a drawing on the indicator layer, it never touches your real pointer and never appears in Wolffish's own screenshots. The indicator also learned to stay honest under stress: if the system takes its window down (a display unplugged, a sleep), the next action puts it back on a display that exists, so **"on" always means visibly on**.

### A Second Way to Find Things: By Name

Beyond pixels, Wolffish can now read an app's **accessibility tree** — the same structure a screen reader uses — to find a button, field, checkbox or menu item **by its name**, click it by reference, read a field's current value, write a value directly with readback, and invoke menu paths like _File › Save As…_ without aiming at tiny items. Every pixel click also reports **the control the app says sits under the point**, so a wrong aim is caught by a single lookup rather than by eyesight. Native apps expose rich trees; web content in browsers usually exposes only the window chrome, and the result says so plainly.

### Evidence on Every Action

Each screen action now returns one evidence line: how it was delivered, the driver's verdict on whether it took effect, an objective before-and-after comparison of the screen, the element under the point, and — for the rare foreground delivery — whether **your mouse moved during it**, in which case Wolffish refuses to repeat anything with side effects. That evidence, together with what the model said it expected, is carried into the next step so the model **verifies before it plans**. A new wait tool replaces guessed delays: wait until the screen is stable, until a window with a given title appears, or until a control appears or disappears.

### Permissions, Asked Up Front

A new access check tells Wolffish — and you — exactly what this machine allows before a session starts: Accessibility and Screen Recording on macOS with the settings pane to open, the session type and compositor on Linux, elevation limits on Windows, and whether the background driver loaded. Turning the indicator on runs the same check, so a missing grant is named at the first step with its fix, never discovered as a cryptic error halfway through. The Computer Use settings page shows an **Open System Settings** button next to any grant that is missing, and nothing next to one that is not.

### More Ways to Act, All the Model's to Choose

The toolset grows from twelve to thirty-one: window listing and per-window capture (even when the window is covered), triple clicks and modifier clicks, held mouse buttons and keys, hover for tooltips, typing with _replace_ and _press Enter_ in one step, scrolling by pages, clipboard read and write, and batches that run a sure sequence in one call and stop at the first miss. The approval card names the app and window an action is going to, and **"Allow for this conversation" now allows that app** rather than one tool name.

## v1.0.297 — 2026-09-15

### A Note in Brackets Is Still a Message

The bracketed sign-off came back in a far more convincing form. A turn with nothing left to say would close on **a reasoned sentence in parentheses** — that the recap above was the reply, that the notification to your phone was already on its way — and because the note was perfectly accurate, the rules as written could not reach it. They forbade a "stand-in for silence" without ever denying the premise underneath it, that **brackets are an out-of-band channel**, so a model able to argue its case felt licensed to write one. What reached you was a cryptic fragment at the end of your conversation, explaining something you never needed explained. The instructions now name what parentheses are genuinely **for** — a real aside inside a sentence Wolffish is actually saying, a clarification, a caveat, a worked example — and only then close the channel: a bracketed note about its own output is still a message to you, and **however well it argues its case, writing it is exactly the failure it describes**. The same correction runs through every place the app speaks up about this — the always-on rule, the nudge when a turn ends on nothing, the asides about the screen indicator and the task list, and all three after-the-fact notices — so there is no wording left anywhere that still treats a bracket as a way out. Nothing was tightened on the detection side, and deliberately: catching the articulate variety by pattern would mean flagging **ordinary parentheses in ordinary sentences**. Wolffish keeps writing naturally, and a finished turn simply ends.

## v1.0.296 — 2026-09-14

### You Can Message Wolffish While It Works

A message typed into a running turn used to **wait in a queue**. Wolffish finished whatever it was doing — the wrong folder, the wrong file, the whole long detour — and only then read the line that would have stopped it; steering arrived after there was nothing left to steer. A message sent mid-task is now **handed to the work in flight**. The agent reads it at its **next step** — the moment the batch of tool calls it is running finishes, before it chooses the next one — and it lands in the conversation as a real message of yours, at the exact point it was read. So **"skip the tests folder", "use the other file", "that's enough, just summarise what you have"** now do what they say while the run is still going: Wolffish acknowledges the change in a line, adjusts, and **never redoes the work your message did not touch**. It is not a second turn racing the first — it is one run, steered from outside.

### Pending Until It's Read, and Yours to Take Back

Your message sits at the end of the feed as **its own bubble marked "Read at the next step"**, with an **X** that takes it back — straight into the composer as a draft, so a message sent too soon costs nothing. Once the agent has read it the X is gone, because a delivered message is part of the conversation and cannot be unsent. It works **everywhere Wolffish does**: the app, the terminal (type while it works; `esc` takes the last one back), your phone, Telegram and WhatsApp — and **voice notes count**, transcribed before they are handed over. A message that arrives while Wolffish is writing its final answer **keeps the turn alive** so it answers you in the same run instead of ending and starting over. Stop a turn and an unread message is handed back rather than silently applied to whatever comes next.

### A Reply Ends on Its Last Real Word

Some turns were still closing with a **bracketed note where silence belonged** — a stray `(no content)` stapled under a finished answer, or sent alone as a message of its own. Two rounds of fixes to the instructions never caught it, because the instructions were not the source: whenever Wolffish ended a turn with nothing, the app **wrote a parenthesised placeholder into Wolffish's own mouth** — a line in its voice, in its history, one message before it was asked to reply — and the leaks were that line's shape exactly. The placeholder is gone from all three places that used it, so the pattern is no longer demonstrated to the model at all. A stand-in typed anyway is now **noticed and reported back** the way a stray control token or a lone `.` already was, with the exact characters quoted, so Wolffish can see what reached you. Silence is written as nothing.

### `wolffish` Works in a New Terminal, With Nothing to Paste

Installing the terminal client wrote the command into a folder **no shell was looking in**, and left you the last step: add a line to your shell profile, by hand, on every machine. The app now **puts the folder on your PATH itself** — a marked block in the shell profiles on macOS and Linux, the user PATH on Windows — checked on every start, removed cleanly on uninstall, and never touching a line you wrote. Settings, `wolffish path` and the status screens now say **"open a new terminal"** instead of handing you something to copy, and only show the manual line if the app could not do it. Finding the command on Windows is also fixed: it is matched however the name is cased on disk.

## v1.0.295 — 2026-09-14

### The Terminal Is Now a Real Screen

`wolffish` in a terminal used to be a line at a time: type, wait, read, and hope the tool calls you could not see were going somewhere. It is now a **full-screen terminal client**, on par with the app it belongs to. The conversation streams into a scrolling feed with the same cards the app draws — **tool calls with their output, file edits as diffs, delivered files, todo lists, workflow rosters, background tasks and countdowns** — and the prompt at the bottom is a real editor: **Shift+Enter** adds a line, a long paste folds into a placeholder, **`@path`** completes and attaches a file, **`/`** completes every command. Under the prompt sits what a chat window shows for free and a terminal never did: the **mode, model, thinking effort, plan mode and project** on one line, and while a turn runs, **what the agent is doing right now, how long it has been at it, how much of the context window is used, and what it has cost** — the app's context meter, made for a terminal. Approvals and questions arrive as **cards you answer with the keyboard** (allow once, allow always, deny; pick an option by number), a prompt typed mid-turn **queues** instead of being refused, `esc` twice **interrupts**, and if the app restarts under you the terminal **reconnects on its own** and picks the conversation back up.

### Everything the App Can Do, From a Box With No Screen

**`ctrl+p`** opens a command palette that lists every command with its key; **`ctrl+x l`** switches conversations from a fuzzy-searchable list with rename and delete; **`ctrl+x m`** switches the model, then the thinking effort; plan mode, chat mode and the project bound to the conversation each have a key and a slash command. **Settings** open as the app's own page → card → row browser — every switch, number, choice and secret edits in place, every action the app has (pairing a phone, testing a key, adding an MCP server, installing an engine) runs from the same list, and a search reaches across every row at once. **Usage** shows the same totals, providers and models as the app's panel with a range picker and a daily strip; **status** shows the daemon, brain, autostart, PATH and channels. Projects, procedures, automations (with what is running and queued), delivered files, parked approvals, background tasks and the daemon log each have a dialog. Everything that took a `--json` flag still does, and `wolffish -p "…"` with a pipe still prints plain text and exits — scripts do not change.

### Built Into the App, Updated With It

The client is now a **compiled program of its own**, shipped inside the app and pointed at by the same `wolffish` command as before — nothing to install, nothing to keep up to date, and an app update replaces it in the same step. On Windows it is a proper console program, so the extra launcher the old client needed is gone. The terminal's own small preferences — its theme, prompt history, recent models — live with the app's data, so a machine you reach over SSH remembers them too.

### HTML Files Run Live in the Chat

An HTML file in the chat — a game the agent just built, a report, a page — used to render as a static picture of its markup: the app's own security policy silently blocked every inline script, so anything interactive showed a blank canvas. The card now hosts the page in a **real browser tab of its own**: scripts run, the canvas draws, keys and sound work, `localStorage` persists between opens, and relative assets and CDN loads resolve as they would in Chrome. The card shrinks a wide page to fit; the expanded view shows it at full size, with **Reload** to start over and **Developer tools** to look inside. Every guest is hardened by the app — no access to the app's context, popups and outbound links go to your system browser — and a file too large to show as source still previews live.

## v1.0.294 — 2026-09-13

### A Restart Waits for the Reply, Then Counts Down Where You Can Stop It

Asking Wolffish to restart, shut down or log out used to hand the job to a hidden timer: the agent scheduled the command twenty seconds out in a detached shell and moved on, with no way to cancel it on a Mac or on Linux, and a failure to even start that timer was reported to you as success. The whole thing is rebuilt around one rule: **nothing that would cut off the agent's own reply runs inside the turn**. A power action is now **armed** rather than run — the agent finishes its answer, the conversation is saved, and only then does a **countdown card** appear in the chat with the action's name, a bar draining over ten seconds, and an **Abort** button. When the bar empties the command runs; press Abort and it never does. The card is a real part of the conversation, so it appears on your phone with the same Abort button, and a conversation opened later shows exactly what happened — **ran, aborted by you, or dropped** because the turn was stopped before its reply landed. On a chat channel, `/cancel` aborts it. Nothing stays pending across a relaunch: a countdown the app went down with is recorded as dropped, never left counting. The escape hatch survives for the one case it exists for — a user who says "restart now" and accepts losing the tail of the turn.

### Any Action Can Take the Same Countdown

The restart is the first user of a general mechanism, and the agent has it as a tool of its own. **`countdown_start`** arms any tool call to run a few seconds after the reply is finished, on the same card with the same Abort — quitting the app, an irreversible cleanup, anything you would want a last chance to stop. The armed action is checked against **the same safety rules as calling it directly**, and if it needs your approval, the approval card is raised at the moment it is armed, never later when no one is there to answer. One countdown is pending at a time; arming a second replaces the first. Automations cannot arm one at all, because no one is watching their card.

## v1.0.293 — 2026-09-12

### A Finished Turn Ends on Nothing, Not on a Note About Nothing

When a turn had nothing left to say — the answer already delivered, the phone already notified — Wolffish's own instructions told it to end with nothing, and printed the mistake it must not make: the offending note itself, in quotes, as the example not to write. A model that has decided to say nothing reaches for the nearest token, and the nearest token was the one the instruction had just shown it. So a finished turn could close with that note typed after a real answer and delivered to you as part of it, twice in one conversation. Every one of those instructions — the standing procedures and both runtime notices — now **names no example at all** and never prints the phrase it forbids. They describe the class of mistake instead (a bracketed status note, a written statement that you are staying silent, a lone "." or "…"), say outright that **nothing is ever structurally required in a reply**, and cover the shape that leaked: a substantive answer **never carries a trailing marker** — it ends at its last real character. Silence is written as nothing, which is what it always meant.

## v1.0.292 — 2026-09-12

### An Automation Card Says When, at a Glance

The schedule an automation runs by — `Daily (09:00)`, `Weekly (Mon 09:00)`, a raw cron line — used to open **the small grey line of code at the bottom of its card**, sharing two clamped lines with the next run's date, the project and the edit stamp, where a long one could be cut off before you ever read it. It now carries **a chip of its own**, paired on one row with the countdown: **when it runs next on one side, the rule it runs by on the other**, pushed to the card's two edges the way the On/Off and Single/Workflow switches above them are. The chip wears **the glyph of its period** — a sun for a daily run, a briefcase for weekdays, a calendar for weekly and monthly, a stopwatch for hourly, a rocket for one that fires when the app starts, angle brackets for raw cron — so the shape of an automation registers before you read a word of it, and **a long cron drops to its own line rather than squeezing**, keeping the card's full width. The line of code below is left with **only what it was always for**: the exact moment of the next run, the project it belongs to, and when you last edited it.

## v1.0.291 — 2026-09-11

### Updates on Mac Come Back

Clicking **Update** on a Mac would sometimes close Wolffish and then — **nothing**. No relaunch, and when you opened it yourself it was still the old version. The cause was a race: on macOS the system's own installer has to unpack and check the 300 MB bundle **after** you click, and Wolffish gave it a fixed five seconds before forcing itself shut. On a busy disk that is not enough, so the app died with the update half-prepared. Wolffish now **prepares the update first, while it is still fully running**, and only begins shutting down once the installer confirms it holds the new version. If preparing fails, **nothing is torn down**: the app stays open, tells you the install did not go through, and lets you try again. The same rule now holds on every platform — Wolffish **never force-quits with nothing installed**; if the installer could not be armed after shutdown had begun, it relaunches the current version instead of vanishing. One honest note: the update that _brings_ you this version is still carried out by the old code, so it may misbehave one last time — the update after it is the first to run the fix.

### Install Failures Say So

If an install failed, the **Update** button used to sit greyed out on "Installing" for good, in both the chat card and Settings → Updates, with no way back short of restarting. Both now show **what went wrong** in place of the release notes, turn the button into **Retry**, and read **"Installing…"** while the work is actually in progress.

## v1.0.290 — 2026-09-11

### Several Times a Day Is One Automation

"Sweep the inbox at 8, at 2 and at 8" used to mean **three separate automations** standing in a row, each with its own card, its own history and its own edit. A schedule can now **carry a list**: `Daily (08:00, 14:00, 20:00)` fires three times a day, `Weekday (09:00, 17:00)` twice on every working day, and `Weekly (Monday, Wednesday, Friday 09:00)` three times a week. Days and times can **both** be lists — `Weekly (Monday, Friday 09:00, 17:00)` is four runs a week from one line — day names take **Mon, Tue, Wed** as readily as the full word, `Monthly (1, 15 09:00)` covers the first and the fifteenth, and the times need not share a minute, so `Daily (08:00, 12:30, 18:00)` is fine. The card's countdown follows: a schedule like that shows **its next run rather than its first**, so an automation that fires at 08:00, 14:00 and 20:00 reads 14:00 when you look at lunchtime. Everything already written keeps working **exactly as it did** — a single value is simply the one-item list.

### Pick How Many Times, Then the Period

Above the schedule field there is now **a row of count pills** — Once, Twice, 3 times, 4 times, 5 times — that reads as one sentence with the period chips beneath it: **"3 times" · "Every day"** fills in a `Daily (…)` with three times spread evenly across the day, anchored on now. Pick them in either order. Both rows **light from what is actually in the field** rather than from your last click, so opening an existing automation — or typing a schedule by hand — shows you its own period and its own count.

### Code Blocks Without a Language Tag

A fenced block with no language on it — just three backticks — rendered with **a second, darker box drawn inside it**, sized to the text instead of the block and plainly visible in light mode. Wolffish was deciding "block or inline snippet?" by looking for a `language-` class that an untagged fence never carries. It now decides by **where the code sits**: inside a fence, it is a block.

### Previews on the Right Ground

The **Word and spreadsheet previews** painted themselves on the window's background rather than the card's, leaving a document sitting in a well slightly darker than the card holding it; they now use **the same ground every other card paints on**. The **folder chips along the top of a transcript** were translucent, which let the lines scrolling underneath **ghost through them** — they are solid now, so the strip reads as chips over the transcript instead of a smudge of it.

## v1.0.289 — 2026-09-11

### Ollama Stops Asking to Be Installed

A first run used to walk you from the welcome screen straight into **install Ollama**, and from there into **pick your Ollama model** — two full-screen pages that carry none of the app's navigation, so anyone who simply did not want a local model had nowhere to go. Wolffish now treats Ollama as what it is: **one optional provider among several**. Onboarding is **a theme, a language, and then the chat** — nothing else. The model picker no longer exists as a screen at all; it is **the Ollama panel of Settings → Models**, where you go looking for it when you actually want it, and every way in is a button you chose to press. Launch itself now **asks Ollama nothing** — no probe, no tag list, no quietly rewriting your configuration before the window is even up.

### The Models Panel Stays Where You Are

Finishing a download used to **throw you out of Settings and into the chat**, because the picker was built as a step in a flow rather than a panel you had opened on purpose. It now **stays exactly where you are**: the list comes back with your new model marked as the current one, and the panel re-reads what Ollama actually holds, so **re-downloading a model your configuration already names** no longer leaves the card standing there still offering "Install". The buttons that belonged to that old flow — "Skip for now", "Back to chat" and "Continue to chat" — are gone, because **Settings' own sidebar and back chevron** were always the way out of a panel.

### When a Local Model Goes Missing

Delete a model with `ollama rm` and Wolffish used to carry on believing it still had one: the composer stayed live, the notice that points you at Settings stayed hidden, and you found out by **sending a message and getting a raw provider error back**. The chat now reads the **daemon's live state** — a background watch the app already keeps, not a new probe of its own — and tells you plainly that **your local model is no longer installed in Ollama**, with the same one-click path to Settings → Models. A daemon that is merely switched off is left alone, and so is one that stumbles for a moment before answering: neither is reported as a missing model. And the **Stop button is now gated on nothing at all**, so a turn running on a model that vanished mid-generation can still be stopped.

## v1.0.288 — 2026-09-11

### Wolffish Writes Code Now

Point a conversation at a code project and Wolffish stops being an assistant that happens to own a shell and becomes **a coding agent that works the way you would**. It begins by **reading the project instead of guessing at it**: the runtime now tells it which of your working folders are real projects, **what branch each one is on and how many uncommitted changes it carries**, which toolchain it uses, and **the exact check commands that project exposes** — and it reads the project's own `AGENTS.md` or `CLAUDE.md` first, so a repository's house rules outrank anything Wolffish believes by default. Three new tools do the work: **`file_edit`** makes a surgical, exact-string change and shows you the diff instead of rewriting a file whole; **`file_grep`** searches file contents with ripgrep across a codebase of any size, respecting `.gitignore`; and **`file_glob`** finds a file by name. Every edit is followed by two steps you never have to ask for — the **project's own formatter** runs on the file when the project demonstrably uses one, and the **project's own TypeScript, ESLint, Ruff or Pyright** is asked what it thinks, with any errors handed straight back so they are fixed in the same turn instead of surfacing at build time. And a change is not done until a check passes: the narrowest test first, then the project's full typecheck, lint and tests, with a failure reported rather than hidden. All of this is attached **only when the working folder really is a code project** — an ordinary conversation carries none of it.

### Plan First, Change After

A new **Plan chip** sits in the composer beside the draft-editor button. With it on, a turn **cannot change anything**: it reads, searches and investigates, then ends by writing a plan — the recommended approach, the files it will touch, the steps in order, and how the result will be checked — and tells you to turn Plan off to run it. It is a stance you take for a conversation rather than a property of its transcript, so it is held in one place and **shared with your paired phone**: set from either surface, and the other follows at once. A brand-new chat can carry the stance before it even has an id. Turn it off and the next turn is told, once, that the plan is now approved to act on.

### Every Change Arrives as a Diff

A file edit and a shell run used to look like every other tool call in the feed. They now get **a compact activity row of their own** — a short label, the file or the command, and a chip reading **`+12 −3`** for an edit or **`exit 0`** for a command, green or red. Open the row and an edit shows **the real unified diff**, red and green with the true line numbers down both sides; a command shows its output and, when the output was long, **the path of the file holding all of it**. The diff travels on the result itself, so **a conversation reopened next week renders exactly what it rendered live**.

### The Task List

When a job runs to three steps or more the agent now keeps **a task list**, and it appears in the chat as **a checklist card**: exactly one item in progress, an item ticked off only after the check that proves it really ran. The card **updates in place** rather than stacking a new copy on every revision, so a long run leaves one list in the transcript showing where things stand. It reaches the paired phone and the exported PDF the same way.

### Putting It Back

Before the first change a turn makes to a file, Wolffish now **keeps the original bytes**. `changes_list` shows what each recent turn touched, and **`changes_revert` puts a turn's files back** — the whole turn, or one file of it. It needs no git, works in any folder, and keeps **the last twenty turns** of each conversation. It exists for one sentence you have certainly said before: _that fix made it worse, put it back_.

### Allow It for This Conversation

The approval card has a second button. **Allow for this conversation** approves the call in front of you and stops asking about **the same kind of call for the rest of the chat** — the same tool, and for the shell the same command head, so allowing `npm install` once never quietly allows `git push` later. Anything blocked outright never reaches this card and never gets the button.

### Approvals That Read the Path, Not the Code

Writing a file whose **contents** happened to mention a path used to stop the agent and ask you about it. An ordinary relative import — `import x from '../lib/x'` — raised a red **"Path traversal attempt"** card, the app's most severe warning, over a line of perfectly normal code; a shell script beginning `#!/usr/bin/env node` was announced as **"Modifying system files"**. The rules were reading the whole call, text and all, instead of the one thing they are about. They now read **the path being written**, and nothing else. A genuine traversal such as `../../../etc/hosts`, and a genuine write into `/etc`, `/usr` or `/private`, still stop and ask exactly as before, on a file tool and on a shell command alike — and the rules that are about a command, not a path, are untouched. One thing genuinely relaxes: a shell command that merely walks up a directory, `cd ../sibling && npm test`, no longer counts as an attempted break-out. This one is older than the rest of this release; it simply became impossible to ignore once the agent started sending whole blocks of code through those very fields.

### The Feed Shows the Work, Not the Mechanics

The switch that controls how much of a turn you see carried the name **"Verbose task results"** on four different surfaces — a name describing its setting rather than what you would see. It is now **"Show all tool activity"** everywhere: desktop, phone, terminal, Telegram and WhatsApp. More usefully, **what a clean feed always shows has grown**. With the switch off you now see the replies, the delivered files, **the code edits and shell runs**, the questions and approvals, the reasoning and the task lists — only genuine mechanics stay out of sight. Along the transcript's top edge there is also a new strip of **folder chips: every folder this conversation changed files in, and how many**, each one a click away from opening on your desktop. Going the other way, **the live run cards are gone** — the card that covered the chat while an automation, a procedure, a compaction or a reflection ran has been removed along with its four switches, because each of those runs already reports itself on its own page and the card only ever sat in front of what you were reading.

### Output That Keeps Its Ending, Servers That Can Be Stopped

A long test run's output used to be cut off past about 100 KB — it kept the beginning and **threw away the bottom of the log**, precisely where the failure is reported. Long output now keeps **the last 2000 lines or 50 KB**, and **the full text is written to a file the result names**, so nothing is lost and the agent can search the log for the failing test instead of running everything again. Commands also **run in your working folder by default** now instead of your home directory, so `npm test` and `git status` land in the project without being told where it is, and they come back with the colour codes stripped out. A command shaped like a dev server or a watcher is **refused in the foreground** rather than hanging the turn: it is started in the background instead, with **`shell_jobs`** to list what is running and **`shell_stop`** to end one or all of them before the turn finishes.

### Simulators, on Both Phones

A new **Mobile simulators** capability puts iOS and Android on the desk: **nine `sim_` tools** for the iOS Simulator — list the devices, boot one, build, install, launch, terminate, screenshot, read the log, open a deep link — and **seven `adb_` tools** for an Android emulator or a plugged-in device, tapping and typing included. "Does the new screen look right?" is now a question the agent answers by building the app, launching it and looking.

### The Local Models Group Waits for Ollama

The composer's model card used to **ask Ollama what it held every single time you opened it**, then re-render when the answer arrived — and it offered a local group whether or not the daemon was actually running. Wolffish now **watches Ollama in the background**, and the card simply reads an answer that has already settled: the local group is there exactly when Ollama can answer, the same way a cloud provider's group is there exactly when it has a key. Opening the card costs nothing, and nothing shifts under your cursor.

## v1.0.287 — 2026-09-11

### DeepSeek's New Flash Can See

DeepSeek has retired its whole **V4 Flash line** and replaced it with one model, **DeepSeek-V4.1-Flash**, served under the plain name `deepseek-flash`. It is now the **default DeepSeek pick** in the model catalog, and it wears a **vision badge** for the first time in that provider's row: it reads the images you attach and the screenshots computer use takes, so driving the screen on DeepSeek no longer means switching to another provider first. It is also markedly **cheaper** — input at **$0.15 to $0.30** and output at **$0.60 to $1.20** per million tokens depending on the hour, with cache hits close to free — and the catalog now shows those rates. Underneath, the app finally recognises a name that carries **no version number**: until now a chat on `deepseek-flash` would have been quietly treated as an **8K-context, 16K-output** model instead of the **1M-context** one it is, and every image would have been stripped before sending because the app still believed DeepSeek was blind. The retired names keep working — DeepSeek routes them to the same model, and the app now treats them the same way. `deepseek-v4-pro` stays listed at its own prices for the few days it has left; from **14 September** DeepSeek routes it to V4.1 Flash as well and bills the Flash rate.

## v1.0.286 — 2026-09-10

### Automations, Projects and Procedures Become One Library

The three pages that hold what the agent **runs on its own**, what it **starts a conversation from**, and what you **run on demand** sat behind three separate sidebar entries, each opening a near-identical grid of cards under its own back button — so finding the thing you wanted to edit began with remembering which of three lookalike pages it lived on. They are now **one Library page with three tabs**, the same shape Customization took for Soul, User and Agents: the back button leads, the tabs sit beside it, and the grid fills the rest. Nothing on the cards changed — creating, editing, playing and deleting all work exactly as before — and the Automations tab keeps its **cards-or-markdown switch**, now at the far end of the same row as the tabs rather than in a header of its own. **The tab you left on is the one you come back to** after a detour through chat, so a look at what is scheduled never costs you your place among your procedures. The sidebar is one row shorter for it, in English and in Arabic alike.

## v1.0.285 — 2026-09-07

### The Stray Period at the End of an Answer

Every so often a finished answer was followed by **a message containing nothing but a full stop**. It arrived under a reply that was already complete, said nothing, and left you wondering what the agent had meant by it. It meant silence. When the work is done and the notification has gone out, the runtime tells the agent there is nothing left to reply to — and the correct way to finish there is to write **nothing at all**. But a model asked to send nothing cannot always send _nothing_, so it typed **the smallest mark it could find** and sent that instead. The app never edits a word the agent writes, on purpose, so the answer was never to quietly delete the character — it was to make sure the agent knows a lone `.` is every bit as visible as a sentence. It is now **told exactly that, the next time it speaks**, along with what you actually saw on your screen, the same way it is already told when a raw tokenizer marker slips into a reply. The instructions it works from **name the case outright** now, too, so the far more common outcome is that it never types the character in the first place. A reply that is genuinely just punctuation because you asked for it — a divider, a row of dashes — is left alone.

### The Context Meter Waits Until It Has Something to Show

A brand-new chat opened with **an empty gauge sitting in the composer row**, and hovering it produced a card that said only "No usage yet" — a control that existed to tell you nothing, beside the logs and files chips that had already stopped doing exactly that. The meter now **joins the row the moment it has a reading**, on your first send, and stays away until then. Next to it, the button that opens the full-height draft editor wore **the four-arrow mark the file, PDF and video viewers use for "make this bigger"**, while its own label reads "Write your message" — it now wears **the pencil** that the project, automation and procedure cards already use to open an editor, at the same size as every other icon in that cluster.

## v1.0.284 — 2026-09-06

### The Composer Expands Like Everything Else

The last release moved the **automation, project and procedure** editors into the full-height panel when you ask their prompt for more room. The chat composer's own expand button was **the one left over** — it still opened a box floating in the middle of a dimmed screen, so the same request meant two different shapes depending on which text you happened to be writing. It now opens **the same panel**, over the same draft, so what you write in it is what the composer sends the moment you close it. It also has **a close button and answers Escape**, where before the only way out was clicking the dimmed area behind it — and that click is gone on purpose, because **a stray one while you were writing used to shut the editor mid-sentence**. The button itself finally **says what it does** when you hover it, instead of being a bare icon.

## v1.0.283 — 2026-09-06

### The Expanded Prompt Editor Joins the Panel

The last release moved the **automation, project and procedure** forms into full-height panels that slide in from the edge. The button that gives your prompt more room, though, still opened **a box floating in the middle of a dimmed screen** — a second shape stacked on the first, for the very same act of asking for space. It now opens **the same full-height panel**, the one the file and PDF viewers already use, so writing a long prompt widens the surface you are already on instead of covering it with another. It also finally has **a close button**: before, the only ways out were Escape or a click on the backdrop, and that backdrop click is gone on purpose — **a stray click while you were writing used to shut the editor from under you**. In Arabic on a Mac, the expanded viewer's title also no longer sits **underneath the window buttons**.

### The Prompt Comes First

In all three editors the prompt sat **below the file list and the folder list**, so the one field the whole form exists for was the one you had to scroll past everything else to reach — and the longer your file and folder lists grew, the further down it went. It now sits **directly under the name and project**, with files and folders beneath it. Projects already worked this way; automations and procedures now match.

### Cards That Say What They Hold

A project card now shows **how many files and working folders** it carries into every conversation it starts, as two small chips beside the name — and shows **nothing at all where there is nothing**, rather than an empty "0". On a procedure card the **Single / Workflow toggle moved up beside the buttons**, giving the name a full line of its own. Both cards now close with **the same small monospace line the automation cards use** — when it was last edited, when it was last used, how many conversations — so the three pages read alike, and every card in a row ends on the same line however much it holds.

## v1.0.282 — 2026-09-05

### Soul, User and Agents Become One Page

The three documents that shape the agent — its **personality**, the **facts about you** it should always know, and **your own procedures** — sat behind three separate sidebar entries opening three near-identical editors, so adjusting how the agent behaves began with remembering which of the three held the paragraph you meant. They are now **one Customization page with three tabs**, the shape your phone already uses. Each tab states in a line **what its document is actually for**, so the choice no longer rests on a single word. A draft you leave in one tab is **still there when you come back** from another, and that tab **carries a dot while it holds unsaved changes** — which is exactly the draft you can no longer see. Edits made on your phone or in another window still arrive on their own, and now they land on **whichever tab is clean** rather than only the one you happen to be looking at.

### The Files Sheet Lists What the Conversation Actually Has

**View Files** had been drifting into a list of things that were not there. A long run names plenty of files it then cleans up — a PDF check renders proof pages, looks at them, re-renders and deletes the batch — and every one of them stayed in the sheet as a **tombstone you could click but never open**. Files the agent merely **read for reference** landed there too, so a morning digest that consulted last week's reports filled today's sheet with **last week's files**. Meanwhile the one file you were most likely looking at — **a meme or a GIF the agent had just made and shown you inline** — was the single file the sheet never listed at all. All three are fixed: the sheet now **checks what is still on disk** and counts only that, **a file read for reference no longer counts as this conversation's**, and **generated media appears the moment it does**, while the answer is still being written. When a picture is genuinely gone, its placeholder **fills its column** instead of sitting in it as a narrow stub.

### The Logs and Files Chips Earn Their Place

The two chips beside the composer were **always mounted and merely greyed out** when they had nothing, so a brand-new chat opened carrying two dead controls advertising sheets that were empty anyway. Each one now **joins the row when its first event or file lands**, the same way the export button waits until there is something to export. They also **wear the same frame as the context meter** they sit beside, instead of standing bare next to a bordered pill.

## v1.0.281 — 2026-09-05

### The Leak That Broke Every Tool at Once

Leave the app open long enough and **everything that runs a program would start failing at the same moment** — Google Workspace announcing that gogcli "is not installed", video and audio conversion falling over, a shell command dying with nothing useful to say. Each one reported the failure as its own local problem, so none of them pointed anywhere near the cause: the file watcher that keeps your workspace searchable was claiming **one system handle for every single file it watched**, and a lived-in workspace is tens of thousands of files. Once the app ran out of handles it could no longer start **any** program at all, and every tool went down together. The watcher now holds **one handle for the whole workspace** — eleven of them instead of twenty-three thousand, and it stays eleven however far your workspace grows. It also notices folders created after the app started, which the old watcher quietly missed on a fresh workspace.

### Installing Google Workspace Explains Itself

When the Google Workspace install or update failed, all you got was a toast reading **"Install failed"** — which then vanished, taking the only account of what happened with it. The real reason now **stays on the card** in plain words: GitHub's hourly rate limit, a release that has moved, a file that won't run, a path the app can't write to. Install itself is **repairable now**, too. It unpacks to a scratch folder and swaps the finished binary into place in one move, so a download that dies halfway **leaves your working copy untouched** instead of replacing it with a truncated one — and the state that used to make Install fail forever, however many times you pressed it, now clears on the first try. An update that lands a binary which won't actually run **reports that as a failure**, rather than showing you a green checkmark while every Google call quietly fails.

### The Edit Forms Get the Whole Window

The editors for **automations, projects and procedures** were boxes floating in the middle of a dimmed screen — and a real one, with a schedule, a file list, a folder list and a prompt, grew straight past the bottom of the window with **nothing to scroll and the Done button somewhere off-screen**. All three are now **full-height panels that slide in from the edge**, the same surface the logs, files and conversations sheets already use: the form scrolls, while the title and the Done bar stay put. The three list pages also dropped from three columns to **two**, so a long automation name, its schedule and its controls all stay readable instead of being squeezed into a third of the window.

### Every Automation Says When It Runs Next

An automation card gave you its schedule in **small grey text among everything else** on the card — the one fact about a scheduled job that changes on its own, buried in the one line that never does. Each card now leads with **a countdown chip**: _Next run in 3 hours_, in the same shape the composer wears for its model. Inside the final minute it **counts down by the second**, and when the moment passes the card **rolls forward to the next occurrence by itself** instead of sitting on a time that has already gone. A switched-off automation wears the chip greyed out rather than promising a run that isn't coming. The exact wall-clock time, the schedule's own syntax and when you last edited it moved to a small monospace line at the foot of the card — and the editor now **previews the very same chip** the card will wear once you save.

## v1.0.280 — 2026-09-05

### A Turn That Survives the Power Going Out

Until now a conversation reached your disk **exactly once — at the very end**. A run that worked for forty minutes across a dozen tool calls existed nowhere but in the app's memory while it worked, so a crash, a force-quit, an update installing itself, or a Windows restart threw the whole thing away and left you with **your question and nothing else**. Every in-app turn is now **written to disk as it happens**: the answer so far, every tool card, the task timeline. The prompt lands before the first word arrives, the slow and expensive parts — a tool call, its result, a task flipping to done — are saved within a second, and the prose follows a few seconds behind. Quit the app mid-run, restart the machine, pull the plug: **the conversation comes back with the work in it**, marked as the run that never got to finish, and nothing about a turn that ends normally changes at all.

### Restarts Wait for the Answer to Land

Asking the agent to restart your machine used to take it down **that instant** — including the turn that was still being saved, so the very answer telling you it was restarting went down with it. A restart or shutdown is now **scheduled about twenty seconds out**, which is far longer than saving needs and short enough that you won't notice waiting. The agent tells you what is about to happen and how to stop it (`shutdown /a` on Windows), gives the machine longer when a download or a long write is still in flight, and can still go down immediately if you explicitly ask for it. It also **can't sneak a reboot through the terminal** any more — that path skipped both the approval card and the delay.

### Screenshots as Sharp as the Task Needs

Screenshot resolution and format used to be **two settings you had to find and tune yourself**, and every capture came out the same regardless of what it was for. Both are now **chosen per screenshot by the agent**, which knows what it's looking at: an ordinary hunt for a button stays small and fast, while **reading a page of code, judging spacing and color, or handing you a screenshot to keep** goes up to 2560 pixels and lossless PNG. Ask for a **higher-resolution or sharper screenshot** at any point and it simply takes one — it is a choice on the next capture, not a preference buried in a panel. The old settings are gone from the app, the terminal and your phone, because nothing needs to write them any more.

### Your Voice, Changed by Asking

Changing how the agent **speaks** or how it **hears you** meant opening Settings and finding the right panel. Now you just say it. **"Use a British voice"**, **"you're talking too fast"**, **"transcribe in Arabic from now on"**, **"use a more accurate model"** — the agent reads your current settings, changes the one you meant, and tells you in plain words what it changed. It can also **install the voice and transcription engines on request**, with the same progress bar the panel's own button shows. Whatever it changes, the **Settings panel and your phone update live**, and it will only ever set a voice, speed, model or language that every screen can actually display — so a default it sets for you never silently reverts.

### Automations, Procedures and Projects at a Glance

All three pages listed their entries as **tall stacked rows**, each one carrying its full prompt, its attached files and its folders — so four automations filled the window and finding one meant scrolling past everything it contained. They are now **three-column grids of compact cards**, matching the Services page: an icon, the name, the two lines that matter, and the controls. The prompt, files and folders live in the editor, which is what the editor is for. Automations also finally have **a name of their own** — "Morning digest" rather than "Daily (08:00)" — so a card tells you what a job _does_, with its schedule reading underneath.

### Logs and Files, One Click Away

The **Logs** and **Files** buttons were folded inside the context meter's hover card, so reaching either meant hovering one thing to click another. They now sit **right in the composer footer** as two small chips carrying their own counts — one click, no hover. Both sheets, along with the **expanded file and PDF viewers**, also stopped being boxes floating in the middle of a dimmed screen: they now **slide in from the edge as full-height panels**, mirroring the conversations sheet on the other side, so a long document or a long timeline gets the whole height of the window to be read in.

### Thinking, Shown or Hidden

The model's reasoning card is welcome company for some people and clutter for others. There is now a **Show reasoning** switch in Preferences — **on by default**, and shared by this app and your phone so the two never disagree. Turning it off **hides the card and nothing more**: the model still thinks exactly as before, and the reasoning is still saved with the conversation and still included when you export it, so switching it back on brings every thought back with it.

## v1.0.279 — 2026-09-04

### One Model, One Chip

The composer carried **two labels side by side** — a Local one and a Cloud one — as though both were somehow live, when only ever one model answers you. There is **a single chip** there now, and it shows **the model that will answer**: your provider's logo and its name, or Ollama's logo and your local model's name. Click it for the same searchable card as before. Choosing a model **is** the switch — pick an Ollama model and you are running local, pick a cloud model and you are running that provider — so the checkmark in the list marks **the one model you're on** instead of one per side. Your local model always keeps a row of its own in that list, so it is there to pick even when Ollama isn't answering.

### The Export Button Waits Until There's Something to Export

The **download-as-PDF** button sat in the header of every conversation, greyed out and unclickable until the chat had something printable in it. On a **brand-new conversation it is simply not there** now, and it appears the moment there is something worth exporting — a dead control says less than no control at all.

## v1.0.278 — 2026-09-03

### The Model List Comes Back

The composer's model card spent a version speaking in chips — three sideways-scrolling rows you had to drag through to find a brain. It is **a list again**: your installed Ollama models on top, then a group per connected provider, each model on its own line with its **size, badges and context window**, and a checkmark on the one you're using. It **scrolls down the way a list should**, never sideways, and the **search box is back at the top** — type a few letters and it filters local models and every provider at once. The chip rows stay where they belong, on the project pickers and the phone.

### Long Model Names Fit the Composer

The **Local** and **Cloud** labels under the composer were capped so tightly that any name past about twenty characters got cut off mid-word — a long Ollama tag or a full vision-model id showed as little more than a stub. The cap is now **wide enough for every model in the catalog**, so the composer tells you which brain you're on at a glance instead of leaving you to guess from the first half of its name.

## v1.0.277 — 2026-09-02

### Reasoning in Plain View

The **Reasoning** card no longer folds the model's thinking behind a click. It is now an **open scroll block, styled like a tool's output**: the thinking sits right there under a small brain icon, grows with what it holds up to **eight lines**, and scrolls inside its own box past that — a one-line thought takes one line, and a long deliberation never swallows the conversation. Hover the block and a **copy** button appears, putting the whole thinking on your clipboard. When a model opens its reasoning with a heading, that **heading becomes the card's title** instead of the plain word "Reasoning". While a reply is still streaming, the block **follows the newest line** as it arrives and stops following the moment you scroll up to read — and a conversation you reopen shows every card from its first line.

## v1.0.276 — 2026-09-01

### Reasoning That Opens at the Beginning

Tapping a turn's **Reasoning** card used to drop you at the tail of the thinking — its first line flung far above the screen — and closing it could hurl you all the way back up to your own prompt. The card now minds your place in the conversation: expanding scrolls **the head of the reasoning into view** so you always read the thinking from its first line, and collapsing carries you **straight back to the newest message** at the bottom. If the reasoning is short enough to fit where you already are, **nothing moves at all** — and opening a conversation still lands pinned to the end, exactly as before.

## v1.0.275 — 2026-09-01

### Write the Prompt Right Where You Read It

The prompt in the Automations and Procedures editors — and a project's instructions — used to be a preview you had to click to edit, and clicking it anywhere flung open a full-screen sheet. That block is now **a real editor, sitting right in the dialog**: type in place, scroll a long prompt inside it, and everything autosaves exactly as before. It keeps **one fixed height, filled or empty**, so the dialog never jumps around as the text grows, and it wears **the same recessed look as every other input field**. The **Edit** button below is now the one thing that opens the full-screen editor — for when a prompt deserves the whole window — so reading, selecting, and scrolling never open anything by surprise.

### Projects Are One Tap Away

Binding an automation or a procedure to a project meant opening a dropdown that hid the list and truncated the name it showed. The picker is now **a row of chips, the whole list on one line** — each project wearing its own emoji and title, **No project** first — and the row **scrolls sideways** however many projects you have, with the chosen chip carried into view when the editor opens. One tap to bind, one tap to unbind, exactly like the picker on the phone.

### The Model Picker Speaks in Chips Too

The composer's model card traded its searchable list for the same language: **one scrolling row of your installed Ollama models, one of your connected providers, and one of the active provider's models** — the lit chip is the brain you're on, and a provider chip brings its remembered model along. It is the picker the mobile app already has, now on the desktop, so switching brains feels identical on both screens.
