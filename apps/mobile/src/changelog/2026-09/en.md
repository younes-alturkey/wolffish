## v1.0.77 — 2026-09-30 `Latest`

### A Stopped Call Says It Was Stopped, Not That It Failed

Press Stop on a turn while a tool call was running, or let Wolffish end a long-running call itself, and the card on your phone said **"Failed"** in red — the same verdict a command gets when it genuinely breaks, on a call that simply quit because someone told it to. Tool cards now have a **fifth state: "Stopped"**, in amber, for a call that was ended on purpose. The pill says who did it — **"Stopped by you"** when you pressed Stop, **"Stopped by Wolffish"** when the model ended it — and a short line under the header says why, in the clean feed once you open the row and on every verbose card. Whatever the call had printed up to the stop stays readable in plain text rather than error red, so a stopped card never reads as broken. This matches the desktop's own cards; update it too and the two agree.

## v1.0.76 — 2026-09-25

### A Long-Running Call Shows Itself as Still Running

Your desktop now checks in on any tool call that runs long instead of sitting frozen inside it: after its check-in time the call keeps going, and Wolffish reads its progress and decides whether to wait, stop it, or carry on. **The phone's tool card now shows that state.** A call that has checked in wears an amber **"Still running"** pill with its handle and a clock that keeps counting, in the clean feed and the verbose one alike, and the card updates in place with the real output and total duration the moment the call finishes. A card marked done is done; a card marked still running is exactly that.

## v1.0.74 — 2026-09-23

### Find Any Conversation by Its Title

**The Conversations screen and the conversations sheet now each have a search field** that narrows the list as you type. It matches **every word you type, in any order**, and ignores **case and accents** — so a word or two you remember from anywhere in a title is enough. The field stays put while the results move and never hides the pages above it in the sheet. Tap a result with the keyboard up and it **opens on that first tap**, with the keyboard already gone by the time the conversation appears; start scrolling the results and the keyboard steps out of the way. It all works the same in Arabic, right to left.

## v1.0.73 — 2026-09-22

### Everything Your Desktop Keeps Running, Now on Your Phone

Ask Wolffish for a dev server, a tunnel or a script and it keeps that process alive for you — and until now the machine it runs on was the only place you could see any of it. **Library has a Processes tab**: every managed process, grouped by the folder it belongs to, each with its state, the address it answers on, how long it has been up and the command behind it.

Every one of them is **yours to drive from here**. Stop it, restart it, or start it again after it exited. Choose whether it comes back **with Wolffish, at login, or not at all**, and whether one that falls over **restarts never, on failure, or always**. Open its **log** and watch the tail keep up while it runs; **edit** the command, the folder, the restart rule and what happens **when Wolffish quits**; or remove it along with its logs. When you want the machine quiet, **Stop all** and **Delete all** sit at the top.

With a lot running, **search by name, command, folder or address** and filter by state or by autostart level — and folders collapse, so five projects read as five lines instead of a page.

### The Process Card in a Conversation Stays Live

When Wolffish starts something for you mid-conversation, the **card it leaves in the chat** is not a picture of that moment. It keeps up with the processes it names — a server that crashed an hour after the turn ended says so when you scroll back to it — and its **Stop and Restart work right there**, with no trip to the Library.

### See the Page Your Desktop Is Looking At

When Wolffish uses its own browser during a conversation, **the page comes with it**: one card per conversation, sitting at the latest turn that used it, with the open pages along the top, the address underneath and a picture of what your desktop is showing.

A page **on the open internet opens on your phone** with a tap — in the app or in your own browser — and the address copies either way. A page **only your desktop can reach**, like something on localhost or inside its network, keeps the picture and says so plainly instead of handing you a link that could never load.

### Text, Code and Table Files Scroll Where They Are

A file in the chat used to be a preview you had to open before you could read past its first few lines. **Text, code, data and table files now scroll inside the card**, in the conversation itself, and hand the scroll back to the chat at the top and bottom of the file. The expand button is still in the card's footer for the full-screen view — you just no longer have to go there to read twelve more lines.

## v1.0.72 — 2026-09-20

### Every Automation, Project and Procedure Picks Its Own Thinking Level

Your saved automations, projects and procedures used to run at **whatever thinking level your chat happened to be set to** — so a nightly summary that needed a light pass could quietly run at maximum, and a deep analysis could run at minimum because you had turned the composer down earlier.

Each one now carries **its own thinking level** — off, normal, high or max — from a switch sitting right on its card, beside the mode pills it already had. New ones start at **the level your chat is showing right now**, so nothing changes until you decide otherwise; from then on the item decides, and its runs use it. **Anything saved before this update keeps following your chat exactly as it always did**, so nothing you already have behaves differently.

