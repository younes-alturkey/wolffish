## v1.0.49 — 2026-08-31

### Downloads Pick Up Where They Left Off

A photo or GIF arriving over a slow link could start over from nothing, again and again: one stalled stretch failed the whole transfer, and the next attempt re-paid every byte the last one had already landed — visible as a progress bar that kept resetting on a connection that was genuinely working. Both halves are fixed. A transfer now **waits out a slow stretch** instead of giving up at the first long pause, and when an attempt does break, the next one **continues from the exact byte it stopped at**. What arrived stays arrived — a download only moves forward. A file that truly changed on your desktop between attempts still starts over from the beginning, because stitching two versions of one file together is never the right answer.

## v1.0.48 — 2026-08-30

### The Whole Train of Thought, In Its Place

A model that thinks before it answers used to leave only a trace here: one **Reasoning** card at the very end of a reply, carrying whatever it thought before its final words — everything it weighed earlier, before each search and each step, never appeared at all. Every stretch of thinking now lands as its **own collapsed card, exactly where it happened**, above the words and actions that thinking produced, so a long reply reads the way it actually unfolded: think, act, think again. Cards stay folded until you tap them, copying a message still copies **only the reply itself**, and conversations saved before this change keep the single card they always had. The full effect arrives together with your desktop app's own next update — the phone is ready for it either way.

## v1.0.47 — 2026-08-30

### Ogg Voice Notes Now Play On the iPhone

A voice note in the **Ogg format** — the open format most recorders produce — used to stop at a file card on the iPhone, because the system had no decoder for it and there was nothing to play. Recent versions of iOS changed that: the iPhone now **decodes Ogg natively**, the same way it always has mp3. The app follows suit — on a current iPhone, an Ogg voice note **opens in the same inline player** as every other voice note, with nothing to download first. Older iPhones keep the file card, which is exactly what they need, and Android and the desktop were already playing these files all along.

### Leaving a Project Stops Looking Like a Warning

The button that closes a project no longer wears the **destructive red** reserved for deleting things. Closing a project is a harmless switch of mode, so the button now keeps a calm, muted look — the same one the desktop app gives it.

## v1.0.46 — 2026-08-27

### Catching Up No Longer Crawls

A phone coming back to a busy conversation — after time in a pocket, on a slow connection, or while a long automation wrote away — could spend minutes replaying what it had missed **one word at a time**, long after your desktop had finished the reply. What arrives now pools for a blink and lands together: a backlog **fast-forwards to the present** instead of re-typing itself, and stopping a run settles it in the same breath as the tap. A reply streaming live reads exactly as it always did — word by word, at the speed it is being written.

### The Newest Message Stays On Screen

The feed's job is to hold the end while a reply grows, and it kept losing that grip in small ways that added up: growth arriving in half-second bursts turned the follow into a chase that ran a step behind the whole turn; a conversation heavy with images and charts opened at its end, then slid short as they finished sizing; a stray tap while the feed was moving counted as "scrolled away" and switched the following off; and scrolling back down could fail to switch it on again, because the end recedes faster than a finger while a reply streams. All of it is fixed: **streamed growth is glued to the end instantly**, opening a conversation **lands on the newest message and stays there** while its media settles, a tap is just a tap, and reaching the bottom **reliably hands the feed its job back**. Reading history is untouched — nothing pulls you down until you choose to return.

### What's New Dresses Like the Rest of Settings

The choice at the top of the What's New screen — this app's notes or the desktop's — now wears **the same full-width switch** the language picker in Appearance wears, instead of a loose pair of chips. The months keep their own row beneath it, exactly as before.

## v1.0.45 — 2026-08-27

### Automation Transcripts Stop Weighing a Ton

A conversation written by a busy automation — the daily meme run was the one that surfaced it — could arrive carrying thousands of tiny text fragments, one per instant of the reply being written, plus download cards for scratch files that only ever existed on your desktop's side of the work. The phone paid for all of it: a transcript many times its real size to store and redraw, and **downloads that could never finish** spinning beside the real ones. Both are gone. Fragments now **fold into whole paragraphs** the moment a conversation lands — the meme run's transcript dropped to about a quarter of its stored size — and a file the desktop cannot serve is written as plain text instead of a card, so nothing spins for it. Real attachments — the memes themselves included — download and **play exactly as before**.

## v1.0.44 — 2026-08-26

### A Blank Screen Is No Longer Something the Chat Can Show

Opening a conversation from a notification could land on nothing at all — no messages, no placeholders, just an empty page that stayed until you switched away and back. The screen's own logic had exactly one frame with nothing in it, reachable whenever a busy sync briefly emptied the copy on hand, and that frame is now gone: a transcript that disappears mid-view brings the **loading placeholders back over the gap** and repaints in place the moment the real copy returns, with nothing to reopen. The catch-up itself got stricter in the same breath — an empty answer caught in the instant before a running turn saves is **recognized as premature and set aside**, so it can no longer erase what your screen already holds. A conversation that is genuinely new, or genuinely deleted, still looks exactly as it should.

