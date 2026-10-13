## v1.0.14 — 2026-07-26

### Demo Mode, Steadier on the Way In

Entering demo mode downloads three months of real desktop usage and folds it into the app's own database — and the trip in is the part you actually experience. The **progress bar now tracks real work** rather than an estimate, moving with the bytes as they arrive and then with the conversations as they land, so a slow network reads as slow rather than as stuck. An **interrupted import resumes** instead of starting the download from the beginning, and the button that starts it **stays disabled until the data is genuinely there**, so a second tap can no longer race the first.

## v1.0.13 — 2026-07-26

### Demo Mode

The app now has something to show before you own a desktop to pair it with. **Demo mode** pulls a real dataset — a hundred and sixty-odd conversations across three months, automations, projects, capabilities, channels and settings, all of it from actual use — and runs the whole app against it: the chat feed with its tool cards and delivered files, the history list, the usage figures, every settings page filled in with the state of a working machine. The media those conversations reference is fetched **only when you open it**, so entry costs a few megabytes rather than the whole archive. Turning demo mode off puts the app back to empty.

## v1.0.12 — 2026-07-22

### A Proper Android Icon

The launcher icon on Android was the full-bleed artwork handed to a system that crops the outer third of it, which left the fish **zoomed and clipped** on every home screen. It is now drawn into the adaptive-icon safe area over its own background layer, so it survives whatever mask the launcher applies — circle, squircle or rounded square. The **splash screen** follows the platform's own convention on Android 12 and later: the logo centred on the brand dark rather than a full-screen image squeezed into an icon-sized slot.

## v1.0.10 — 2026-07-21

### Updates That Can Be Taken Back

Wolffish ships fixes over the air, between App Store releases. Two things now sit behind that: a **rollback** that returns every device on a bad update to the version it shipped from, and a **link that opens the app straight onto a named update**, which is how a fix gets checked on a real device before anyone else sees it.

## v1.0.3 — 2026-07-21

### Settings You Can Scan

**Appearance** and **Language** were loose rows in a long list. They are now **grouped into cards**, the same shape the desktop's settings use, so the page reads as a handful of subjects rather than a column of switches.

## v1.0.2 — 2026-07-20

### Switching Language Actually Switches It

Changing the language on a store build **repainted half the app and left the rest in the old one** — Arabic is right-to-left, and the layout direction it needs can only be applied to a fresh start. Picking a language now **restarts the app into it**, so the switch lands everywhere at once, in a single visible step, rather than looking broken until the next launch.

## v1.0.1 — 2026-07-20

### Wolffish on Your Phone

The first build: your desktop agent's conversations, files and settings on iOS, in **English and Arabic**, light and dark, with the whole interface mirrored for right-to-left rather than merely translated.