The levels on offer are **the ones your selected model actually honours**, so a card can never present a level the model would silently ignore.

### One Setting, Two Screens

The same switch on your phone reads and writes **the very same value** — change it on the desktop and your phone shows it, change it on your phone and the desktop shows it. They are not two copies taking turns; they are one setting seen from two places.

## v1.0.62 — 2026-09-16

### The Browser Moved to Channels

Wolffish drives your browser the way it works in a terminal: it is **somewhere the agent does things**, not a service it borrows a key from — and your desktop has always filed it that way. On the phone it sat among Brave Search, Giphy and your Google account, which is the last place anyone would look for it.

It now has **its own card on the Channels page**, between this phone and Telegram, in the order your desktop uses. Everything it carried came with it: the browsers that are connected, the verdict on what Wolffish can actually reach through them, the pairing port, and the screenshot width, format and quality — all still editable from here. Its connection reads as a row in the channel's own words now, the way the terminal's does, instead of a chip beside a service name.

The settings list follows it across. The **Channels** row carries a mark for the browser beside the phone, the terminal and the two bridges — green when a browser has the extension connected — and the Services count no longer counts a panel that page no longer has.

## v1.0.61 — 2026-09-16

### Your Browser Extension Now Says Whether It Can Actually Work

The Services page listed every browser your extension had connected, which told you the link existed — and nothing at all about whether Wolffish could **do anything through it**. A browser can be connected and still be shut out: permissions withheld, site access narrowed to whatever tab you opened by hand, a workplace policy holding the door. You found out the way anyone finds out, by asking for something and watching it not happen.

Under the browser rows there is now **one line with the verdict**: everything is in place, part of the browser is reachable, or a count of the things standing in the way. Beside it sits a badge for **how much of the browser Wolffish can reach** — Full, Limited, Managed or Not reachable — and underneath, **the first thing blocking it, in plain words**. Every fix for any of it lives on your desktop, so the line says that too, and points you at the panel that walks you through it.

It speaks **only when there is something to say**. A desktop with nothing to report, or one too old to have an opinion, leaves the page exactly as it was rather than parking a grey question mark on it forever.

## v1.0.60 — 2026-09-16

### The Reconnecting Card Now Shows, Whatever You Have Open

When the link to your desktop drops, the card that says so — and the one that covers the first sync afterwards — is the app's one chance to explain itself. With anything open over the chat, though, that card was **drawn underneath it**: the conversations list, an attachment picker, any dialog a settings page opens, and you saw **nothing at all**, on precisely the occasion the app most needed to speak. It now sits in **a layer above every screen and every sheet**, so the wait is always the thing in front of you, wherever you happen to be when the link goes. What it says and what it does are unchanged — the same progress, the same clock, the same way out where there is one.

### A Message Sent Mid-Job No Longer Depends on Your Phone Being Awake

Speaking into a job already running is only worth having if the words **actually arrive**. When the work finished before the agent reached your message, that message went out as the next thing you said — but only if your phone was **there to notice the moment**. Backgrounded, relaunching, or off the link for those few seconds, and it was simply gone, with nothing to say it had been. **Your desktop keeps it now.** It holds the message until it has somewhere to be, sends it as the next turn itself, and cannot miss the moment because it is the one that decides it — so the words survive a phone that was in your pocket.

A message whose run **you stopped** is the one case that is not sent on, and it is not thrown away either: stopping the work is not the same as taking back what you wrote. Open that conversation again and the words are **back in the composer** you wrote them in, to send, change or drop as you like.

## v1.0.59 — 2026-09-15

### Say Something While the Agent Is Still Working

A message written while the agent was mid-job used to **wait its turn** — it sat above the composer until the work finished and then went as the next thing you said, which is exactly too late to be any use. It now goes **into the work already running**. "Skip the tests folder", "use the other file", "leave the config alone" reach the agent **at its next step**, while there is still something left to steer.

Your message joins the conversation the moment you send it, as your own bubble, with one quiet line under it saying it will be **read at the next step**. When the agent does read it, that bubble **moves inside the reply**, at the exact point it was taken in — so the conversation shows both what you said and where the answer turned. Change your mind before it is read and **one tap takes it back**, with the words returned to the composer you wrote them in. Nothing about the run is disturbed by any of it: the reply keeps streaming, the cards stay where they are, and **Stop still stops**.

It carries a photo, a file or a voice note just as an ordinary message does. In **demo mode** it works the same way, with the tour's own agent reading it exactly as a real one would.

### Plan Moves to the Composer