## v1.0.43 — 2026-08-26

### The Open Conversation Can No Longer Go Blank

A conversation could vanish from under you — most often while a file was downloading — leaving a blank screen until you switched away and back. The transcript was never gone from your desktop; the phone was believing one of two momentary illusions a busy sync can produce: a catch-up sweep that missed the conversation for a single pass and took that as a deletion, or a fetch that caught a brand-new conversation's file in the instant before its first reply was saved and took the emptiness as fact. Neither is ever real — nothing empties a conversation in place — so the phone now **refuses both**: the conversation you are looking at is never dropped by a background sweep, and an empty answer never overwrites messages already in hand. What is on your screen **stays on your screen**, and a truly deleted conversation still leaves exactly as it should.

## v1.0.42 — 2026-08-25

### A File Is Only "Deleted" When It Is Actually Gone

An image, a document or a voice note could show up as **"file was deleted or unavailable"** when nothing of the sort had happened — the download behind it simply had a bad moment on a busy connection, and the card treated that one failed attempt as a final verdict until you reopened the conversation or restarted the app. The two are now kept apart: that message appears only when your desktop **actually answers that the file no longer exists**. A download that merely failed keeps its loading card and **quietly tries again** — a few times over the next seconds, and once more whenever the connection comes back — so the file appears on its own, with nothing to reopen. Background catch-up also stopped pre-downloading files for conversations you are not looking at, which is bandwidth the files on your screen were waiting on.

## v1.0.41 — 2026-08-25

### A Finished Turn Always Lands

A conversation could finish its work on your desktop and keep showing the old transcript here — the reply existed, the phone had simply missed the one signal that said "go get it", and nothing ever asked again. You noticed it as a chat stuck in yesterday until you left and came back, or relaunched the app. The phone now **refuses to take silence for an answer**: when a turn ends, it keeps checking until the finished reply is actually in hand, and your desktop now announces every saved conversation the moment it reaches disk. Between the two, **a completed turn shows up on its own** — watching the screen, returning to it, or arriving cold, no restart required.

### Coming Back Catches Everything Up

Opening the app after time away now brings the conversation you are looking at level with your desktop, not just the list around it. Whatever changed while the phone slept — a turn that finished, an automation that wrote into a chat — is **fetched in the background the moment the connection returns**, so the transcript on screen corrects itself without being reopened. A **notification tap** is treated as the evidence it is: the conversation it names refreshes no matter what the phone thinks it already knows, so the tap lands on the message that caused it, even from a cold start.

### Big Conversations Open Faster

A transcript heavy with tool work arrives in pieces, and those pieces used to queue one behind another — each paying its own full round trip to your desktop before the next could leave. They now travel **several at a time**, and the app no longer downloads the same conversation twice when two parts of it ask at once. Long conversations open in a fraction of the time they took, and the connection does the same work once instead of three times.

## v1.0.40 — 2026-08-25

### The Keyboard's Way Down Is Everywhere Now

The chevron that floats above the keyboard arrived last version knowing only one field — the message you were writing. Everywhere else you type, the iPhone keyboard still had no way down: a variable's value in Settings, the search line inside a picker, the confirmation a dialog asks you to type out, the full-screen editor holding a long draft. The same **chevron now rides above every keyboard in the app**, wherever one opens — one tap puts the keys away and **keeps every character you typed**. It earns its keep best in the editors: putting the keyboard down to **read the whole draft** is no longer the same thing as closing the editor. Android stays as it was — its navigation bar has carried this chevron all along.

## v1.0.39 — 2026-08-22

### A Run You Come Back To Is Still There

iOS reclaims a sleeping app whenever it wants the memory back, and returning to one that was left mid-run used to cost you the whole turn on screen: the reply already written, the tool cards, the question it was waiting on — all of it replaced by the bare thinking words, as though the run had only just begun. Nothing was ever lost on your desktop, but nothing would redraw it either, and across a long tool call the next update can be **minutes** away. The app now **asks your desktop for the turn exactly as it stands** the moment it reconnects, and puts it back: the reply so far, the message it answers, and — the one that mattered most — **any question or approval the run is parked on**. That card is the reason you came back, it is never sent twice, and until now returning to the app was enough to lose it for good, leaving your desktop waiting on an answer nobody could give it any more.

### A Long Conversation No Longer Closes the Link

