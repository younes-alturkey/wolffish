# Wolffish Mobile — Agent Guide

The phone half of Wolffish. React Native + Expo (SDK 57) + TypeScript, one codebase for iOS and Android. It is **not a second agent** — it is a remote for the one running on the user's desktop, reached over an end-to-end encrypted tunnel.

It is no longer published to the app stores and the hosted relay is gone: users build it from source with their own Expo account, install it on their own phone, and run the relay in `../../packages/relay` themselves. README.md is the user-facing guide for that; keep its numbered steps true when anything here changes.

The desktop app (`../../`, the repository root) is the design source of truth for every screen. When a UI question comes up, look at what the desktop does and mirror it.

---

## The one rule

**The desktop owns the truth; the phone mirrors it and asks it to change things.**

Everything below follows from that sentence. The phone renders desktop state, and every edit it makes is a request the desktop applies through the exact same code path its own panels use — never a local write that gets reconciled later. There is no merge, no CRDT, no offline queue. Offline edits do not exist by design: when the tunnel is down, editable surfaces go read-only rather than accepting a change with nowhere to land.

**Syncing and keeping the connection alive is the critical constraint on every change.** A feature that works beautifully on a warm connection and silently breaks after a background/foreground cycle is a regression, not a feature. Read [Sync & connection](#sync--connection) before touching anything under `src/lib/tunnel/`, `src/lib/sync/`, or `src/state/demoConfig.ts`.

---

## Stack

- **Expo SDK 57** + **expo-router** (file-based routing, typed routes on), React Native 0.86, React 19, Hermes.
- **NativeWind 4** (Tailwind 3 classes on RN primitives) + a token layer in `src/lib/theme/colors.ts`.
- **zustand** for client state, **TanStack Query** for server state, **expo-sqlite** for the conversation store.
- **@noble** (curves / ciphers / hashes) for the Noise handshake — pure JS so the same code runs on Hermes and in Electron's main process.
- **i18next** (en / ar) with full RTL; switching language restarts the app, because RTL layout direction only applies on a fresh start.
- No Expo Go. Development runs on a native dev client (`npm run ios`).

---

## Project layout

```
src/
├── app/                    expo-router routes — the file tree IS the navigation
│   ├── _layout.tsx         root: providers, splash gate, useConnection(), OTA check
│   ├── index.tsx           the door — pair, demo, or resume
│   ├── chat.tsx            the chat screen
│   ├── history.tsx         conversation list
│   └── settings/           one file per settings screen (mirrors the desktop's tabs)
├── components/
│   ├── core/               primitives (Modal, Select, icons, ZoomableImage, …)
│   ├── chat/               feed, composer, bubbles, cards, media, chart cards
│   ├── conversations/  history/  workspace/  settings/  overlays/  pairing/  updates/
│   └── common/             composed, cross-screen widgets
├── lib/
│   ├── tunnel/             THE WIRE — vendored from the desktop's src/main/tunnel, see below
│   ├── sync/               what travels over the wire, and when
│   ├── conversations/      SQLite repo, query hooks, feed merge, segments
│   ├── db/                 schema + migrations (expo-sqlite)
│   ├── files/              50 GB conversation-scoped LRU file cache
│   ├── query/  i18n/  theme/  charts/  usage/  notifications/  updates/  demo/
│   └── automations/  emoji/  utils/
├── state/                  zustand stores (appStore, demoConfig, chatRuntime, runStatus)
├── changelog/<YYYY-MM>/    release notes, en.md + ar.md, bundled as Metro assets
└── types/

assets/       fonts, images, charts/*.webjs (vendored ECharts for the chart WebViews)
demo/         the committed demo dataset + the built bundle uploaded to the CDN
scripts/      scripts/demo/* builders + fix-fingerprint-drift.js (run before EAS builds)
plugins/      local Expo config plugins
```

**Path aliases:** `@/*` → `src/*`, `@/assets/*` → `assets/*`. Declared in `tsconfig.json` and mirrored in the jest `moduleNameMapper`. Use them across folders; `./` only within one folder.

Unlike the desktop, this repo does **not** use one-thing-per-folder. Files are grouped by area and named for what they export.

---

## Commands

```bash
npm run ios            # native dev client on the simulator (LANG is set — keep it)
npm run ios:device     # on a connected device
npm start              # Metro only, for an already-installed dev client
npm run ts:check       # tsc --noEmit
npm run test           # jest
npm run format         # prettier --write
```

**Never start Metro with `CI=1`** — it disables file watching and every edit looks like it did nothing.

After structural changes always run `npm run ts:check` **and** `npm run test`. The ship scripts gate on Prettier too, so run `npm run format` before committing.

There is no release process. The app reaches a phone only by the user building it (`npm run ios:device`, `npm run android`, or the `ios:ipa` / `android:apk` EAS scripts) or publishing an OTA update to their own Expo project (`npx eas-cli update`). Never run `eas` commands on the user's behalf, never push tags. `APP_VERSION` / `CODE_VERSION` in `app.config.ts` are bumped by hand when the user wants them bumped; nothing else reads them.

---

## Sync & connection

### The shape of it

```
  phone  ──ws──▶    your relay     ◀──ws──  desktop
         (guest)   forwards opaque      (host)
                   binary records
```

The relay (`../../packages/relay`, a Cloudflare Worker + Durable Object the user deploys) matches one `host` and one `guest` that presented the same 256-bit rendezvous ID and forwards bytes between them. **It never parses the payload** — everything is sealed end to end with Noise before it reaches the socket. The one deliberate exception is `CONTROL` records, which are plaintext JSON addressed to the relay itself (the push-notification control plane) and are terminated there.

Pairing: the desktop shows a QR (carrying relay URL + its static public key + a pairing secret) or an 8-character code (secret only). QR → `IKpsk2`, one round trip. Code → `XXpsk3`, one extra message, and the desktop's key is learned and pinned during it — after which every reconnect uses the cheaper IK path. The pairing secret enters both patterns as the PSK, so a hostile relay that knows the rendezvous ID still cannot sit in the middle.

Keys live in the OS keystore via `expo-secure-store` (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`), never in AsyncStorage. `forgetPairing()` drops the desktop but keeps the device identity, so re-pairing is a scan away.

### The wire is a two-repo contract

`src/lib/tunnel/` is vendored from the desktop's `../../src/main/tunnel/`:

| File          | Rule                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `protocol.ts` | **Byte-identical** with the desktop copy. It has no imports for exactly this reason.                                   |
| `noise.ts`    | **Byte-identical.**                                                                                                    |
| `pairing.ts`  | Identical except the `protocol` import specifier (`@/lib/tunnel/…` here, `./` there).                                  |
| `tunnel.ts`   | Identical except import specifiers, plus `any`-typed RPC/event handler generics here where the desktop uses `unknown`. |

Check with `diff -r src/lib/tunnel ../../src/main/tunnel`. Anything beyond those known lines is a **protocol split** — stop and fix it before anything else.

**Adding an `Rpc` method or `Event` topic is always a change on both sides.** The mobile half alone compiles and does nothing. Specifically:

- New RPC → add to `Rpc` in **both** `protocol.ts` copies, implement the handler in the desktop, then call it here.
- New push → add to `Event` in both, emit on the desktop, subscribe in `attachLiveUpdates` (or `attachTurnStream`).
- `configSet` keys must be on the **desktop's whitelist**; an unknown key is an error and the phone reverts by refetching the snapshot.
- Widen payloads **additively** and read them tolerantly — an older desktop simply won't send the new fields. `lib/sync/overlays.ts` normalizes every row rather than trusting the shape; copy that habit.

### What travels, and when

**Down (desktop → phone):**

|                    |                                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config snapshot    | `desktop.config.snapshot` → `state/demoConfig.ts`. Every settings screen renders from this one store, in paired mode and in demo mode alike.                                             |
| Conversation index | Metadata only — a real workspace is ~900 MB of bodies. Cursor-based (`since`), stored in SQLite's `sync_meta` beside the rows it describes.                                              |
| Conversation body  | Fetched when the user opens it, cached, stamped with the **desktop's** `updatedAt` in `body_synced_at` (never `Date.now()` — the clocks aren't synchronized).                            |
| Files              | Chunked base64url over ordinary RPC frames into the LRU cache; a conversation's files are prefetched right after its body.                                                               |
| Live turns         | `message.appended` / `message.delta` / `turn.status`, plus `ask.request` and `approval.request` cards.                                                                                   |
| Pushes             | `conversation.upserted/deleted`, `config.changed`, `variables.changed`, `usage.changed`, `projects/procedures/automations.changed`, `automations.runs`, `reindex.status`, `turn.scored`. |

**Up (phone → desktop):** `chat.send`, `chat.abort`, `chat.askRespond`, `chat.approvalRespond`, `chat.rate`, `variables.set`, `capabilities.set`, `config.set`, the projects/procedures/automations CRUD trios, the upload trio, `diagnostics.export`.

### Writing from the phone: the outbox

A naive optimistic write loses to a snapshot fetched an instant earlier that lands an instant later. `lib/sync/outbox.ts` is the guard, and **every new phone-editable key must use it**:

- A key is **dirty** from its first unsent local edit until the desktop acknowledges the latest one; snapshots must not overwrite a dirty key.
- Every key carries an **epoch** that moves on each local edit and each settlement. A refresh captures epochs before fetching and compares after — any movement means the snapshot raced a write, so local stays and the next quiet refresh lands desktop truth.
- Sends are **whole-value, debounced, one-in-flight**. Last write wins identically on both screens.
- **No retries.** A failed send abandons the local claim and asks for a refresh. Resending a stale value could overwrite a newer edit made elsewhere; honest reversion beats silent divergence.

### Live turns: order is the whole contract

`lib/sync/prompt.ts` + `state/chatRuntime.ts` + `lib/conversations/feed.ts`. Three rules that are load-bearing:

1. **The turn appears at the tap**, not at the reply — a round trip is dead air, and dead air is where users press Send again.
2. **Nothing mid-turn writes SQLite, and nothing mid-turn refetches the body.** The desktop persists an assistant message once, at the end of the turn; a fetch before that returns a transcript _without_ it and overwrites what's on screen — the vanishing reply.
3. **Live rows carry the ids the desktop will save them under**, and `feed.ts` is a pure merge by message id with no notion of time. That is what makes every arrival order safe; do not reintroduce sequencing.

### Staying connected

iOS suspends a backgrounded app within seconds, so the socket dies whenever the user leaves. **That is the normal cycle, not an error** — reconnecting is a fresh handshake in well under a second, and the desktop parks on the relay waiting for exactly this.

`lib/sync/useConnection.ts` keeps two jobs deliberately separate:

- **Getting connected** is the tunnel's own affair: backoff retries, a 15 s dial timeout, and a liveness timeout that tears down a socket gone quiet. Foregrounding only _nudges_ it past the remaining backoff.
- **Catching up hangs off the connection, not off the app opening.** Those are not the same moment, and conflating them was a real bug: foregrounding often finds the network still down. Catch-up is edge-triggered on the transition into `connected`, so every connection that forms — first, tenth, after an hour in a lift — brings the phone level with nobody watching.

On each connection: `attachLiveUpdates()`, `attachTurnStream()`, `reconcile()` (config + index + prune deletions), `seedOverlays()`. On each drop: `clearOverlays()`. **Handlers are stored per topic, so re-attaching replaces rather than stacks** — keep it that way, or a reconnect doubles every event.

Push-only state needs a **seed** as well as a subscription. A phone that connects while a nightly reflection is halfway through has already missed the only announcement it was going to get; `overlaysRead` exists for exactly that. Ask "what does a phone that arrives mid-event see?" for every new push.

### Checklist for any change that touches sync

- [ ] `diff -r src/lib/tunnel ../../src/main/tunnel` shows only the known import-specifier lines.
- [ ] Wire additions exist on **both** sides, and the desktop actually serves/emits them.
- [ ] New payload fields are additive and read tolerantly.
- [ ] Phone-side edits go through the outbox (dirty + epoch), and go read-only when disconnected.
- [ ] Nothing new writes SQLite or refetches a body mid-turn.
- [ ] Re-running the attach path is idempotent; push-only state has a seed.
- [ ] Verified on a device against a real desktop: pair → send a turn → background → foreground → confirm both directions still land.

---

## Data on the device

| Store                  | Holds                                                                 | Notes                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite (`wolffish.db`) | Conversations, messages, `sync_meta` cursor, `cached_files` LRU index | Durable. Excluded from the query persister — mirroring it into AsyncStorage would defeat the point.                                     |
| File cache             | `Documents/workspace/…` at the desktop's own relative paths           | 50 GB budget; eviction releases the **least recently used conversation whole**, never a recent one. A deleted file is simply refetched. |
| AsyncStorage           | `appStore` + `demoConfig` (zustand persist), the TanStack Query cache | Plain text on disk — never keys or secrets.                                                                                             |
| OS keystore            | Device identity keypair, pairing record                               | `expo-secure-store` only.                                                                                                               |

Factory reset is device-scoped and deliberately **keeps** the keychain pairing.

---

## Three modes, one set of screens

`appStore` carries `paired` and `demoMode` as independent flags — a device can be neither (the door screen), and disconnecting returns to demo mode being _available_ rather than implicitly entering it.

**Demo mode** downloads the committed dataset (`demo/bundle/`; the CDN that used to host it is gone, so a run points `EXPO_PUBLIC_DEMO_BASE_URL` at a locally served copy) into the same SQLite tables and the same config store that paired mode fills. Every screen downstream reads the same local store either way **and cannot tell the difference** — that is what keeps demo mode intact instead of special-cased. When you add a screen, it must work in both modes without branching; if it needs a branch, the branch belongs in the layer that fills the store, not in the screen.

The demo dataset workflow (edit `demo/` → `scripts/demo/build-demo-bundle.mjs` → serve locally with `EXPO_PUBLIC_DEMO_BASE_URL` → verify) is its own procedure; don't regenerate the bundle as a side effect of an unrelated change.

---

## Conventions to preserve

- **Comments explain _why_, never _what_.** This codebase's comments carry the reasoning behind non-obvious decisions — the failure mode a guard prevents, the bug an ordering rule was written for. When you change such code, update the comment; when you add a guard, say what it stops. Don't narrate mechanics.
- **No barrel `index.ts` files.** Explicit paths via `@/`.
- **Prettier decides formatting** — 100 columns, single quotes, no semicolons, no trailing commas. Don't hand-format.
- **No ESLint in this repo.** Prettier + `tsc --noEmit` + jest are the gates.
- **The desktop is the design reference.** Match its layout, wording and behavior unless there's a phone-specific reason not to — and say what that reason is.
- **Both languages, always.** New user-facing strings go in `src/lib/i18n/locales/en.json` **and** `ar.json`, and RTL must be checked, not assumed.
- **No scope creep.** A bug fix is a bug fix.
- **A UI change needs a device check**, not just a typecheck. Use the simulator tooling and look at it.

---

## Testing

66 jest suites via `jest-expo` + `@testing-library/react-native`, matched by `**/__tests__/**/*.test.[jt]s?(x)`.

Two rules that cost real debugging time to learn:

1. **`render` and `fireEvent` are asynchronous** — RNTL 14 renders through `act()` and publishes the result asynchronously. `await` them. A mount helper that forgets `await render(...)` leaves its `view` unbound and every later query in the file fails against an empty tree.
2. **Wrap only _out-of-band_ state changes in `await act(async () => { … })`** — a zustand `getState().putStream(…)`, a mocked RPC resolving. Do not wrap renders or `fireEvent` in it; they already run inside act, and nesting corrupts the scope.

Anything touching sync gets a test against a fake tunnel, not just a rendered screen. The existing suites under `src/lib/sync/__tests__/` and `src/app/__tests__/chat*.test.tsx` are the patterns to copy.

---

## Known gotchas

- **Native vs JS changes decide how a fix reaches a phone.** A new dependency, an `app.config.ts` plugin, an SDK bump, anything in `plugins/` or `ios/` forks the fingerprint runtime version and only reaches a phone in a rebuild. Everything else can go out over the air with `eas update` against the user's own project — an update published from a mismatched fingerprint is simply never picked up.
- **`ios/` drifts against `app.config.ts`.** Resyncing is `npx expo prebuild` **and** `pod install` (with `LANG=en_US.UTF-8`), not just one of them.
- **A new changelog month needs a code change** — static imports plus a `PAGES` entry in `src/lib/changelog/index.ts`. Metro cannot glob a folder.
- **`.md` and `.webjs` are registered asset extensions** in `metro.config.js`. That is how changelog markdown and the vendored ECharts bundle get packed into the binary.
- **Chart cards mirror the desktop's `.chart.json` cards** through vendored ECharts in WebViews. Three files must track the desktop copy; changing one repo alone splits the rendering.
- **Toasts raised inside a React Native `Modal` never paint on iOS.** Use inline errors in sheets (see `PairSheet`).
- **An iOS system picker launched during a Modal dismissal is silently killed.** Launch it from `onDismiss`.
- **Deep links are scheme-only (`wolffish://`) on purpose.** Universal links are deferred — the recipe and its two blockers are commented in `app.config.ts`; don't uncomment half of it.
- **A new screen a notification should be able to open needs `DEEPLINK_ROUTES`** in `src/lib/tunnel/protocol.ts` **and the desktop's mirrored copy** (`../../src/main/tunnel/protocol.ts`). It is an allowlist on both ends: the desktop refuses a link naming anything else (which is how the model learns the real page list), and this app ignores one, so a screen missing from it is simply unreachable by tap.
- **Unfocused single-line `TextInput`s show only the prefix of a long value** on iOS. It's why demo API keys are capped around 35 characters.
