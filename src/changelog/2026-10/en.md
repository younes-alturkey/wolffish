## v1.0.329 — 2026-10-14 `Latest`

### The Changelog After Every Update in the Web UI

Updating from a browser while a conversation was open — as it usually is when you click Update in **Settings → Updates** — brought the page back on that conversation instead of on what's new. Now an update **always opens the Changelog** first, wherever you clicked Update, and the conversation you had open is **waiting right behind it** when you go back.

## v1.0.328 — 2026-10-14

### The Live Status Line Shows the Whole Step

The line that tells you what a run is doing right now used to stop at about sixty characters, so a long command read "Running find /opt/Wolffish … head -20; e…". It now takes **up to four lines**: a long command, query or file name shows **in full**, and a command that spans several lines shows **each of its lines**. Anything longer still stops cleanly at four.

### A Cancelled Reboot Brings Wolffish Back

If you chose **Reboot device** and the system then called the reboot off — an app with unsaved work on macOS, a cancelled shutdown on Windows — Wolffish used to stay paused behind the reboot screen. It now notices the machine is still up and **restarts itself**.

## v1.0.327 — 2026-10-14

### A Notifications Page in the Web UI

Everything a run sends you now lands in **one Notifications page** — finished, failed, needs you — with **Mark as read** and an **Archive**, and one read state shared by the desktop window and every browser. A conversation that has notified you shows a **bell with its own count**. While you are away from the page, what arrives is counted on the **app icon** when Wolffish is installed as an app, on the **tab title** — `(3) Wolffish` — and on the favicon, and coming back clears it. An approval or a question that blocks a run now reaches you as a push **even when the browser is only unfocused or the phone is locked**.

### Restart Wolffish, or Reboot the Device

Settings now has **Restart Wolffish** and, beside it, **Reboot device**, which saves what is in flight and then restarts the whole machine — with a warning if Wolffish is not set to start with it. In the terminal, **`wolffish restart`** restarts the app and **`wolffish reboot` now reboots the machine**: if a script of yours ran `wolffish reboot --yes` to restart Wolffish, change it to `wolffish restart`. A restart, a factory reset or an update now shows **the same overlay in the window and every browser**, and each browser reloads by itself once Wolffish is back.

### See What a Run Is Doing

A run that works without commentary used to show a rotating placeholder word for its whole length. The clean feed now shows **what it is doing right now** — "Visiting example.com", "Searching …", "Running …". A run started in another window, browser or channel **streams live** wherever its conversation is open instead of shimmering until the end. A run cut off by a quit or restart is **marked as stopped**, with a note to send a message to pick it up, and its task list reads **"stopped"** instead of spinning forever.

### OpenAI Models Remember, Report and Cost Less

On the OpenAI models, a run now **keeps its own reasoning from one tool call to the next**, so it no longer forgets a value it settled on a step earlier, and it writes **a short progress line before each stretch of tool work** even when a task asks for silence. The prompt cache now holds across the whole tool loop, so long runs are **much cheaper and faster**. Costs are also right: gpt-6 and gpt-5.6 models, and DeepSeek Flash, were priced at a far more expensive model's rate — one ~$5 run showed **$145.86**. An account with **no credits left** now fails at once with the reason, and "servers overloaded" is retried instead of ending the run.

### Long Runs Stay Smooth in the Browser

Watching a long automation in the Web UI could freeze the feed: every update carried the whole run, megabytes at a time. Updates are now **trimmed and paced to what the connection can carry**, so the feed keeps moving.

### Smaller Fixes

- **Spreadsheet styling** checks every operation first: an unknown style or key is rejected with what to use, instead of being skipped while the call reported success.
- Commands and servers Wolffish starts no longer inherit its own **`NODE_ENV`**, which made `next build` run React's development build and crash.
- A browser action on an element that never appears **fails after one wait** instead of three 30-second retries.
- A run that sends its files before summing up **still writes its summary**.
- Reading a conversation from **past its last message** shows the end instead of failing.
- Long conversations no longer pay for a **summary that saves nothing**.
- The **Ollama and provider settings** open with their last known state at once instead of a blank page.

## v1.0.326 — 2026-10-13

### Automations Run Their Job Instead of Setting Themselves Up

An automation's saved instruction used to reach the model as a plain message. One that describes its own job — "unattended automation, runs daily…" — read exactly like a request to create that automation, so a scheduled run could spend its whole time **looking for its own schedule and confirming it exists** instead of doing the work. Every automation and procedure run now opens by saying **which job is firing and that this run is it**, so the model carries out the instruction. What the conversation shows as the prompt is still your instruction as you wrote it.

### One Task List per Run, Not One per Update