A conversation heavy with tool work eventually outgrows what a single message on the link can carry — and an oversized reply does not arrive late, it **drops the connection**. Worse, it did it every time: the conversation was still sitting in your list, so opening it took the link down again, and again. Transcripts past that size now arrive **in pieces and are put back together on the phone**, so a conversation can run as long as your work needs it to. If a piece fails to arrive, the copy already on your phone is left exactly as it was rather than replaced with half a transcript.

### The Feed Stays at the End

Watching a reply arrive could strand you partway up it, with everything new piling up below the fold and nothing bringing you back down. The feed is meant to follow what grows only while you mean to be at the end — and it had been **mistaking its own scrolling for yours**, letting go halfway through the very glide that was carrying you there. It also aimed at where the end was when that glide **began**, so anything arriving during it landed you short, with nothing coming back for the rest. Both are fixed: the feed now knows its own motion from yours, and **keeps going until it truly reaches the end**. Streamed lines are glued on instantly; a whole message glides. And the end now survives the screen changing under you — **the keyboard rising**, or the composer growing a few lines, used to leave the newest message hidden behind it while the feed believed itself pinned.

## v1.0.38 — 2026-08-21

### The Composer Is One Card

The message field and the loose buttons around it have become what they always were on the desktop: **one card**. The field rides on top, and every control sits in a row inside — the chat controls at the start beside something this screen never had before, **the model about to answer**, worn as a chip you can read at a glance and tap to change; expand, attach, the mic and the red stop at the end. Same controls, less of your screen, and the model is never a mystery again.

### Choosing a Model Is One Tap

The provider and model pickers used to open a dialog that showed one choice at a time and trimmed long names mid-word. Each is now a **row of chips** — the whole list on one line you can slide, every name written out in full, the current choice lit. Tap a chip and it is chosen; switch provider and its models slide in with the right one already picked. A model your provider's list does not carry still gets its chip, so what is chosen is always the one lit up.

### The Keyboard Has a Way Down

The iPhone keyboard ships with no way to put it away — every app is expected to bring its own, and this one finally does: a small **chevron floating just above the keyboard**, riding it as it comes and goes. One tap drops the keyboard and **keeps every word of your draft**. Android needs nothing here — its navigation bar has carried this chevron all along — so nothing doubles up.

### Reconnecting Interrupts Once, and Less Often

When the link to your desktop wobbled mid-use, two cards used to take turns interrupting: _reconnecting…_ vanishing the instant the link formed, then _syncing…_ blinking in over the same spot a beat later. They were always one event — the app is busy with your desktop — so they are **one card** now: it appears once, walks through whichever phases the episode actually has, **counts the seconds you have really been waiting**, and leaves once. _Continue offline_ dismisses the whole episode, not half of it. And the episodes themselves are rarer: a phone busy decrypting a file no longer mistakes its own full hands for a dead connection — the link is **asked twice before being replaced** — and glancing at the notification shade or Control Centre no longer sets off a pointless check-and-catch-up on a connection that was never in danger.

### The Turn Rating Bar Retires

The 0–10 score bar that appeared under finished replies is gone, along with its switches on Settings → Knowledge. Scoring every turn asked more of you than it gave back: the nightly reflection reads the conversations themselves — what worked, what failed, what you corrected — and the lessons land in its playbook either way. One less thing between you and the next message.

## v1.0.37 — 2026-08-16

### The Floating Run Card Is Now Yours to Switch Off

When something runs on your desktop — one of your automations, the nightly reflection, the daily tidy-up of its memory — a live card floats over whatever screen you are on and counts it out. Welcome when you asked for the run; less so at three in the morning, for housekeeping you never think about. Every family of run now carries **its own switch**, and they all **start off**: automations and procedures on **Settings → Channels**, compaction and reflection on **Settings → Knowledge**. Off hides the card and **nothing else** — the run happens on the same schedule, the notifications you asked for still arrive, and the Automations and Knowledge screens still report exactly what ran and when. The one card that never hides is the **memory index rebuild**, because that one really does block the desktop, and a phone left guessing why nothing answers is worse than a card. The desktop's own card has a switch here too, on the same screen: **your desk and your pocket are asked separately**, because a card worth having on one is not automatically worth having on the other.

### Procedures Card Like Everything Else

A **procedure** — a prompt you saved and run in the background — used to pass over the phone without a trace. It now appears in the same stack as everything else, **showing the prompt it is running**, under the same switch automations use: whether something is running for you is one question, not two. And the **Automations** screen no longer mistakes one for the other — a procedure that happened to share a name with one of your automations used to light that automation up as **running** when it was doing nothing at all.

## v1.0.36 — 2026-08-14

### Your Appearance Choice Survives a Language Switch

