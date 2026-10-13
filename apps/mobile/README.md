# Wolffish Mobile

**Your agent's machine, in your pocket.**

Wolffish Mobile is the companion phone app for [Wolffish](https://github.com/younes-alturkey/wolffish), the personal AI agent that runs on your own computer. It is deliberately **not** a second agent and not a cloud account: the desktop holds the models, the capabilities, the memory and the files, and the phone is a remote for it — paired once by scanning a QR code, then connected over an end-to-end encrypted tunnel that no server can read.

Built with React Native and Expo. One codebase, iOS and Android, English and Arabic with full RTL.

> **Status: tested and fully working, but no longer published.** The app has been removed from the App Store and Google Play, and the hosted relay it used to connect through has been shut down. Everything it needs is in this repository. If you want it, you build it from source with your own (free) Expo account, install it on your own phone, and run your own relay. The steps are below.

---

## Table of Contents

- [What it does](#what-it-does)
- [What you need](#what-you-need)
- [Install it on your phone](#install-it-on-your-phone)
- [How it connects](#how-it-connects)
- [How it syncs](#how-it-syncs)
- [Live turns](#live-turns)
- [Files](#files)
- [Notifications](#notifications)
- [Demo mode](#demo-mode)
- [Screens](#screens)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Development](#development)
- [Updating an installed app](#updating-an-installed-app)
- [Data on the device](#data-on-the-device)
- [Security model](#security-model)
- [License](#license)

---

## What it does

- **Chat with your desktop agent from anywhere** — the same turns, the same tool cards, the same streamed reply your desktop shows.
- **Answer the agent while you're away** — multiple-choice questions and dangerous-tool approvals park the turn and arrive as cards on the phone.
- **Run the desktop's settings** — every panel the desktop has, rendered from a live snapshot: model and providers, capabilities, channels, projects, procedures, automations, knowledge, variables, MCP servers, services.
- **Edit, not just read** — variables, capability toggles, project and procedure CRUD, the automations file, the reflection schedule and turn scores are all written back to the desktop through the same code paths its own panels use.
- **Open what the agent made** — images, video, audio, PDFs, spreadsheets, code and charts stream out of the desktop's workspace on demand and cache locally.
- **Send it work** — text, voice notes, photos, videos and documents, uploaded on send.
- **Be told when something happens** — model-initiated notifications, delivered in-band when the tunnel is up and by push when it isn't.

---

## What you need

|                              |                                                                                                                                                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The Wolffish desktop app** | Built from this repository and running on your computer. Pairing happens in its Settings → Channels → Mobile panel.                                                                                                                       |
| **A relay you run**          | The phone and the desktop meet at a WebSocket relay. The source is in [`packages/relay`](../../packages/relay) — a Cloudflare Worker you deploy to your own account in a few minutes, or a few dozen lines of Node you can host anywhere. |
| **An Expo account**          | Free, at [expo.dev](https://expo.dev). Needed to give the app its own project id, and for EAS Build if you'd rather not build locally.                                                                                                    |
| **Node.js 24+**              | And `npm`.                                                                                                                                                                                                                                |
| **For iOS**                  | A Mac with Xcode, and an Apple ID. A free Apple ID installs to your own phone for 7 days at a time; a paid developer account installs for a year.                                                                                         |
| **For Android**              | Either Android Studio (for a local build) or nothing at all (EAS Build produces an APK you sideload).                                                                                                                                     |

There is no Expo Go build. The app uses native modules (camera, keystore, SQLite, notifications) and runs on a native dev client or a release build only.

---

## Install it on your phone

Plain-English version first, details after.

1. **Deploy the relay.** Follow [`packages/relay/README.md`](../../packages/relay/README.md). You end with a `wss://` address — for example `wss://wolffish-relay.your-name.workers.dev`.
2. **Tell the desktop about it.** In the Wolffish desktop app open Settings → Channels → Mobile, paste the address into the Relay card and click **Use this relay**. (From a terminal: `wolffish settings`, then Mobile → Relay URL.)
3. **Clone this repository and install the app's dependencies.**
   ```bash
   git clone https://github.com/younes-alturkey/wolffish.git
   cd wolffish/apps/mobile
   npm install
   ```
4. **Make the app yours.** Open `app.config.ts`; the identifiers at the top are blank because the original Expo project, store records and Firebase project are gone.
   - `PACKAGE_IDENTIFIER` — change the placeholder to your own reverse-DNS id, e.g. `com.yourname.wolffish`. This is all a local build needs.
   - `EXPO_PROJECT_OWNER` and `EXPO_PROJECT_ID` — only for EAS Build or over-the-air updates: your Expo account name and the project id that `npx eas-cli init` prints (or create the project at expo.dev and copy its id). Leave them blank and the app builds locally with updates switched off.
   - Android push notifications go through Firebase Cloud Messaging and need a `google-services.json` from your own (free) Firebase project, registered for your package name. Drop it next to `app.config.ts` and add the `googleServicesFile` line the comment there shows. Skip this and notifications still arrive in-band while the app is open. iOS push needs no Firebase.
5. **Build and install.**
   - **iPhone, locally:** plug the phone in, then `npm run ios:device`. Xcode asks you to pick a signing team the first time; pick your Apple ID.
   - **Android, locally:** enable USB debugging on the phone, plug it in, then `npm run android`.
   - **Either platform, on EAS Build:** `npx eas-cli login`, then `npm run android:apk` (download the APK and open it on the phone) or `npm run ios:ipa` (register your phone's UDID when EAS asks, then install from the link it gives you).
6. **Pair.** Open the app, tap **Connect to Desktop**, and scan the QR shown in the desktop's Mobile panel. The QR carries the relay address, so the phone needs nothing typed. If you pair with the short code instead, the pairing screen's Relay card asks for the relay address too.
7. **Optional — push notifications when the app is closed.** Create an access token in your Expo account (Account settings → Access tokens) and set it on the relay as the `EXPO_ACCESS_TOKEN` secret. Without it, notifications still arrive in-band whenever the app is open.

That's it. Everything from here on is reference.

---

## How it connects

```
   iPhone / Android                  your relay                      Desktop
  ┌──────────────────┐          ┌────────────────────┐        ┌──────────────────┐
  │  Wolffish Mobile │──wss────▶│  Cloudflare Worker │◀───wss─│  Wolffish app    │
  │     "guest"      │          │  (or any host)     │        │      "host"      │
  └──────────────────┘          └────────────────────┘        └──────────────────┘
          │                       forwards opaque                      │
          └───────────── Noise-encrypted, end to end ──────────────────┘
```

### The relay is a rendezvous, not a server

The relay matches exactly one **host** (your desktop) with one **guest** (your phone) that presented the same 256-bit rendezvous ID, and forwards binary records between them. It never parses a payload, never stores conversation data, and cannot decrypt anything — every frame is sealed end to end before it reaches the socket. The relay URL travels with the pairing, so any deployment of the relay works with no code change on the phone.

The one deliberate exception is `CONTROL` records: plaintext JSON addressed to the relay itself, used only by the [push-notification control plane](#notifications), terminated there and never forwarded.

### Pairing

The desktop shows two ways in, and they differ only in how much the phone learns up front:

|             | **QR**                                                  | **Code**                                    |
| ----------- | ------------------------------------------------------- | ------------------------------------------- |
| Carries     | Relay URL + desktop public key + pairing secret         | Pairing secret only (8 characters)          |
| Handshake   | `Noise_IKpsk2_25519_ChaChaPoly_SHA256` — one round trip | `Noise_XXpsk3_…` — one extra message        |
| Desktop key | Already known                                           | Learned inside the handshake and **pinned** |

The pairing secret enters both patterns as the pre-shared key, so only a device that actually saw the QR or the code can complete a handshake — a hostile relay that knows the rendezvous ID still cannot sit in the middle. Ephemeral keys give forward secrecy. After a code pairing the desktop's key is pinned, and every reconnect from then on uses the cheaper `IK` path.

The phone's long-lived keypair and the pairing record live in the **OS keystore** (Keychain on iOS, Keystore-encrypted preferences on Android), readable only while the device is unlocked — never in AsyncStorage.

### Reconnecting is the normal case

iOS suspends a backgrounded app within seconds, so the socket dies every time you leave the app. That is the designed cycle, not an error: the desktop parks on the relay waiting, and returning re-handshakes with fresh session keys in well under a second.

Two jobs are kept deliberately separate:

- **Getting connected** belongs to the tunnel: exponential-backoff retries, a 15-second timeout on a dial that hangs, and a liveness timeout that tears down a socket that has gone quiet even when the OS still reports it open. Returning to the app only nudges it past the remaining backoff.
- **Catching up** hangs off the _connection_, not off the app opening — those are not the same moment. Foregrounding often finds the network still down; a catch-up wired to that alone would leave the phone stale until the user happened to open it again. Instead, every connection that forms brings the phone level with nobody watching.

---

## How it syncs

**The desktop owns the truth. The phone mirrors it and asks it to change things.** There is no merge, no CRDT, no offline write queue — offline edits do not exist. When the tunnel is down, editable surfaces go read-only rather than accepting a change with nowhere to land.

### Down: metadata first, content on demand

A real workspace is hundreds of conversations and close to a gigabyte of message bodies, and a phone opens one conversation at a time. So the first sync pulls three things and nothing else:

1. **The config snapshot** — everything the settings screens render, in one object.
2. **The conversation index** — metadata only: title, model, channel, icon, project, counts, stats, summary.
3. **Usage** — the ledger the Usage screen aggregates on device.

A conversation's **body** is fetched the moment you open it and cached in SQLite, stamped with the desktop's own `updatedAt` (never the phone's clock — the two aren't synchronized, and comparing across them either refetches on every open or, worse, never refetches again). Its **files** are prefetched right behind it.

Afterwards the phone stays current two ways:

- **Pushes** for anything that moves: conversations created or deleted, config changed, variables changed, usage moved, projects / procedures / automations changed, the automation run pool, memory reindex progress, and turn scores cast on any surface.
- **Reconcile** on every connection: refetch the config, pull the index since the stored cursor, and prune anything the desktop no longer lists. An incremental pull can only describe what still exists, so the prune is what makes a deletion during a long absence converge.

The cursor lives in SQLite beside the rows it describes, so it can never disagree with them — clear the database and the phone resyncs from zero automatically.

### Up: the outbox

The config store is a mirror that every refresh overwrites wholesale, which makes an ordinary optimistic write dangerous: a snapshot fetched an instant _before_ an edit can land an instant _after_ it and silently put the old value back under the user's thumb.

Two ideas prevent it, shared by every phone-editable key:

- A key is **dirty** from its first unsent local edit until the desktop acknowledges the latest one. While dirty, no snapshot may overwrite it.
- Every key carries an **epoch** that moves on each local edit and each settlement. A refresh captures epochs before fetching and compares after — any movement means the snapshot raced a write, so the local value stays and the next quiet refresh lands desktop truth.

Sends are **whole-value, debounced, and one-in-flight**, so a typing burst becomes a few writes and the desktop's arrival order is the only order there is. There are **no retries** by design: resending a stale value could overwrite a newer edit made elsewhere, so a failed send abandons the local claim and asks for a refresh instead. Honest reversion beats silent divergence.

Every write is applied by the desktop through the exact function its own panel calls, so a change from either screen is one write serialized by one mutation tail — and the push that follows is the confirmation both screens render.

---

## Live turns

The desktop runs every turn; the phone hands over the prompt and renders what comes back. The reply is not a response to the send — it arrives as a stream of events (`message.appended` snapshots, `message.delta` text between them, `turn.status` around the edges), the same stream the desktop's own chat view consumes. That is why a turn started on the phone looks identical on both screens, and why a turn started on the desktop appears here with no extra machinery.

**Order is the whole contract**, and three rules follow from it:

- **The turn appears at the tap**, not at the reply. A round trip to the desktop is dead air, and dead air is where people press Send again.
- **Nothing mid-turn writes to SQLite, and nothing mid-turn refetches the body.** The desktop persists an assistant message once, when the turn ends; a fetch before that returns a transcript without it and would overwrite what's on screen.
- **Live rows carry the ids the desktop will save them under**, and the feed is a pure merge by message id with no notion of time. A live row simply isn't emitted once the stored transcript carries its id — so the overlay can be dropped whenever, arrive whenever, and repeat, and the feed looks the same either way.

Turns that park waiting on you — the agent's multiple-choice **questions** and **approval requests** for flagged tool calls — arrive as cards anchored at the tool result they belong to. Both fail closed: an unanswered request is denied when its turn ends or the phone goes away.

A memory reindex on the desktop — the one thing that blocks it outright — shows as a card over whatever screen the phone is on. It is in-memory only and cleared the instant the tunnel drops, because the card asserts something is happening _right now_ on a machine the phone can no longer see. Background runs (automations, compaction, reflection) draw nothing; the Automations screen reports them.

---

## Files

Conversation media keeps the desktop's own workspace-relative paths. When a file is needed, its bytes come down the tunnel in 256 KiB chunks riding ordinary RPC frames, land in `Documents/workspace/…` and are tracked in an LRU index.

The cache budget is **50 GB**, and eviction releases the **least recently used conversation whole** — never a file out of a recent one. A dropped file is simply refetched the next time its conversation is opened.

Uploads go the other way through the same shape: staged locally the moment you attach them (so the message renders immediately), then streamed on send. The **desktop chooses the final path**, resolving collisions Finder-style, and the answer is what the phone stores. The same three frames retarget at a project's file list when a `projectId` is supplied.

---

## Notifications

Notifications are **100% model-initiated**: the desktop agent decides to tell you something and calls its notify tool. The desktop — never the model — stamps the notification id and the target phone id, and the relay picks the route:

- **In-band** over the live tunnel when the phone is connected, and
- **Expo push** as the fallback when it isn't. This is the one feature that needs a credential on the relay: an `EXPO_ACCESS_TOKEN` from your own Expo account (see the [relay README](../../packages/relay/README.md)). Without it the fallback is skipped and nothing else changes.

The phone registers its push token by a stable per-device id on pairing, on reconnect and on every foreground, and dedupes by notification id, because both routes can legitimately fire. Where a tap lands is the model's choice, from a fixed list: a deep link must be the app's own `wolffish://` scheme **and** name a screen that exists — the desktop refuses anything else before sending, and the phone ignores a link it cannot resolve rather than navigating somewhere arbitrary.

---

## Demo mode

The app can run without a desktop at all: **Demo mode** on the door screen loads a real, anonymized dataset — 164 conversations across three months, plus automations, projects, capabilities, channels, usage and every settings surface — into the same SQLite tables and the same config store that paired mode fills. Every screen downstream reads the same local store either way and cannot tell the difference, which is what keeps demo mode a real exercise of the app rather than a set of mock screens.

The dataset used to be downloaded from a CDN that no longer exists. The built bundle is committed in [`demo/bundle/`](demo/bundle), so to use demo mode you serve that folder yourself and point the app at it:

```bash
# in one terminal, from apps/mobile
npx serve demo/bundle            # any static file server works

# in another, with your machine's LAN address so the phone can reach it
EXPO_PUBLIC_DEMO_BASE_URL=http://192.168.1.20:3000 npm run ios:device
```

Conversations, settings and usage all load this way. Media previews in demo mode referred to a sample-file set that lived on the same CDN and is not part of the repository, so opening an attachment in demo mode may show nothing — paired mode is unaffected. Turning demo mode off puts the app back to empty.

---

## Screens

| Area         | What's there                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Door**     | Pair by QR or code, enter demo mode, or resume straight into chat                                                                                                                                                         |
| **Chat**     | Feed, composer (text, voice notes, photos, videos, documents), tool cards, question and approval cards, turn rating, file and chart viewers, conversations sheet                                                          |
| **History**  | The conversation index, grouped and searchable, with channel badges                                                                                                                                                       |
| **Settings** | Model · Capabilities · Channels · Projects · Procedures · Automations · Knowledge · Customization · Variables · MCP · Services · Usage · Appearance (theme + language) · Preferences · Data · Relay · Updates · Changelog |

The **Relay** screen is the connection itself made legible: status, rendezvous and key fingerprints, session identifier, frame and byte counters, reconnect count and last error. The **Data** screen shows the desktop's footprint and the device's, with a device-scoped factory reset.

---

## Tech stack

| Layer             | Technology                                                                   |
| ----------------- | ---------------------------------------------------------------------------- |
| **Runtime**       | Expo SDK 57, React Native 0.86, React 19, Hermes                             |
| **Routing**       | expo-router (file-based, typed routes)                                       |
| **Styling**       | NativeWind 4 (Tailwind 3) over a token layer, light/dark/system              |
| **Client state**  | zustand + AsyncStorage persistence                                           |
| **Server state**  | TanStack Query, persisted (SQLite-backed families excluded)                  |
| **Database**      | expo-sqlite — conversations, messages, sync cursor, file LRU index           |
| **Transport**     | WebSocket + Noise `IKpsk2` / `XXpsk3` via `@noble` (curves, ciphers, hashes) |
| **Secrets**       | expo-secure-store (OS keychain / keystore)                                   |
| **Media**         | expo-image, expo-video, expo-audio, expo-image-picker, expo-document-picker  |
| **Charts**        | Vendored ECharts 6 in a WebView, mirroring the desktop's `.chart.json` cards |
| **i18n**          | i18next (English, Arabic) with full RTL                                      |
| **Updates**       | expo-updates (EAS Update) on a fingerprint runtime policy                    |
| **Notifications** | expo-notifications + Expo push, relay-routed                                 |
| **Testing**       | jest-expo + @testing-library/react-native (66 suites)                        |

---

## Project structure

```
src/
├── app/                    expo-router routes — the file tree IS the navigation
│   ├── _layout.tsx         providers, splash gate, connection lifecycle, OTA check
│   ├── index.tsx           the door — pair, demo, or resume
│   ├── chat.tsx  history.tsx  showcase.tsx
│   └── settings/           one file per settings screen
├── components/
│   ├── core/               primitives (Modal, Select, icons, ZoomableImage, …)
│   ├── chat/               feed, composer, bubbles, cards, media, charts
│   ├── conversations/  workspace/  settings/  overlays/  pairing/  updates/  history/
│   └── common/             composed, cross-screen widgets
├── lib/
│   ├── tunnel/             protocol, Noise, pairing, the tunnel endpoint, the client
│   ├── sync/               what travels over the tunnel, and when
│   ├── conversations/      SQLite repo, query hooks, feed merge, segments
│   ├── files/              the 50 GB conversation-scoped LRU cache
│   ├── db/  query/  i18n/  theme/  charts/  usage/  notifications/  updates/  demo/
│   └── automations/  emoji/  utils/
├── state/                  appStore · demoConfig · chatRuntime · runStatus
└── changelog/<YYYY-MM>/    release notes (en.md + ar.md), bundled as assets

assets/     fonts, images, charts/*.webjs (the vendored ECharts bundle)
demo/       the committed demo dataset and its built bundle
scripts/    the demo builders, plus the fingerprint-drift fix EAS builds run
plugins/    local Expo config plugins
```

**Path aliases:** `@/*` → `src/*`, `@/assets/*` → `assets/*`.

`src/lib/tunnel/protocol.ts` and `noise.ts` are **vendored byte-identical** with the desktop's [`src/main/tunnel/`](../../src/main/tunnel); `pairing.ts` and `tunnel.ts` differ only in import specifiers. The wire contract is a two-sided change by construction — see [AGENTS.md](AGENTS.md).

---

## Development

```bash
npm run ios              # native dev client on the simulator
npm run ios:device       # on a connected iPhone
npm run android          # on a connected Android phone or a running emulator
npm start                # Metro only, for an already-installed dev client
npm run ts:check         # tsc --noEmit
npm run test             # jest
npm run format           # prettier --write
```

Never start Metro with `CI=1` — it disables file watching, and every edit then looks like it did nothing.

Read [AGENTS.md](AGENTS.md) before changing anything under `lib/tunnel/` or `lib/sync/`. The connection is the product, and the failure modes there are quiet ones.

---

## Updating an installed app

A release build you installed does not update itself unless you tell it where to look. Two ways to ship a change to your own phone:

|         | **Rebuild**                                                      | **Over-the-air (EAS Update)**                                     |
| ------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| Carries | Everything, including native                                     | JS, assets, locales                                               |
| Command | `npm run ios:device` / `npm run android` / the EAS build scripts | `npx eas-cli update --channel preview`                            |
| Needs   | The phone (or EAS)                                               | `EXPO_PROJECT_ID` set in `app.config.ts` before the app was built |

A native change — a new dependency, an `app.config.ts` plugin, an SDK bump — forks the fingerprint runtime version and only reaches the phone in a rebuild; `eas update` publishes against the fingerprint of the source you publish from, so a mismatched update is simply never picked up. Settings → Updates on the phone shows which runtime it is on and lets you turn the OTA check off.

Versions are the `APP_VERSION` / `CODE_VERSION` constants in `app.config.ts`. Bump them by hand when it matters to you; nothing else reads them.

---

## Data on the device

| Store                                    | Holds                                                              |
| ---------------------------------------- | ------------------------------------------------------------------ |
| **SQLite** (`wolffish.db`)               | Conversations, messages, the sync cursor, the file-cache LRU index |
| **File cache** (`Documents/workspace/…`) | Workspace media at the desktop's own relative paths, 50 GB budget  |
| **AsyncStorage**                         | App preferences, the config mirror, the query cache                |
| **OS keystore**                          | The device identity keypair and the pairing record                 |

Conversation data never leaves the pair. The relay stores none of it, and there is no Wolffish account.

---

## Security model

- **End-to-end encrypted.** ChaCha20-Poly1305 over a Noise handshake, with the pairing secret as the pre-shared key. The relay forwards ciphertext it cannot read.
- **Forward secret.** Every reconnect is a fresh handshake with new ephemeral keys.
- **Pinned peers.** The desktop's static public key is known from the QR or learned once during a code pairing and pinned from then on.
- **Keys in the keystore**, unlocked-device-only, never in plain-text storage.
- **Paths are validated on the desktop** — anything escaping the workspace root is refused, and upload destinations are the desktop's choice, not the phone's.
- **Dangerous tool calls still gate.** The desktop's approval flow reaches the phone as a card and fails closed if nobody answers.
- **Camera is pairing-only.** No capture, no library access, no recording — the photo picker runs out of process and returns only what you chose.
- **Notifications are desktop-stamped.** Ids and targets come from the pairing record, never from the model, and deep links are restricted to the app's own scheme and to screens it actually has.

---

## License

MIT License — Copyright (c) 2026 [Younes Alturkey](https://github.com/younes-alturkey)

See [LICENSE](../../LICENSE) for the full text.