The **Plan** stance has left the controls sheet for **the composer's own row**, beside the model chip — where the desktop keeps it, and where the message it shapes is actually written. It is a **switch there, not just a sign**: one tap turns planning on, another turns it off, and the chip says which way it is set without opening anything. It stands in **demo mode** too, so the tour shows you the control instead of hiding it. When your desktop is out of reach the chip stays where it is and dims, and a tap tells you why rather than setting a stance nothing would receive.

## v1.0.58 — 2026-09-13

### A Restart Counts Down on Your Phone, With the Button That Stops It

When you ask the agent to restart, shut down or log out of your desktop, it no longer does it while still writing to you. The action is **armed instead of run**: the agent finishes its answer, the conversation is saved, and then a **countdown card** appears in the chat carrying the action's name, a bar draining over a few seconds, and an **Abort** button. The card is part of the conversation, so it reaches your phone like any other card — and **the Abort button works from here**, which matters most when the machine going down is the one you are not sitting at. Let the bar empty and the action runs; press Abort and it never does. Open the conversation later and the card says exactly what happened: **it ran, you aborted it, or it was dropped** because the turn was stopped before its answer landed.

## v1.0.57 — 2026-09-12

### Every Card the Agent Draws Stops at the Same Edge

The compact rows that report an edit, a write or a shell run, and the card that summarises a workflow, ran the **full width of the chat** while every other card the agent produces stopped short of it. Flush against both edges, they read as part of the screen rather than as something the agent had done — two different left margins in one conversation. Both now **stop where the reply stops** and **hold to the agent's side**, the same width as the Tasks card and the file, media and run cards they sit among. Nothing inside them moved: the same status, the same label, the same tap that opens the diff or the full output.

### The Working Row Actually Turns

The item the agent is on right now wears a spinner that **actually spins**. The glyph that used to sit there only faded in and out in place — it never rotated, so a list mid-flight read as a **frozen screen** rather than work in progress. It is a **real spinner** now, sized to match the ticks and dots on the rows beside it, so one glance at the task list tells you the agent is still moving.

## v1.0.56 — 2026-09-12

### One Library for Automations, Projects and Procedures

The three pages you make things on now live behind **one row in the chat sheet**: **Library**. Open it and **three tabs** sit right under the title — **Automations, Projects, Procedures** — so switching from a schedule to the project it runs in is one tap instead of a trip back through the sheet. Each tab is the page you know, with the same cards, the same editor and the same play, edit and delete on every row. The Library **remembers the tab you left on**, and a notification that names one of the three still opens straight to it. This is **the same Library the desktop app opens**, laid out for a phone.

### Automations Show Cards Only

The Automations tab no longer has a switch between cards and the raw schedule file. On a phone the cards **are** the schedule — every switch, mode and prompt on them writes the same file — so the second view had nothing to add and one more place to go wrong. It is gone, and the header is quieter for it.

### Conversations Moves Into the Sheet

The full **Conversations** page — the one with search and delete — is now **in the chat sheet, right under Customization**, beside the other pages you go to rather than the settings you adjust. Settings is shorter, and the page is **one tap from chat** instead of two.

## v1.0.55 — 2026-09-11

### Automations That Run Several Times a Day

An automation used to fire **once** in whatever period you gave it — once an hour, once a day, once a week, once a month. The editor now opens with **a row of count pills** — **Once, Twice, 3 times, 4 times, 5 times** — above the period chips, and the two read as one sentence: pick **3 times** and **Every day**, in either order, and the schedule fills itself in with **three runs spread evenly across the day**, the first of them minutes from now. A weekly count spreads across **the days of the week**, a monthly one across **the days of the month**, and an hourly one becomes **a clean interval** — every twenty minutes, for three times an hour.

### The Schedule Field Understands Lists

Written by hand, the schedule now takes **a list anywhere it used to take a single value**: **Daily (08:00, 14:00, 20:00)**, **Weekly (Monday, Wednesday, Friday 09:30)**, **Monthly (1, 15 09:00)**. Day names accept **their three-letter short forms**, and a **semicolon** joins whole cron expressions into one schedule. The pills **light from what is actually in the field** — a schedule you typed, or an existing automation you opened to edit — so they describe that automation rather than the last thing you pressed, and **the next-run line underneath** confirms the reading before you save. The schedule guide gains an example of **each new list form**.

## v1.0.54 — 2026-09-11

### Plan First, Change Things After

A new **Plan** switch sits in the chat controls, beside the model and thinking knobs. Turn it on and the turns that follow **only look**: the agent reads, searches and works the problem out, then writes you **a plan to approve** — nothing on your machine is touched while the switch is on. A small **Plan** chip sits in the composer the whole time it is, so the stance is never hidden from the conversation, and one tap on that chip ends it. It is **the same stance the desktop's composer holds**: set it here and the chip over there follows, set it there and this one does, so the two can never disagree about what the next turn is allowed to do.