Changing the app's language could bring it back in your phone's colours rather than your own. With **Light** chosen on a phone set to dark, switching to Arabic returned a **dark** app — and the Appearance screen still showed Light selected, so nothing looked wrong except everything you could see. Switching languages restarts the app, and on the way back it told the system which scheme to draw; but the system was already holding that scheme from a moment earlier, so it had nothing to report back, and the app went on painting the one your phone prefers. It now **confirms that the scheme it asked for is the one actually showing**, and puts it right before the app appears — so your choice comes back with your language, and **Light stays light**.

## v1.0.35 — 2026-08-13

### Coming Back to the App Is Instant Again

Leaving the app and returning could cost you ten seconds of a screen that looked connected and did nothing. iOS quietly drops the connection while the app is asleep, and the app had no way to tell a link that survived from one that had already gone — so it trusted the connection it had and waited for a slow safety check to notice, and how long that took depended on nothing more useful than how long you had been away. It now **asks the connection to prove it is alive** the moment you come back, and replaces it within **two seconds** if it cannot. Opening the app is quicker too: it starts reaching for your desktop **while the app is still starting up** rather than after, and when a reconnect does have to wait between attempts, it now waits **seconds rather than half a minute**.

### Changing Networks No Longer Strands the App

Walking out of Wi-Fi range onto mobile data was the one case nothing could see: the app never closes, you never touch anything, and the connection is dead the instant the network underneath it changes — yet everything keeps reporting that all is well. The app now **watches for the network moving** and reconnects the moment it does, so a handover costs a couple of seconds instead of the best part of a minute.

### The Waiting Card Says How Long — and Shows Up Everywhere

When reconnecting or syncing does take a moment, the card that says so now **pulses while it works** and **counts the seconds**, so you can tell a blink apart from a real outage instead of watching a bar that never moves. It also appears **over every screen**: with a panel open — the conversation list, a picker, a settings dialog — it used to say nothing at all, on the one occasion the app most needed to speak.

## v1.0.34 — 2026-08-12

### Notifications Find Your iPhone Again

An iPhone has to introduce itself before anything can be routed to it, and that introduction could quietly never happen. Asking iOS for a notification token is a question the system is free to leave unanswered — no reply, no error, just silence — and the app waited on that answer indefinitely; opening the app before it had found your desktop could stall the very same introduction until the next cold start. A phone that never introduced itself is unreachable by **every** path at once, so nothing arrived — not the lock-screen kind, and **not even the notifications the app could have shown you while it sat open and connected**. It now introduces itself **within seconds either way**, with a token or without one: notifications land the moment they are sent, and **lock-screen delivery switches itself on** as soon as iOS hands the token over — no restart, nothing for you to do.

## v1.0.33 — 2026-08-12

### Notifications Reach Android With the App Closed

A notification from your agent used to reach an Android phone only while the app was **open and connected**; the moment you closed it — or the tunnel dropped — the notification had nowhere to land and quietly never arrived. Android builds were missing the registration that makes remote delivery possible at all, and they now carry it. A run that finishes, fails or needs you reaches your **lock screen** with the app **closed, backgrounded, or the phone asleep**, exactly as it always has on iOS, and it arrives **the moment it is sent** rather than waiting for the phone to stir on its own. A tap still opens whichever screen the notification names. What has not changed is **when** one is sent: that was always your agent's deliberate choice, and it still is.

## v1.0.32 — 2026-08-12

### The Keyboard Stops Burying the Input

On Android, the keyboard could rise **over the very field you were typing into** — the chat's **message composer**, and the editors for **prompts and documents**, held still while it covered them. They now **lift above the keyboard the moment it appears**, the way iOS always has, so what you type is never hidden behind the keys typing it.

### The Check Button Stays Put

The desktop card's **Check for updates** row used to vanish outright whenever the phone lost its desktop, so the card changed shape with every drop of the connection. The row now **holds its place** with the button **dimmed while there is no desktop to ask**, and it wakes the moment the tunnel re-forms. One card, connected or not — only the button's readiness tells the difference.

## v1.0.31 — 2026-08-11

### Update the Desktop From Your Phone

The desktop card on the Updates screen grew hands. **Check** asks the paired desktop to look for a new version right now — the same act, guards and all, as clicking in its own Updates panel. When one is found you watch it from here: a **live progress bar** counts the download up, flips to verifying, and lands on **Install downloaded update**. Installing is the one act that asks first — a dialog says plainly that the desktop app will **install and restart** — and once you confirm, the restart looks like any other blip: the tunnel re-forms on its own and the fresh sync carries the **new version** into the card. If the download fails, a card names **what actually went wrong** — the network, a corrupted download, a disk that wouldn't take it — with **Retry** right under it. The controls appear only while a connected desktop can actually serve them; disconnected, or paired to a desktop from before this feature, the card stays exactly as it was.

### The Tour Gets Its Relay Screen

