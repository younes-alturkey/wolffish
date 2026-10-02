---
name: system
description: Open and close applications, open files/folders/URLs, and control machine power (restart, shutdown, sleep, lock, logout)
triggers:
  - open app
  - open application
  - launch
  - launch app
  - start app
  - run app
  - open spotify
  - open safari
  - open chrome
  - open notes
  - open finder
  - close app
  - close application
  - quit app
  - quit application
  - kill app
  - force quit
  - what apps are open
  - what's open
  - running apps
  - open applications
  - list apps
  - switch app
  - open folder
  - open file
  - open url
  - open link
  - open in browser
  - reveal in finder
  - show in finder
  - show in explorer
  - open downloads
  - open desktop
  - restart
  - reboot
  - restart my computer
  - restart my mac
  - shut down
  - shutdown
  - power off
  - turn off
  - sleep
  - go to sleep
  - lock
  - lock screen
  - log out
  - logout
  - sign out
tools:
  - name: app_open
    description: Open (launch) an application by name, optionally with a file or URL to open in it.
    parameters:
      name:
        type: string
        required: false
        description: Application name, e.g. "Safari", "Visual Studio Code".
      target:
        type: string
        required: false
        description: Optional file path or URL to open with the app (or with the default app if name is omitted).
  - name: app_quit
    description: Quit (close) a running application by name. Graceful by default; set force to kill it immediately.
    parameters:
      name:
        type: string
        required: false
        description: Application name to quit, e.g. "Spotify".
      force:
        type: boolean
        required: false
        description: Force-kill instead of quitting gracefully (may lose unsaved work). Default false.
  - name: app_list
    readOnly: true
    description: List the applications currently open (visible GUI apps).
    parameters: {}
  - name: open_path
    description: Open a file, folder, or URL with the OS default handler (file in its app, folder in the file manager, URL in the browser).
    parameters:
      path:
        type: string
        required: false
        description: Absolute path, ~-path, folder, or URL to open.
      reveal:
        type: boolean
        required: false
        description: Reveal/highlight the item in the file manager instead of opening it. Default false.
  - name: system_power
    description: Control the machine power state — restart, shutdown, sleep, lock, or logout. restart/shutdown/logout are never run by the call itself — they are armed on a turn-end countdown (a card with an Abort button) that fires a few seconds after the reply is finished.
    parameters:
      action:
        type: string
        enum: [restart, shutdown, sleep, lock, logout]
        description: Which power action to perform.
      delaySeconds:
        type: integer
        required: false
        description: Grace period between the end of this turn and the restart/shutdown/logout, 3-600. Defaults to 10. Raise it if background work you started is still running. Ignored for sleep/lock.
      immediate:
        type: boolean
        required: false
        description: Skip the countdown and go down right now. Only when the user explicitly asked for immediately and accepts losing the tail of this turn. Default false.
danger_patterns:
  - pattern: 'system_power[\s\S]*"action"\s*:\s*"(restart|shutdown|reboot|logout)"'
    level: destructive
    reason: Restarting, shutting down, or logging out closes every app — unsaved work may be lost
confirm_patterns:
  - pattern: 'app_quit[\s\S]*"force"\s*:\s*true'
    reason: Force-killing an app skips its save prompt — unsaved work may be lost
---

# System & application control

Open and close apps, open files/folders/URLs in their default handler, and
control the machine's power state. These tools issue native OS commands, so
they work without the browser or computer-use automation.

## When to use

- The user names an app to open or close ("open Spotify", "close Chrome").
- The user wants to open a file, folder, or link with its default app
  ("open my Downloads folder", "open this PDF", "open github.com").
- The user asks to restart, shut down, sleep, lock, or log out the machine.
- You need to know what apps are currently open before acting.

## Tools

- `app_open` — launch an app by name; optionally open a file/URL in it.
- `app_quit` — quit an app by name (graceful by default; `force` to kill it).
- `app_list` — list the currently open GUI apps.
- `open_path` — open a file/folder/URL with the OS default handler; `reveal`
  shows a file in the file manager instead of opening it.
- `system_power` — `restart` · `shutdown` · `sleep` · `lock` · `logout`.
  restart/shutdown/logout are armed on the turn-end countdown, never run
  inline; `delaySeconds` is the grace period after the turn ends.

## Rules

- **Match the user's intent exactly.** "Close X" → `app_quit` (graceful). Only
  pass `force: true` if they explicitly say force/kill or a graceful quit
  already failed — it can lose unsaved work.
- **`restart`, `shutdown`, and `logout` require confirmation** and will be
  shown to the user for approval before running. Don't call them speculatively;
  only when the user clearly asked. `sleep` and `lock` run without a prompt.
- **A restart, shutdown or logout is armed, not run.** The call registers it
  on the turn-end countdown and returns at once; the clock starts only after
  your reply is finished and saved, a card with an Abort button shows the
  user what is coming, and the action fires when the bar empties. Nothing
  happens while the turn is still running, and a Stop drops it. Pass
  `immediate: true` only if the user explicitly said to go down right now,
  and tell them what it costs.
- **Arm last, and say so.** Make the power call the FINAL action of the turn
  — never mid-plan with steps still queued behind it, because the countdown
  only starts when the turn ends. Before calling it, finish and report the
  work; after it, tell the user in one line what happens in N seconds and
  that the card can abort it. A user who learns about the reboot from the
  screen going black was not warned.
- **Give the machine longer when something is still running.** Raise
  `delaySeconds` if a long write, a download, an upload, or a background job you
  started is still in flight — the grace period is the only window those have
  to finish. Seconds are cheap; a half-written file is not.
- **Don't reboot through the shell.** `shutdown /r`, `Restart-Computer`,
  `reboot`, and `osascript ... to restart` via `shell_exec` skip the approval
  card AND the countdown, which is the whole safety net. Use `system_power`.
- **Anything else that would cut off your own reply** — quitting this app,
  an irreversible step the user deserves a last chance to stop — goes through
  the generic `countdown_start` tool, which arms any tool call the same way.
- **Prefer `open_path` over the shell.** To open a file/folder/URL, use
  `open_path`, not `shell_exec` with `open`/`xdg-open`/`start`.
- **Use the real app name.** On macOS that's the display name ("Visual Studio
  Code", not "code"). If a quit fails, the name may be wrong — `app_list` shows
  what's actually open.
- **Connected channels are not apps.** Telegram and WhatsApp are messaging
  channels Wolffish connects to, not local apps — never `app_open`, `app_quit`,
  or `app_list` them (or osascript a "Telegram"/"WhatsApp" window) to send or
  read messages. Use the channel tools (`telegram_send`, `whatsapp_send`, …)
  instead. `app_open` is only for launching unrelated local apps the user
  explicitly named.
- These commands target the **local machine** the user is sitting at.