A scheduled run that updated its task list many times saved **a new copy of the list every time** — one brief ended up with 138 identical "Tasks" cards stacked through its transcript. The list is now **one card, updated in place**, in automations as in chat, and conversations already saved with copies show it once, in the app and in a PDF export. A WhatsApp run no longer repeats the in-app browser's page card either.

### The Web UI Keeps Up After Your Phone Locks

When a phone's screen locked mid-answer, the Web UI lost the rest of that answer: the page stayed on **"working" forever**, even after the run had finished. Now whatever the run says while you're away is **held for your page and delivered the moment it reconnects**, in order. If you were gone so long that it couldn't be held, the page picks the answer up from what was saved and follows the run to its end, and the composer unlocks once it is done.

### Capabilities Keep Working on a Server After a Restart

On a server with no Node.js of its own, Wolffish installs one for itself, but after the next restart **its tools could no longer find npm**, so capabilities that install packages — web search, PDF, documents, spreadsheets, files — failed with "npm command not found". That Node is now **on the path at every launch**. A reboot also no longer leaves a stale lock that made Wolffish think a second copy owned the workspace and skip its **MCP connections**.

### Notifications Reach the Web UI

Asked to "send a Web UI notification", a run could pick the **browser extension's** notification tool instead, and keep failing on a server where no browser is installed. Tool search now puts a tool **named in the request** first, and the extension's notification tells the model that **notify_web** and **notify_phone** work without it.

### Closing a Turn No Longer Shows a Failure

Every turn the model ended with `close_turn` was recorded as a **failed, interrupted** call, a red card in the tools view that the next turn also saw as an error. It is now recorded as **done**.

## v1.0.325 — 2026-10-13

### `wolffish service install` Survives a Reboot on a Server

On a Linux server, `wolffish service install` — the command the install script tells you to run — registered a desktop autostart entry instead of a service. It reported success and showed autostart as on, but a box with no desktop never reads that entry, so **Wolffish stayed down after a reboot**. Run from a shell with no display, it now **installs the systemd service with lingering**, the same as `--headless`. Run it once more after this update to switch an affected server over; `--gui` keeps the desktop entry if that is what you want.

## v1.0.324 — 2026-10-13

### Changing the Password Keeps You Signed In

Setting or regenerating the master password from the Web UI used to sign out the very browser you did it from — so a regenerated passphrase was gone before you could read it. Now **every other browser** is signed out and **the one you changed it from stays in**. A browser that was signed out from elsewhere also stops retrying a connection that can never succeed: it goes straight to the **sign-in page**.

### Deleting a Conversation Is Instant

From History, Projects or the conversations sheet, a deleted conversation now **leaves the list the moment you confirm**, and the dialog closes with it — even from a phone on a slow connection. The deletion finishes behind it, and the row no longer flashes back while the index catches up. If it can't go through — a turn is still running, or the connection dropped — a message says so and **the conversation comes back**.

### The Web UI Stops Offering What Only the Desktop Can Do

In a browser, **"Show in folder" buttons are gone** — the folder would have opened on the computer running Wolffish, out of sight. A diagnostics bundle's **Save a copy** downloads the archive instead, the Ollama install page opens **in your own browser**, and the browser-extension setup shows the address to type. Where only that computer can finish the job, the Web UI says so: an MCP **sign-in** page and the Computer Use permissions open there. On plain HTTP, the microphone now explains that **it needs HTTPS** rather than blaming a system permission, and turning the Web UI **off from the Web UI** asks first, since that page loses its connection.

### o1 No Longer Fails on Tool Screenshots

OpenAI's **o1** reads images you attach, but answers every image inside a tool result — a screenshot, `image_view` — with a bare server error, so the turn failed with nothing to explain it. Wolffish now knows this up front: for o1 those images are **left out of the tool results and the model is told what it missed**, and your own attachments still reach it. Other OpenAI models were re-checked live and keep both.

### Updates Under the Linux Service Restart Once

With `wolffish service install` on Linux, an update used to restart Wolffish twice — once by the updater, again by systemd — so a browser on the Web UI saw the changelog, then "connection lost", then a second reload. Under the service, **systemd now handles the restart alone**.

## v1.0.323 — 2026-10-13

### The Whole App, in Any Browser

Wolffish has a new channel: **the Web UI**. It is on from the first launch, behind a master passphrase Wolffish generates for you, and the desktop app is served to any browser at this machine's address — a phone on the same network, or a VPS reached by its bare IP, no domain name needed. It is not a cut-down companion: the browser loads the very same interface the window shows, talking to the same brain over a socket, so every conversation, every card (tool calls, approvals, questions, reasoning, tasks, files, the in-app browser), every settings page and every switch is there. Open a conversation that is streaming in the window and watch it stream in the browser; change a setting on your phone and the window follows.