Demo mode used to skip the Relay screen — there is no tunnel to describe. But that made the tour a different shape from the app it stands in for, so the demo now carries **a link of its own**: connected since before you looked, **stable cipher fingerprints**, traffic counters **ticking at the real keepalive cadence**, and a catch-up clock stamped by the one sync the demo truly performs. Sync answers from the sample dataset, Reconnect rebuilds the fiction and moves its counter, and leaving is labeled for what it is: **ending the tour and clearing the sample data**, with demo mode one tap away again.

### Smaller Things

The Settings list's **Updates row** now answers what it was really being asked — which apps, how far apart — by showing **this phone's version and the desktop's side by side**, each behind its device's mark; the same marks sit on the two Version rows inside. And the start screen says the quiet prerequisite out loud: **Wolffish runs on your computer** and this app connects to it, with a link to get the desktop app from **wolffi.sh**.

## v1.0.30 — 2026-08-10

### When a Provider Fails, You See What Happened

A turn that died used to end in a bare amber pill — **"Connection error"** — and everything past that was guessing. A failed turn now renders the desktop's own **error card**: the provider's logo, a plain reading of what actually went wrong — **key invalid, rate-limited, model gone, provider overloaded, or you're offline** — and a **View details** fold holding the verbatim failure trace, ready to copy. A **Try again** button rides the last message, and it doesn't blindly re-send: it opens a fresh turn that tells the model what broke, so it **checks what already finished and continues** instead of redoing it. A turn that hit a provider failure, retried through it and recovered keeps the stumble **on record mid-transcript**, exactly where it happened. And the rating bar steps aside for the card — a turn that never finished isn't one to score.

### History Knows What's Running

The History screen used to be an archive: a conversation appeared only once its first turn was saved. It now merges in **the turns running right now** — start an automation, message in from a channel, and the conversation is **in History the moment its turn starts**, wearing the same **pulsing number chip** the conversations sheet gives it, lifted into **"Today"**, tinted by the outcome when it lands. And while a turn is in flight, the row's **delete sits disabled** — the desktop refuses a mid-run delete anyway, so the button no longer offers what could only fail.

### Mid-Run, the Answer Keeps Moving

An automation saves its answer-so-far while it runs — that is what lets a run survive the desktop quitting. But open that conversation mid-run and the saved snapshot could win the screen: the answer **froze at whatever the fetch happened to catch**, while the live text streamed on invisibly behind it. The live mirror now holds the screen **until the run's final copy is saved**, so what you watch is the turn as it is written — and the handover at the end swaps identical text.

### Smaller Things

The **schedule guide** in the automation editor opens again — on iOS a dialog cannot raise a sibling dialog, so the help button silently did nothing; the guide now stacks inside the editor itself. A long automation prompt in the **run overlay** scrolls instead of being clipped dead at the card's edge. The channels' **allow-list fields**, the local model picker and the screenshot quality row now carry **example placeholders**, and the Ollama **models folder** shows the folder the desktop actually scans when none is set — `~/.ollama/models` — instead of a dash.

## v1.0.29 — 2026-08-10

### Pick a Project With One Tap

Binding an automation or a procedure to a project used to go through a dropdown: a menu opened over the editor to pick from a set that would have fit on the screen itself. Both editors now lay **every project out on one row** — emoji and name, the bound one lit — the same picker the chat's controls already use. One tap binds, one tap frees, and the row **scrolls sideways** however many projects you keep, so the twentieth costs the dialog nothing. If the bound project sits past the row's edge, the editor **opens already scrolled to it**, so what is bound is never out of sight. And the automation card stops spelling the project's name into its detail line — on a phone's width that third segment is what wrapped the line in two, and the card already **wears its project's emoji**.

### A Conversation Wears Its Project

A conversation that ran inside a project now shows **the project's own icon** in History, rather than the mark of whatever channel it was started from — the rule the conversations sheet and the desktop's History already apply. The icon is **read live from the project list**, so changing a project's emoji on the desktop re-badges every one of its conversations here, including the ones long finished.

### A Busy Button Keeps Its Word

A button caught mid-action used to change: Save became **“Saving…”**, Delete became a bare **“…”**, the language toggle and the connection test swapped their labels for a **spinner**. Every one of them now simply **dims and keeps its word** — same text, same size — until the work lands. Where there is real progress to narrate, a **status line** nearby carries it; the button itself never changes shape under your finger.

### Automation Prompts, Kept Whole

An automation is saved as markdown, and the file it lives in has grammar of its own: a line opening `## ` starts the next block, a dashed rule is structure, an HTML comment is how a switched-off automation is wrapped. Paste a prompt that carries any of those — a doc with its own **`## Prompt`** section, say — and everything from that line on used to be **silently swallowed** on save. The editor now **respells those lines harmlessly** as it writes — a space slipped into the token is all it takes — so the prompt you pasted is the prompt that runs: sections, rules, comments and all.