### Edits and Commands Show Without Turning Anything On

A clean feed used to mean replies and delivered files and nothing else — while the agent edited files and ran commands entirely out of sight. **Every file edit, write and shell run now draws its own compact row**, whatever the tool-activity switch says, because a change in your project is not tool mechanics. The row names the **file or the command**, carries a green **+N** and a red **−M** for an edit or the **exit code** for a run, and how long it took. Tap it open and you get the real thing: the **red-and-green diff with line numbers** for an edit, the output for a command — and, when an output was too large to hold, **where the whole of it was saved**. The switch itself is plainer about all this now: it reads **Show all tool activity**, and says exactly what stays visible when it is off.

### The Task List Ticks Itself Off

When the agent breaks a job into a checklist, that checklist is now **a card in the conversation** — a mark against every item, a red **high** tag where one earned it, and a **done-of-total** count with a progress bar across the top. It **updates in place** instead of reprinting itself: an item moves from waiting to running to done on the card already sitting there, and a list the agent picks back up **several turns later resolves the original card**, where you first saw it, rather than starting a second one.

### Choosing a Model Is One Row

The **Local / Cloud** switch has gone. Providers now sit in **a single row** — **Ollama among them**, listed whenever its daemon is up on your desktop, exactly as a cloud provider is listed once it has a key — and under that row, the models that provider actually has. Picking settles local-versus-cloud **by itself**, which is all that switch was ever doing behind the scenes, so there is one decision where there used to be two.

### The Floating Run Cards Retire

The live cards that floated over whatever screen you were on while an automation, a procedure, the nightly reflection or the daily tidy-up ran are **gone**, and so are their **four switches** on Settings › Channels and Settings › Knowledge. They shipped switched off and were best left that way: a run on a machine you are not looking at should not interrupt the one you are. **Nothing about the runs themselves changes** — same schedules, same notifications — and the **Automations** and **Knowledge** screens still report exactly what ran and when. The one card that stays is the **memory index rebuild**, because that one really does mean your desktop has stopped answering, and a phone left guessing why is worse than a card.

## v1.0.52 — 2026-09-05

### The Thinking Card Is Now Yours to Hide

The **Reasoning** card that opened up last release has **a switch of its own**, on Settings › Channels. It arrives **on**, so nothing changes unless you want it to — and switching it off **hides the card and nothing else**: the model thinks exactly as much as it did before, the thinking is still saved with the conversation, and turning the switch back on brings every past thought back into view. It is **one answer for both screens**, so setting it here settles it for the desktop's chat in the same breath.

### Screenshots the Agent Sizes Itself

Computer use no longer asks you to choose **a screenshot width and format** up front. The agent **picks both for every capture it takes** — sharper when it needs to read fine print on a screen, lighter when it is only finding its way to the next window — so the two rows on Settings › Services have gone, and a line explaining why stands where they were. The **browser extension keeps its own** screenshot settings: those are still yours to set.

## v1.0.51 — 2026-09-04

### Every Tap Answers Back

Press a settings row, an icon button, a project card, a chip in the model picker — anywhere in the app — and **the surface under your finger lights up now**. It never did: the highlight was being asked for in a form the app's styling could not draw, so it was skipped in silence and every one of those presses landed on a control that looked completely inert. **Close to forty controls across the app** get their touch feedback back, from the composer's small buttons to the Automations, Procedures and Projects screens.

### Chips and Bars That Were Never There

A handful of small surfaces had been drawing with **no background at all** — you were seeing their text and nothing else. The **status pill on a task card**, a **tool's status chip**, the **file-type badge** on an attachment, the **download progress track**, the **line numbers and table headers** inside the file viewer and the **bars in the context meter** all carry the tint they were always meant to have again, in both light and dark.

### The Model Chip in the Composer

The name of the model about to answer sat in the composer as **bare coloured text**. It is now **a proper chip** — its own tinted background and a soft outline — and the name has **about a quarter more room** before it is cut short, so a longer model id reads further before it trails off.

## v1.0.50 — 2026-09-02

### Reasoning You Can Read Without Opening

The **Reasoning** card no longer hides the model's thinking behind a tap. It is now an **open scroll block, like a tool's output**: the thinking sits right there under a small brain icon, grows with what it holds up to **eight lines**, and scrolls inside its own box past that — a one-line thought takes one line, and a long deliberation never swallows the conversation. A **copy** button in the card's header puts the whole thinking on your clipboard, and a long press opens the text for selecting any part of it. When a model opens its reasoning with a heading, that **heading becomes the card's title** instead of the plain word "Reasoning". While a reply is still streaming, the block **follows the newest line** as it arrives and stops following the moment you scroll up to read.