A browser types the master password **once**; it stays signed in until you choose **Sign out of this browser** from the conversations sheet, or until you sign it out from the desktop's new **Signed-in browsers** list. The door is built for a public address: sign-in attempts are rate-limited per address, the session rides an HttpOnly cookie, every request is origin-checked, and file routes never leave the workspace. The CLI carries the same seven settings (`wolffish settings list web`), and `wolffish status` reports the channel like any other.

### A Link Opened Signed-Out Asks You In, Then Opens

Open a file link from the Web UI — a notification, a pasted URL — in a browser that has not signed in, and you used to get a bare `not signed in` error. Now it lands on the sign-in page, says which link it is holding, and opens that link the moment you sign in; a download link starts downloading and leaves you in the app. Scripts and images still get the plain 401 they can act on. The sign-in page itself is tighter: one line about which password it wants, the held link on a card of its own with its path in a code block, the Wolffish version in a tag, and a wrong password answered by a proper alert card instead of a line of red text. File links are now workspace-relative (`/files/files/report.pdf`), never the machine's full directory path.

### The Master Password Has to Be Strong

A strength meter sits under the password field: four segments, a word (Weak, Fair, Good, Strong) and the one thing that would raise it. Only Good or better can be saved — at least 10 characters with a mix of letters, numbers and symbols, or a long passphrase — and the main process refuses the same passwords the meter marks weak, including the well-known ones in any disguise (`P@ssw0rd!!` is still `password`).

### A Passphrase From the First Launch, and `wolffish web`

There is always a master password now. Wolffish generates one the first time it runs — twelve random words, about 128 bits, the shape of a wallet recovery phrase — so the Web UI can be on from the start without ever standing open. The passphrase lives on the Web UI card (show, copy, regenerate) and, on a box with no screen, behind **`wolffish web password`**; `wolffish web password regenerate` makes a new one, and `wolffish web password set` takes one of your own, which is stored hashed and never shown. The rest of the card is in the terminal too — `wolffish web` for status and addresses, `web on` / `web off`, `web sessions` with `revoke`, `web notify`, `web restart`, `web renew` — and every one of them sits on the Web UI card of `wolffish settings` as well. The sign-in field and the panel's own-password field got a show/hide toggle, since twelve words are typed more often than pasted, and the strength meter now rates a long passphrase Strong. Existing installs: an upgrade switches the Web UI on and generates a passphrase only if no password was set; a password you had chosen is kept as it was.

### Notifications That Reach a Phone With the Tab Closed

The agent has a **`notify_web`** tool, the browser twin of `notify_phone`: when a run finishes, fails, or needs you, it sends a browser notification that lands on the lock screen of a phone that keeps Wolffish on its home screen, and as a toast in any open tab. It is delivered as a real Web Push, so the tab can be closed. A turn that blocks on an approval or a question while the page is hidden raises a notification on its own. Allow notifications once from the strip the Web UI shows; the panel's **Send a test** confirms the path. The browser is a first-class surface for the agent now, not a tool it might notice: the instructions that make every phone turn close with a `notify_phone` apply word for word to `notify_web` — one at the end of every turn with the real outcome, one the moment a blocker, a failure or a finding lands, never the same news twice — the agent is reminded of them on every iteration while a browser is signed in, the notification counts as the close of the turn, and a workflow subagent never holds the tool. Permission is asked once, on the first tap after sign-in, with the strip as the fallback; on iPhone and iPad the strip now says that notifications need Wolffish on the Home Screen.

### Reboot, From the Rail or the Terminal

Settings has a **Reboot** entry at the bottom of its rail. It is not a page: it asks once, then stops every channel and running turn, saves what was in flight, and starts Wolffish again on its own — the window, the daemon behind the CLI, the Web UI, the phone bridge, all of it. A browser on the Web UI shows the same "rebooting" screen the window does and reloads by itself when the new process answers. On a box with no screen, **`wolffish reboot`** does the same from the terminal (`--yes` skips the question) and waits until a fresh daemon is answering before it returns, so a script can chain on it. Linux AppImage installs come back from the .AppImage file itself rather than the mount that disappears with the old process.

### HTTPS for a Bare IP Address

Browsers only allow notifications and the microphone on a trusted HTTPS origin, so the Web UI can terminate TLS three ways. **Let's Encrypt** issues a trusted certificate for the server's **public IP address** — Let's Encrypt supports IP certificates now, so no DNS and no domain are involved — and Wolffish renews it on its own every few days (it has its own ACME client; the only thing you open is port 80). **Self-signed** gets you encryption with a one-time browser warning. **My certificate** serves PEM files you already have. Every mode switch is instant and needs no restart.

### One Install Line, From the Release Itself