### Smaller Things

The Usage screen's **activity map** — the month of pixels, with its month and year pickers — now sits in **its own card**, wearing the same chrome as every other block on the screen, instead of floating on the page background.

## v1.0.28 — 2026-08-10

### Spoken Replies, Your Call

Send a voice note and the reply comes back in kind — Wolffish ends it with a **spoken voice memo**. That behavior now answers to **one switch in Preferences**: off, and voice prompts get quiet text like everything else; on, and the voice returns. The switch **writes through to the paired desktop** like any setting here, so the phone and the machine never disagree about whether the reply is spoken or written.

### Transcription in the Language You Speak

Voice notes are transcribed by Whisper on the desktop, and Whisper now takes direction: a **Language** row under Services pins every transcription to the language you actually speak, picked from the **same hundred-language catalog** the desktop offers, with a search box to cut through it. **Auto-detect** stays for the polyglot days — but detection is a guess, and on a **short recording** it can guess wrong; a pinned language never does.

### The Week Starts Where You Say

Week start used to be a **readout** — the desktop's choice, reported. Now it's a **choice**: Sunday or Monday, on the same segmented toggle the switches use, written through like any of them. It sets where the **activity map** begins and what ranges like **“this week”** mean — Monday if you keep ISO company, Sunday if your calendar keeps its own.

### Voice Notes Land at the Tap

A recorded voice note used to hold the room: the chat sat still while the file **uploaded first**, and the bubble appeared only once the desktop had it. The bubble now **shows up the instant you tap send** — the way file attachments already did — with the upload riding behind it. Offline and in demo mode the note settles from the **phone's own stored copy**, so what you sent is what you see, immediately.

### Smaller Things

The Android app icon's backdrop is now the **same solid navy as the splash screen** — launching reads as one surface opening, not two designs trading places. And the row that severs this phone from its desktop is named for what it does: **Unpair** — it drops the keys and **wipes this phone** — because “disconnect” said less than it meant.

## v1.0.26 — 2026-08-09

### Every Setting, Settable

The settings screens used to be mostly a window: the phone showed what the desktop had and changed little of it. Now **every live control writes through**. Chat mode and thinking, the Local/Cloud switch and both model pickers, Telegram's and WhatsApp's preferences and allow-lists, the in-app feed's verbosity, every MCP server switch, the compaction schedule — each lands on the paired desktop **through the same code its own panels call**, so a change made from the phone and a change made at the machine are the same act, and both screens show it at once. The two bridge power switches stay readouts by design — starting a bridge is the desktop's own act — and while the desktop is unreachable the controls **decline the tap rather than pretend**, because an edit with nowhere to land is not an edit.

### Keys Typed Here, Kept There

Each provider card now takes a **fresh API key typed on the phone** and saves it to the desktop, which keeps the credential and never hands it back: the card shows only a **masked preview** of what is installed, and typing always composes a new key rather than editing a secret this device does not hold. Allow-lists commit **once, when you finish editing** — a Telegram allow-list change restarts the bridge, and nine keystrokes must not be nine restarts. The connection test keeps to demo mode, where pretending is the point; paired, the desktop is the side that can actually reach a provider, and a button that toasted success without testing would be the one lying control on the card.

### Pictures and Clips, Whole

A tall screenshot used to be cropped to the thumbnail's fixed box. The thumbnail now takes **the image's own shape** — width fixed, height following the picture — so what you see in the feed is the picture, not a crop of it. Videos got the same treatment from the other side: the cap that squeezed a portrait clip to six-tenths of the screen is gone, and **every clip renders whole**, no crop, no letterbox bars.

### Smaller Things

The two floating discs over the chat — conversations and new chat — wore a ring that read **black against a dark screen**; they now draw the same **subtle hairline** every other edge in the app uses.

## v1.0.25 — 2026-08-09

### Unread, Counted

A notification you have not answered now leaves a mark: a small **count on the conversation it belongs to**, in the conversations sheet and the history list, with the total carried on the floating menu's disc and on the **app icon** itself. The counting is deliberate about what it means. A notification for the conversation you are looking at never counts, opening a conversation retires its count and sweeps its notifications out of the tray, and the number keeps up **while the app is closed** — each arriving notification carries the running total with it, so the icon is right before the app has even woken. Delete a conversation and its count goes with it; nothing keeps score for a chat that no longer exists.

### Disconnecting Leaves Nothing Behind

Disconnect used to wipe the conversations and keep the residue: a number on the app icon with nothing behind it, notifications in the tray pointing at chats that were gone — and out on the relay, a registration that kept **routing notifications at a phone that had left**. The whole trail goes now. Disconnecting clears every count, empties the tray, zeroes the icon, and has the relay **forget this device entirely** while the link is still up — so a severed phone stops receiving a workspace's notifications the moment it walks away, and pairing again starts the count from nothing.

### Smaller Things

The number inside an unread badge now sits **dead centre in its pill** rather than riding slightly high — the font behind it reserves room below the line for marks Arabic letters need and digits never use, and the badge no longer pays for that space.

## v1.0.23 — 2026-08-09

### Every Run Starts With Its Own Files

Projects, procedures and automations now each carry **files and a working folder** into every run they start. All three show what they are carrying on the card, and all three let you change it from the phone: attach a file and it uploads to the desktop piece by piece, because that machine owns the workspace and the names. A working folder is **typed rather than browsed** — a phone cannot look through another machine's filesystem — and when the desktop turns one down, the refusal comes back in that side's own words rather than as a shrug. An automation has no identity of its own to hang files on, so its markers live in the same markdown its schedule is written as, and they are carried through every rewrite: a save from the phone can no longer strip them.

### Text You Can Actually Select

Long-press a message to **select its text**. On Android that is ordinary selection, in place, where the words already are. On iPhone, where the platform offers no selection for rendered text at all, the long press opens a sheet holding that same message in a form iOS will let you select — the **reply as you were reading it**, headings and bold and lists intact, not the markdown behind it.

### The Terminal, From Your Pocket

Wolffish runs in a terminal on your desktop too, and Channels now shows that half of it. A **CLI card** answers the two questions worth asking about a shell you are not sitting at: can it **find the `wolffish` command**, and did **autostart** take — named down to the mechanism it registered under, launchd or systemd or schtasks. Neither is a switch here. Registering with an operating system is that machine's own act, the same as Launch at startup, so this device reports it rather than driving it. What you can change is the terminal's feed: a clean account of what the agent said and delivered, or every tool call and result. And a desktop that could not answer says **Unknown** — a command nobody managed to probe never reads as a command that is missing.

### A Turn Still Being Written Says So

Come back while the desktop is **mid-answer** — the app waking, the tunnel re-forming — and the conversation now knows the turn is still going. It used to render as finished, because the announcement that it started had come and gone while the phone was away: a composer inviting a new message, no stop button, and a rating bar offering to score an answer still being written. The phone now **asks what is running** the moment it connects, and it re-opens those turns rather than beginning them, so a run you left parked on a permission card is still parked on it when you get back.

### Where a Conversation Came From

A chat started in a terminal wears a **terminal glyph** in the list, next to the phone, Telegram and WhatsApp marks already there. And a conversation the phone knows about **only because a turn is running in it** now shows its origin from the first instant, instead of sitting blank until the desktop gets round to sending the details — which, on a slow link, is the entire time anyone is watching it happen.

### Smaller Things

A reply that signs off with a sentence after a list **no longer has that last line clipped** by the bottom of the bubble. And the settings list's Preferences row now states **whether the desktop comes up on its own** beside whether the agent still stops to ask — each in its own colour, so an off worth knowing about announces itself from the list rather than waiting to be found.

## v1.0.22 — 2026-08-07

### A Rating Bar That Knows When It's Done

The 0-10 strip above the composer asked you to score a turn, and then went on asking. You tapped a number, the segment filled, and **the bar stayed exactly where it was** until the next turn came along — an answered question still sitting over the composer, holding room on a screen that has none to spare. It **retires the moment the turn has a score** now: one tap, the vote is in, the bar is gone. And because a score is a fact about the turn rather than about the device that cast it, the bar goes away **wherever the vote came from** — this phone, the desktop, or a bare number typed into Telegram or WhatsApp. Score a turn on the desktop and the chat open on your phone **stops asking in the same moment**. A vote that never reaches the desktop brings the bar back rather than leaving a score sitting there looking recorded. One deliberate trade comes with it: the bar is no longer where you go to change a vote, because a bar that lingers to allow second thoughts is precisely the one that was in the way.

## v1.0.21 — 2026-08-07

### PDFs, Read Where They Sit

A PDF in a conversation used to be a file row on Android — tap it and the document left for whatever viewer the phone happened to have. It now **opens in the card itself**, showing a real first page and expanding to the whole document, scrollable and pinch-zoomable, exactly as it already did on iPhone. The reader travels with the app rather than depending on one being installed, and the document is read where it sits: nothing is handed to another app, and the page drawing it can reach no file but the one you opened. Very large PDFs still go to the system viewer, which is where they belong.

### A Tap That Lands Where It Says