The install scripts are back, and they now live where the installers do: every GitHub release carries `install.sh` and `install.ps1` beside the packages and the update manifests, so `curl -fsSL https://github.com/younes-alturkey/wolffish/releases/latest/download/install.sh | sh` (or `irm …/install.ps1 | iex` on Windows) installs the current version on any of the three platforms, checksum-verified. The scripts end with what comes next — the service, the Web UI password, the HTTPS command — and `WOLFFISH_RELEASES_BASE` points them at a mirror.

### The App Port Opens Itself in the Firewall

A fresh VPS used to stop at the first step after the install: the Web UI was listening, but the host firewall was still closed on its port, and nothing said so. The first time the server listens on an address other than loopback, it now opens its own port — 8787 unless you changed it — in `ufw`, `firewalld` or Windows Firewall, the same way the HTTPS preflight already opened 80 and 443. A refusal is logged with the exact command to run by hand, and the listener is up either way.

### `wolffish service install` Starts What It Registers

The install script's own first instruction, `wolffish service install`, refused on a fresh box with "the daemon is not running" — it sat in the group of read-only verbs that never start one. Only `install` changes the machine, so it now starts the daemon it registers; `service status` and `service path` keep refusing to.

### HTTPS in One Button

The HTTPS card does the whole job now. Pick **Let's Encrypt**, check the public address Wolffish detected (or type a domain), press **Enable HTTPS**, and watch each step settle: the address, whether it is on a local interface, ports 80 and 443, whether this process may bind them, the firewall, whether the box can reach its own port 80, then the account, the order and the certificate. A step that stops the run is expanded with the exact fix for the OS it was found on — the `sysctl` or `setcap` line on Linux, the pf forward on macOS, the firewall rule on Windows — and a **Retry**. When it works, the browser moves to `https://<address>` after a three-second countdown.

HTTPS is its own listener on 443 now, beside the plain app port, which stays up throughout and redirects to HTTPS once a trusted certificate is served; port 80 answers the validation and redirects everything else. The six-day IP certificate renews itself: a check every six hours and at boot, renewal with 72 hours left, retries backing off after a failure, the new certificate swapped into the running listener. The card shows what is served — issuer, serial, names, fingerprint, validity, hours left — the last renewal, the next check, the last 20 attempts, a live secure-context check of the browser you are in, and buttons to renew now, restart Wolffish, open the HTTPS address or switch it off. All of it is in the terminal as `wolffish web https` (`enable`, `disable`, `renew`, `--staging`), and the Windows scheduled task now restarts Wolffish if it crashes.

### Built for the Phone First

The interface now lays itself out for a phone: wrapped composer rows with larger send and stop targets, full-width bubbles, sheets that span the screen, a horizontal settings strip instead of the side rail, one pane at a time in the workspace viewer with a back button, and model and context cards that open across the composer instead of past the edge. The same rules apply in the desktop window when it is narrow. Picking a folder on the server — for a project, a procedure, an automation or "work in this folder" — is a browser now rather than a path to type: Home, Workspace and Root to start from, a breadcrumb to climb, one level of folders to tap into, hidden ones on request, and the field still there for a typed path. Attaching files from a browser works like the desktop now: a picked, dropped or pasted file shows up at once with its name, size and type — a 250 MB PDF included — and the bytes go up when you press Send, one file after another with a progress pill above the composer, before the turn starts; the attachments then render in the feed exactly as on the desktop. A slow pick (a big file a phone first copies out of iCloud) is no longer mistaken for a cancel. Two things that would have stopped a large upload dead are gone with it: on a plain-HTTP address the browser withholds the id generator the new attach code used, so files are now identified in a way every origin allows; and a very large or malformed PDF no longer reaches the in-process parser, whose failure took the whole app down — above 32 MB the page count comes from a streaming scan, and anything without a PDF header is left alone. That was not the whole story: the crash came back the moment the feed drew the PDF card, because the Web UI fetched a file's bytes through its socket, base64 in one JSON frame, and V8 cannot encode a frame that size — it aborts the process rather than throw. The Web UI no longer moves file bytes over the socket at all: images, audio, video and PDFs in the feed point at the server's own file route, which streams them with Range support and lets the browser cache them, and the viewers that do need the bytes (spreadsheets, documents, slides, text, voice memos) fetch them from the same route. The socket refuses any frame past 32 MB of binary data with a clear error instead, so no channel can take the app down that way again. And when the socket does drop, a banner says the connection is lost and being retried instead of leaving the page frozen on whatever it last showed. The other places that take files — a project's files, a procedure's, an automation's, a capability import — had the same blind spot in a browser: the upload ran with nothing on screen. Each now goes up one file at a time and reports into the panel's own copy card (which file of how many, bytes across the batch), the same card that then shows the server copying it into place; a capability dropped onto its panel is uploaded first instead of being handed over as a path the server cannot read, with the send-time pill showing its progress.