Tapping a notification now **opens the thing the notification is about** — the conversation that just finished, the schedule that ran, the screen that needs you — including when that tap is what launched the app. It used to open Wolffish and stop there, because the app was already on its way somewhere else by the time the tap was read. A conversation reached this way **waits for the desktop** rather than flashing an empty new chat and correcting itself a second later, and the back arrow on a screen opened straight from a notification now leads into the app instead of doing nothing. A link Wolffish cannot place leaves you exactly where you are — and the desktop, for its part, can no longer point a notification at a screen this app does not have.

### Smaller Things

The composer's controls button **has its own glyph** now — vertical faders, for the sheet that holds mode, thinking, model and the context meter — so it no longer reads as a second copy of the conversations navigator sitting next to it. And entering demo mode **keeps its progress bar** until the chat is actually on screen, instead of dropping it for a few frames right before the app moved anyway.

## v1.0.20 — 2026-08-07

### Six Ranges, Six Answers

The Usage screen's time ranges now each **report their own window**. Every total is closed at today as well as opened at its start, so a figure labelled Today can never quietly carry tomorrow, and stepping from 3 Months to 6 Months to Year to Date moves the numbers instead of repeating them. The switch itself now **fills its row** as a single control, splitting the width evenly between the six rather than trailing off into empty space, and it sits in the same card the rest of the screen is built from.

### The Sheet Keeps Its Destinations

Settings, Projects, Automations, Procedures and Customization now **stay put at the top of the conversations sheet** while the conversations scroll underneath them. They are the five places the sheet exists to reach, and a destination that scrolls away with the list is one you have to scroll back up to find.

### More to See Before You Pair

Demo mode gains three conversations that show the parts of Wolffish the earlier set never reached: an agent **asking permission** before it does something dangerous — and being refused once — a **twenty-question card** answered one chip at a time, and a whole session **held by voice**, spoken in both directions. The workspace behind the demo is populated too, so Projects, Procedures, Automations and the customization documents carry real content from the first screen rather than filling in a moment later.

### Smaller Things

The Model screen now leads with **how the model behaves** — chat mode and thinking — and keeps the picker below them, since those are the two knobs touched every session; the section holding them is called **Model** rather than Brain. The settings list's **Data** row shows two figures where it showed one: the desktop's workspace beside what this phone is actually holding. And a diagnostic bundle's download **counts from 0 KB rather than from nothing**, both sides in the same unit, so the first seconds of a transfer read as progress rather than a stall.

## v1.0.19 — 2026-08-06

### The Workspace, Editable

Projects, procedures and automations were things the phone could show and only the desktop could change. All three are now **edited from either screen**. A **project** gathers the instructions and files that fresh conversations start from, and a chat opened inside one carries them from its very first turn rather than picking them up a moment later. A **procedure** is a saved prompt you run on demand. An **automation** is a prompt that runs on a schedule, edited here as the same markdown file the desktop's own editor writes, with the time of its next run and a play button that reports what the scheduler actually did. Every one of these writes goes through the desktop's own code, so a change made on the phone and a change made at the machine are the same act — and both screens show it at once.

### The Three Documents Behind Every Answer

**Soul**, **User** and **Agents** — who Wolffish is, what it should always know about you, and the procedures of yours that outrank the built-in ones — now open as editors on the phone and save **straight into the desktop workspace**. These are the files that shape every reply on every surface, chat and Telegram and WhatsApp alike, and until now the only way to touch them was to be sitting at the machine.

### Turns You Can Score

Every finished answer carries a **rating bar**. A score cast here lands on the desktop exactly as the desktop's own does, and a score cast anywhere else — the desktop's bar, a bare number replied to Telegram — appears here without waiting for anything to reload. It is the same signal the agent already learns from; it simply stopped requiring the desktop.

### Every Conversation, Without Leaving the One You're In

A sheet slides over the chat carrying the **whole conversation list**, grouped by recency, showing which project each one belongs to and which one is running right now. Switching is a tap, and the turn you were watching keeps streaming while you look.

### What the Desktop Is Busy With

Automations, compaction, the nightly reflection and a memory index being rebuilt now surface as **cards over whatever screen you are on**, with the prompt behind each one a tap away. They appear the moment the phone connects — including for a run that started while it was asleep — and they go when the connection goes, because a card claiming something is running on a machine the phone can no longer see is a card that lies.

### Diagnostics From the Phone

Collecting a conversation's diagnostic bundle — logs, tasks, memory, context, settings, attachments, and the model's own account of what went wrong — is now something the phone can start, **watch step by step**, and hand to the share sheet when it finishes. It runs behind the same single-flight guard as the desktop's own button, so a run started here and one started there can never fight over the same files.

### Smaller Things

Pictures now **pinch to zoom and pan** rather than opening at one fixed size. Conversation lists show **where each one came from** — Telegram, WhatsApp, the phone, an automation — as a single glyph, the same one the desktop draws. Projects get an **emoji picker** for their icon, and the composer's queue reads more plainly than it did.
