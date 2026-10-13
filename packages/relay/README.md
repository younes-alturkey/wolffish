# Wolffish Relay

**A meeting point that forgets you exist.**

The zero-retention rendezvous relay for the Wolffish tunnel. A single Cloudflare Worker with one Durable Object class introduces a desktop and a phone by rendezvous ID and forwards their end-to-end-encrypted frames verbatim. It stores nothing, logs nothing, and only ever sees ciphertext.

> **There is no hosted relay any more.** The original `relay.wolffi.sh` has been shut down together with the store releases of the mobile app. To use [Wolffish Mobile](../../apps/mobile) you deploy this relay yourself — to your own free Cloudflare account in a few minutes, or to any machine that runs Node — and point the desktop app at it. [Deploy your own relay](#deploy-your-own-relay) is the only section you need for that; everything else explains what you are running and how to check it.

> 📄 [RELAY.html](RELAY.html) is the illustrated reference — the same material with diagrams, the ciphertext audit, throughput tables and a verified example run, generated from a real run by `npm run playground`. Open it from a local checkout.

---

## Contents

- [Deploy your own relay](#deploy-your-own-relay)
- [The problem it solves](#the-problem-it-solves)
- [How it works](#how-it-works)
- [How it's built](#how-its-built)
- [The wire contract](#the-wire-contract)
- [Moving data and files](#moving-data-and-files)
- [Push notifications](#push-notifications)
- [Security promises](#security-promises)
- [Zero data retention](#zero-data-retention)
- [No logs, no telemetry](#no-logs-no-telemetry)
- [Verifying it yourself](#verifying-it-yourself)
- [Hosting it elsewhere](#hosting-it-elsewhere)
- [Development](#development)
- [The mobile app](#the-mobile-app)
- [License](#license)

---

## Deploy your own relay

You need a Cloudflare account (the free plan is enough — the relay uses the SQLite-backed Durable Object class, which the free plan includes), Node.js 24+, and about ten minutes.

1. **Get the source.** The relay lives inside the Wolffish repository.
   ```bash
   git clone https://github.com/younes-alturkey/wolffish.git
   cd wolffish/packages/relay
   npm install
   ```
2. **Sign in to Cloudflare from the terminal.** This opens a browser window once and stores a token locally.
   ```bash
   npx wrangler login
   ```
3. **Deploy.**
   ```bash
   npx wrangler deploy
   ```
   The first deploy creates the Worker and runs the Durable Object migration. If it stops with a message about Durable Objects not being enabled, open the Cloudflare dashboard → Workers & Pages → Durable Objects, enable them once, and run the command again.
4. **Copy the address it prints.** It looks like `https://wolffish-relay.your-subdomain.workers.dev`. Your relay URL is the same with `wss://` in front: `wss://wolffish-relay.your-subdomain.workers.dev`.
5. **Check it is up.**
   ```bash
   curl https://wolffish-relay.your-subdomain.workers.dev/healthz     # -> ok
   ```
   Opening the `https://` address in a browser shows a short page that confirms the relay is online and prints the endpoint the apps use.
6. **Give the desktop app the address.** In Wolffish open Settings → Channels → Mobile, paste the `wss://` URL into the Relay card and click **Use this relay**. (Terminal: `wolffish settings` → Mobile → Relay URL.) The next pairing QR carries it to the phone, so the phone needs nothing typed.
7. **Optional — push notifications when the phone app is closed.** The relay delivers them through Expo's push service using an access token from the Expo account that built the mobile app (expo.dev → Account settings → Access tokens). Store it as a Worker secret:
   ```bash
   npx wrangler secret put EXPO_ACCESS_TOKEN
   ```
   Skip this and notifications still arrive in-band whenever the app is open; nothing else changes.
8. **Optional — your own domain.** Edit `wrangler.jsonc`: set `"workers_dev": false` and add `"routes": [{ "pattern": "relay.example.com", "custom_domain": true }]` for a zone in your Cloudflare account, then deploy again. Cloudflare creates the DNS record and certificate for you.

Then build and install the mobile app — [its README](../../apps/mobile/README.md) picks up from here.

**Keeping the retention guarantees.** The shipped `wrangler.jsonc` already encodes them: `observability.enabled: false`, `send_metrics: false`, and no storage binding other than the Durable Object. Leave those as they are, and don't add a Logpush job for the Worker in your account. The only thing Cloudflare keeps that you cannot switch off is transient per-zone request counting and TLS termination at their edge — neither sees content, since every relayed frame is ciphertext. If that boundary is not acceptable, [host it yourself](#hosting-it-elsewhere) on a machine you control.

**Updating later.** `git pull`, then `npx wrangler deploy` again. The apps and the relay are versioned together in this repository; the wire contract is in `src/protocol.ts` and mirrored byte-for-byte in both clients.

---

## The problem it solves

Two devices need to talk. Your desktop sits behind a home router; your phone sits behind a mobile carrier's NAT. Neither can accept an incoming connection, so neither can reach the other directly.

The usual answers are worse than they look. Port forwarding asks users to reconfigure routers. A traditional server means your data lives on someone else's disk. A sync service means an account, a database, and a breach waiting to happen.

This relay takes a different route: **both devices dial outward to the same address and meet there**, and everything that makes the tunnel safe happens on the devices before a byte is handed over. The relay is deliberately untrusted — it cannot read what it carries, and it keeps nothing once the sockets close.

## How it works

```
   Desktop (host)                                        Phone (guest)
   behind home NAT                                    behind carrier NAT
        |                                                      |
        |  outbound wss                          outbound wss  |
        +--------------->     your relay     <----------------+
                           Worker + Durable Object
                           one instance per rendezvous ID
                           RAM only · no disk · no logs
        +---------------  end-to-end encrypted  ---------------+
                    the relay carries bytes it cannot read
```

Because both sides connect outward, the tunnel forms across any NAT with no port forwarding, no static IP, and no router configuration.

### Pairing happens once — by QR, or by a typed code

The desktop shows a QR code carrying three things: the relay URL, its long-lived public key, and a freshly generated 32-byte pairing secret. The phone's camera reads it.

That camera hop is the security-critical part. Because the secret travels **out of band** — screen to lens, never over the network — a hostile relay cannot insert itself into the pairing. It never sees the secret, so it can never complete the handshake in the middle.

From that secret both devices independently derive the same rendezvous ID:

```
rid = HMAC(pairing_secret, "rid-v1")      # 256 bits, lowercase hex
```

It is unguessable, and it is the only fact about a pairing the relay ever learns. It identifies a meeting, not a person.

**When a camera isn't an option**, the same pairing works from a typed code: eight Crockford-base32 characters like `GE3K-J7C4`, live for three minutes and good for one use. That matters more than it sounds — a desktop agent on a headless box or reached over SSH has no screen to show a QR at all.

A code can't carry a 64-character public key, so code pairing runs **Noise XXpsk3** instead: both static keys are exchanged _inside_ the handshake and pinned there, and the code only has to carry the secret. It costs one extra message — three instead of two — paid once. From the next connection onward a code-paired device is indistinguishable from a QR-paired one; both reconnect with IKpsk2 against pinned keys.

Forty bits sounds small until you notice each guess costs a network round trip against a code that expires in minutes, which is why no PAKE is needed. Decoding folds case, dashes and the `O`/`0`, `I`/`L`/`1` look-alikes, so reading a code down a phone line works. The QR remains the default: its secret travels screen-to-camera and can't be screenshotted into a group chat.

### Then a handshake, on every connection

Pairing is once; connecting is automatic and needs no user action. The devices already hold each other's keys, so they run a **Noise IKpsk2** handshake — the pattern built for exactly this asymmetry, where the initiator knows the responder's static key but not the reverse.

```
Noise_IKpsk2_25519_ChaChaPoly_SHA256

  <- s                        desktop's static key, carried by the QR
  ...
  -> e, es, s, ss             message 1   phone -> desktop
  <- e, ee, se, psk           message 2   desktop -> phone
                              => two transport keys, one per direction
```

| Property                  | What it means                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Mutual authentication** | Each side proves possession of its long-term key; the desktop pins the phone's key on first contact        |
| **Forward secrecy**       | Fresh ephemeral keys per session — a key stolen next year cannot decrypt traffic captured today            |
| **Pairing binding**       | The pairing secret enters as the PSK, so knowing the rendezvous ID is _not_ enough to complete a handshake |

One round trip, typically ~600 ms including the connection.

### Connection lifecycle

The two sides behave differently, and deliberately so.

The **desktop parks**: one long-lived connection held open with a 25-second keepalive, which the Workers runtime answers without even waking the Durable Object. The **phone comes and goes**: iOS suspends the app on background, so it connects when it becomes active and disappears when it doesn't.

Neither is a problem, because reconnection is stateless and cheap. A returning device runs a fresh handshake — new session keys, no user action, sub-second — and any interrupted file transfer resumes from its checkpoint. Desktop clients should reconnect with exponential backoff and treat disconnection as routine weather rather than an error state.

## How it's built

The entire cloud footprint is one Worker script containing one Durable Object class — about 250 lines. No server, no container, no database, nothing to patch.

| File                                 | Role                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| [`src/index.ts`](src/index.ts)       | Stateless front door: validates the URL shape and role, routes to the Durable Object owning that rendezvous ID     |
| [`src/tunnel.ts`](src/tunnel.ts)     | The Durable Object: pairs the two roles, forwards binary frames verbatim, replaces zombie sockets, enforces limits |
| [`src/protocol.ts`](src/protocol.ts) | The wire contract in one file — ID format, roles, frame cap, keepalive, close codes, presence notices              |
| [`wrangler.jsonc`](wrangler.jsonc)   | Configuration, and where the retention guarantees are pinned so every deploy re-asserts them                       |

### Why a Durable Object

A plain Worker is stateless by design: two requests can land on two machines in two cities that share nothing. If both devices simply "connected to the Worker" they would land on unrelated instances and never find each other.

A Durable Object adds exactly one thing: **named single-instance routing**. Every request for a given name reaches the same one running instance, anywhere on earth. That is what lets two sockets be in the same place at the same time.

"Durable" refers to that stable _identity_, not to storage. A Durable Object _may_ attach persistent storage; this one simply never calls it.

The relay uses the WebSocket **Hibernation API**, so an idle tunnel is evicted from memory entirely and a parked desktop costs nothing. Connection state lives inside the sockets themselves (role tags and attachments), never in instance fields — and eviction is the whole cleanup story.

## The wire contract

### Endpoints

| Route                                               | Behaviour                                     |
| --------------------------------------------------- | --------------------------------------------- |
| `GET /t/<rid>?role=host\|guest` + WebSocket upgrade | Join the tunnel for that rendezvous ID        |
| `GET /healthz`                                      | `200 ok`                                      |
| `GET /`                                             | Status page (HEAD allowed, for uptime checks) |
| anything else                                       | `404` / `400` / `405` / `426`                 |

`rid` must match `^[0-9a-f]{64}$`. The desktop connects as **`host`** — the parked, always-on side. The phone connects as **`guest`**.

### Frames

- **Binary frames are peer data**: opaque sealed records, forwarded verbatim to the other role, capped at **1 MiB** each.
- **Text frames from the relay** are presence notices, the only text it ever sends: `{"t":"peer-present"}` and `{"t":"peer-gone"}`.
- **Text from a client**: exactly one is legal — the keepalive `ping` -> `pong`, answered by the runtime without waking the Durable Object. Send it every ~25 s to hold idle connections open. Anything else closes the connection.

### Close codes

| Code   | Name              | Meaning                                                           |
| ------ | ----------------- | ----------------------------------------------------------------- |
| `4000` | Replaced          | A newer connection for your role arrived; this socket was evicted |
| `4400` | ProtocolViolation | You sent a non-keepalive text frame                               |
| `4413` | MessageTooLarge   | You sent a frame over 1 MiB                                       |

### Semantics client authors must know

- **One live socket per role.** A reconnect _replaces_ its predecessor, and the peer never sees a false `peer-gone` during that swap.
- **Frames sent while the peer is absent are dropped.** Presence notices tell you when someone is there; delivery guarantees belong to the end-to-end protocol's acknowledgements, never to the relay.
- **The relay never buffers, parses, or persists frames.** There is no queue, no history, no storage.

## Moving data and files

Above the sealed frame layer sit three kinds of traffic, all multiplexed on one socket:

- **RPC** — request/response in either direction. The phone fetches configs and conversations; the desktop calls tools only the phone has (camera, location, notifications).
- **Events** — unsolicited pushes: streaming agent output, "this conversation changed".
- **Files** — resumable transfer, either direction.

**The tunnel is fully symmetric once established.** Which side dialed out first stops mattering after the handshake; both ends serve and consume.

Files never move as files. They move as a stream of independently sealed chunks:

```
sender                                                    receiver
  |  MANIFEST  name, size, chunk size, count, sha256          |
  |---------------------------------------------------------->|
  |                             WANT  "start from chunk N"     |
  |<----------------------------------------------------------|
  |  CHUNK x up to 32 in flight, 256 KiB each, sealed alone    |
  |---------------------------------------------------------->|
  |            ACK every 16 chunks — credit + checkpoint       |
  |<----------------------------------------------------------|
  |             ** connection dies mid-transfer **             |
  |  reconnect -> new handshake -> WANT from the checkpoint    |
  |---------------------------------------------------------->|
```

Each chunk is encrypted on its own, so a corrupted or reordered one fails loudly and alone rather than poisoning the file. The receiver writes each chunk straight to disk at its offset and checkpoints every sixteen; if the connection dies, reconnecting replays the manifest and the receiver asks to continue where it stopped. When the last chunk lands, the whole-file hash is compared against the manifest before the file becomes visible.

The sender holds a window, never the file, so memory stays flat whether the file is 3 MB or 300 GB. There is no protocol size limit — the practical bounds are disk space and patience.

## Push notifications

The one job the endpoints cannot do alone: reach a phone that is not connected. iOS suspends the app within seconds of backgrounding, so when the desktop agent finishes a run and wants to say so, there is often nobody on the other end of the tunnel. The relay is the only party that both knows whether the phone is live and can hold the routing state a platform push needs — so it carries a small, explicitly relay-readable **control plane** beside the sealed data plane.

Notifications are **100% model-initiated**: the desktop sends a `notify` frame only when the agent calls its `notify_phone` tool. The harness adds no automatic triggers, and the model never supplies routing identity — the desktop stamps `notificationId` (a ULID) and `phoneId` from its own pairing record, treating all model output as untrusted input.

### The control plane

Binary records tagged `0x03` (`CONTROL_RECORD` in [`src/protocol.ts`](src/protocol.ts)) are plaintext JSON addressed to the relay — parsed and terminated here, never forwarded. Handshake (`0x01`) and transport (`0x02`) records remain opaque and are forwarded verbatim, exactly as before. An old relay forwards `0x03` records like any other binary frame and both apps silently drop record types they don't know, so version skew degrades to "no push", never to a broken tunnel.

| Frame              | Direction       | Sender allowed      | Purpose                                                   |
| ------------------ | --------------- | ------------------- | --------------------------------------------------------- |
| `register_push`    | phone → relay   | `guest` socket only | Upsert the phone's Expo push token (or null) by `phoneId` |
| `notify`           | desktop → relay | `host` socket only  | Ask for a notification to reach the paired phone          |
| `notification`     | relay → phone   | —                   | In-band delivery of a notify                              |
| `notification_ack` | phone → relay   | `guest` socket only | The in-band delivery arrived and was rendered             |
| `notify_result`    | relay → desktop | —                   | Immediate answer: `inband`, `push`, or `dropped`          |
| `set_badge`        | phone → relay   | `guest` socket only | Reconcile the phone's unread badge count (absolute)       |
| `unregister_push`  | phone → relay   | `guest` socket only | Forget the device on unpairing — token, platform, badge   |

The relay also keeps one integer per device: an unread badge count, incremented on every delivered notify and stamped as `badge` onto the Expo push so the app icon shows the number while the app is dead. The phone owns the real (per-conversation) unread state and overwrites the integer with an absolute `set_badge` whenever its local count changes — absolute, not a delta, so a lost frame can never make the number drift.

A phone-initiated unpair ends the registration explicitly: the phone sends `unregister_push` while its socket is still up, the relay deletes the device record (token, platform, badge and all), and every later `notify` for that `phoneId` answers `dropped` — honest, instead of pushing at a device that wiped its copy of everything the notification describes. The delete is idempotent, and re-pairing simply registers afresh.

Authorization is the rendezvous itself: joining the tunnel requires the 256-bit rid only the paired devices can derive, and each frame type is additionally bound to the role that may send it. A `notify` must also name a `phoneId` registered **on this pairing** — a mismatch is answered with a `dropped` result, never rerouted.

### Delivery decision tree

For each valid `notify`, in order:

```
1. notificationId already processed?  -> replay the stored result (idempotent), send nothing
2. phoneId not registered here?      -> notify_result: dropped ("not registered on this pairing")
3. phone socket live?                -> deliver in-band, answer `inband`,
                                        then wait 2 s for the phone's notification_ack;
                                        no ack + token known -> Expo push in the background
                                        (the phone dedupes by notificationId, so the user
                                        can never see the same notification twice)
4. no live phone, token known?       -> answer `push`, send via Expo in the background
5. no live phone, no token?          -> notify_result: dropped ("no push token")
```

**Transport priority is per platform.** Android is always sent at high priority, whatever urgency the model chose; iOS keeps the mapping urgency implies (`high` → APNs 10, otherwise APNs 5). Expo's two priorities do not mean the same thing on the two platforms: APNs 5 is a power hint and the notification still arrives, while FCM normal is a queue — a phone in Doze holds the message until its next maintenance window, minutes at best and hours overnight, which is precisely the asleep-and-closed case push exists for. On Android, `normal` was never a quieter delivery, only a later one, and the phone cannot show the difference anyway (one channel, `agent-runs`, at HIGH importance). Every push here is a user-visible notification the model deliberately sent, which is what FCM reserves high priority for.

The desktop's answer never waits on Expo — pushes run in `waitUntil` after the `notify_result` is on the wire. Expo sends go straight to `exp.host` with plain `fetch` (no SDK), batched at most 100 per request, authenticated with the `EXPO_ACCESS_TOKEN` Worker secret (the Expo project has Enhanced Security for Push Notifications enabled, so an unauthenticated send fails — loudly, in the logs). Fifteen minutes after any push send, a Durable Object alarm sweeps the stored ticket ids through `getReceipts`: a `DeviceNotRegistered` receipt deletes that phone's registration (the token is dead — uninstall or rotation), and an `InvalidCredentials` receipt is logged distinctly because it is the only signal that the FCM/APNs credentials themselves are broken.

### The lifetime of each identifier

| Identifier      | Scope              | Lives                                                                                                                                                                         |
| --------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phoneId`       | one physical phone | Permanent — minted once on the phone, survives re-pairing and reconnects                                                                                                      |
| rendezvous ID   | one pairing        | Until re-pairing — derived from the pairing secret, stable across reconnects; this is the Durable Object's name, which is why registrations survive reconnects                |
| session         | one connection     | Until the socket drops — fresh Noise handshake and keys every connect                                                                                                         |
| Expo push token | one app install    | Until reinstall, platform rotation, or unpairing — the phone re-registers on every foreground, `unregister_push` deletes it on unpair, and the receipt sweep prunes dead ones |

### What this changes about retention

The data plane is untouched: conversation content still crosses the relay only as ciphertext, unparsed and unstored. The control plane deliberately retains three small things in Durable Object storage, keyed under distinct prefixes: `device:<phoneId>` (push token, platform, app version, unread badge count), `ticket:<notificationId>` (Expo ticket ids awaiting receipts), and `notif:<notificationId>` (processed ids for idempotency, pruned after 24 h). Notification **titles and bodies are never stored** — they pass through to Expo's push service only when the push fallback actually fires, which is inherent to any platform push: Apple and Google deliver the banner, so they see its text. Keep that in mind when wording notifications; conversation content never rides this path. Push tokens are logged only as a short prefix.

Self-hosting note: the control plane needs an `EXPO_ACCESS_TOKEN` secret (locally: `.dev.vars`, gitignored) for the push fallback. Without one, in-band delivery still works and pushes fail loudly in the logs.

## Security promises

The relay is **untrusted by design**. Every guarantee below holds even if the relay is fully compromised, operated by someone else, or replaced by a hostile clone.

| Promise                                    | How it's achieved                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Content is unreadable in transit           | Every frame sealed on-device with ChaCha20-Poly1305 under keys the relay never sees           |
| Tampering is detected                      | AEAD authentication per frame — one flipped bit fails the tag and the frame is discarded      |
| Replay and reordering fail                 | Per-session keys with a strictly increasing nonce counter                                     |
| Past traffic stays safe                    | Forward secrecy — fresh ephemeral keys per session                                            |
| The relay cannot impersonate either device | Mutual authentication against pinned static keys; the pairing secret it never saw is required |
| Pairing cannot be intercepted              | The secret travels out of band, screen to camera, and is mixed in as the PSK                  |
| Strangers cannot join                      | The rendezvous ID is 256 bits; even holding it does not permit a handshake                    |
| Nothing survives the session               | No storage is ever written — see below                                                        |

### What a hostile relay could still do

Stated plainly, because a security claim without its limits is marketing.

A relay operator — Cloudflare, or you if you self-host — can observe **while the sockets are live**: the two IP addresses, the rendezvous ID, the timing of frames, and their sizes. It can also refuse service or drop frames.

It **cannot** read content, alter it undetected, replay it, forge a frame either device will accept, impersonate either side, or recover anything after disconnection. Traffic metadata is the irreducible cost of any relayed system; this design keeps it minimal and never records it.

## Zero data retention

"We don't store your data" is a promise. Here is the version you can check — every piece of state in the system and where it lives.

| State                                                                                                    | Where it lives                                                         | Lifetime                                                            |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Device keypairs, peer public key, pairing secret                                                         | Platform secure storage — see the caveat below                         | Until you unpair                                                    |
| Conversations, configs, files, sync cursors                                                              | Each app's own local database                                          | The product's own data — endpoints, not the pipe                    |
| Session keys                                                                                             | Both devices' RAM                                                      | One connection                                                      |
| The socket pair and a role tag                                                                           | Relay RAM                                                              | Dies with the sockets                                               |
| Push routing state: token and unread badge count by phoneId, Expo ticket ids, processed notification ids | Durable Object storage — see [Push notifications](#push-notifications) | Token until re-registered or pruned dead; tickets ~15 min; ids 24 h |
| Message content in any database, object store, queue or log                                              | **Does not exist**                                                     | —                                                                   |

Unpairing means deleting the stored key material on each device. There is nothing in the cloud to delete because nothing was ever written there — which is also why reconnection is free: there is no server-side session to restore, ever.

**Measured, not asserted.** After a full playground run moved ~249 MB through production, the relay's storage meters read **0 B** across every counter — SQL storage, key-value storage, rows read, rows written, storage operations. Compute happened; storage did not.

### Where the keys actually live

"Secure storage" is not one thing, and the guarantee differs per platform. What each side actually gets:

| Platform | Backend                                                         | What it protects against                                         |
| -------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| macOS    | Keychain, via Electron `safeStorage`                            | Other users **and** other apps in the same user session          |
| iOS      | Keychain Services, via `expo-secure-store`                      | Other apps; survives app uninstall under the same bundle ID      |
| Android  | Keystore-encrypted `SharedPreferences`, via `expo-secure-store` | Other apps; cleared on uninstall                                 |
| Windows  | DPAPI, via Electron `safeStorage`                               | Other **users** on the machine — _not_ other apps running as you |
| Linux    | `gnome-libsecret` / `kwallet`, via Electron `safeStorage`       | Other users, **only when a secret store is present**             |

**The approach is deliberately boring: use each platform's default.** `safeStorage` on desktop and `expo-secure-store` on mobile are built in, need no native modules, and behave the same on every install — no passphrase prompts, no custom key derivation, nothing that can fail for a subset of users.

One documented gap comes with that choice. On Linux, if no secret store is available, Electron's docs say items "will be unprotected as they are encrypted via hardcoded plaintext password" — obfuscation rather than encryption, on headless boxes and minimal window managers.

That is accepted rather than engineered around. A device whose home directory an attacker can already read has bigger problems than these keys, and the alternatives all trade a rare edge case for complexity that would fail for ordinary users. `safeStorage.getSelectedStorageBackend()` returns the active backend in one call, so the connection-details screen can simply show it.

## No logs, no telemetry

Retention has a second face: even without a database, a service can leak everything through its logs. This one is configured so there is nothing to leak, and the settings live in version control so every deploy re-asserts them.

| Surface                                                 | State                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| Worker logs and traces                                  | Disabled in `wrangler.jsonc` (`observability.enabled = false`) |
| Log export (Logpush)                                    | No jobs configured                                             |
| `console.log` anywhere in the source                    | Not a single one                                               |
| Error-tracking or analytics SDK                         | None — the Worker has no runtime dependencies                  |
| Storage bindings (KV, D1, R2, queues, analytics engine) | None — the only binding is the Durable Object itself           |
| Build-tool telemetry                                    | Off (`send_metrics: false`)                                    |
| Browser telemetry headers (NEL / report-to)             | Switched off at the zone                                       |
| Tail workers (a covert log path)                        | None connected                                                 |

What remains, honestly: the platform's own aggregate request counters, and TLS terminating at the edge as it does for any hosted service. Neither exposes content, because what crosses the edge is already ciphertext sealed on your devices. If that residual matters to you, the answer is [running the relay yourself](#run-your-own-relay).

## Verifying it yourself

Two layers of proof ship with the repo.

**`npm test`** — 19 contract tests inside real workerd: routing, role validation, pairing and presence, verbatim binary relay, cross-rendezvous isolation, text-frame and oversize enforcement, and socket-replacement semantics.

**`npm run playground -- --relay wss://your-relay`** — the whole system driven end to end against a relay you name. It stands up both ends of the tunnel, pairs by QR, hand-shakes, audits the wire, tries to break in, syncs configs and conversations, streams an agent turn, moves files in both directions including a 248 MB PDF that is deliberately interrupted mid-flight, and verifies every artifact by sha256.

Every fixture comes from the mobile app's demo dataset, so the run carries no personal data. The dataset's original CDN is gone: the conversation bundle is committed at [`apps/mobile/demo/bundle/`](../../apps/mobile/demo/bundle) and the harness reads it from wherever you serve it (`DEMO_BASE_URL`); the sample files and the big PDF are not in the repository, so point `SAMPLES_BASE_URL` at your own or run with `--quick`.

A full run is **55 checks** and regenerates [RELAY.html](RELAY.html) — the committed copy is from a real run against the original hosted relay before it was retired. See [playground/README.md](playground/README.md) for the phase list and how to extend it.

## Hosting it elsewhere

Nothing about the relay is Cloudflare-specific: it matches two sockets by name and forwards bytes. The desktop and mobile apps accept any `wss://` address, because the relay URL travels inside the pairing QR, and content security never depended on the relay's honesty. This is the whole data plane, runnable anywhere Node runs:

```js
import { WebSocketServer } from 'ws' // npm i ws

const rooms = new Map() // rid -> { host, guest }   RAM only, never persisted
const RID = /^[0-9a-f]{64}$/
const MAX = 1024 * 1024

new WebSocketServer({ port: 8787 }).on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x')
  const rid = url.pathname.match(/^\/t\/([0-9a-f]{64})$/)?.[1]
  const role = url.searchParams.get('role')
  if (!rid || !RID.test(rid) || (role !== 'host' && role !== 'guest')) return ws.close(1008)

  const room = rooms.get(rid) ?? {}
  room[role]?.close(4000, 'replaced') // newest connection per role wins
  room[role] = ws
  rooms.set(rid, room)

  const peer = () => (role === 'host' ? room.guest : room.host)
  if (peer()?.readyState === 1) {
    ws.send('{"t":"peer-present"}')
    peer().send('{"t":"peer-present"}')
  }

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return data.toString() === 'ping' ? ws.send('pong') : ws.close(4400)
    if (data.length > MAX) return ws.close(4413)
    if (peer()?.readyState === 1) peer().send(data, { binary: true })
  })

  ws.on('close', () => {
    if (room[role] === ws) delete room[role]
    if (peer()?.readyState === 1) peer().send('{"t":"peer-gone"}')
    if (!room.host && !room.guest) rooms.delete(rid) // forget everything
  })
})
```

Serve it over TLS (`wss://`), and **turn off access logging deliberately** — most web servers record every connection by default, which would put back exactly what this design removes. Make sure your proxy does not buffer or time out WebSocket upgrades. This minimal server has no push control plane: notifications arrive in-band only, which the apps handle gracefully.

### Verifying your relay

```bash
curl https://relay.example.com/healthz          # Cloudflare deployments answer "ok"

# drive the entire cycle against your own deployment
npm run playground -- --relay wss://relay.example.com
```

That last command runs pairing, handshake, ciphertext audit, intrusion probes, bidirectional transfer with an interruption, and byte-for-byte verification against your relay — and writes you a report like [RELAY.html](RELAY.html). See [Verifying it yourself](#verifying-it-yourself) for what its fixtures need.

## Development

| Command                                 | What it does                                                  |
| --------------------------------------- | ------------------------------------------------------------- |
| `npm run dev`                           | Local relay on `localhost:8787` via `wrangler dev`            |
| `npm test`                              | Contract suite in workerd (`@cloudflare/vitest-pool-workers`) |
| `npm run playground -- --relay <url>`   | Drive the whole tunnel end to end against a relay             |
| `npm run playground:quick -- --relay <url>` | Same, without the 248 MB file (~1 min)                    |
| `npm run playground:local`              | Drive `npm run dev` on localhost                              |
| `npm run report`                        | Re-render `RELAY.html` from the last run's data               |
| `npm run typecheck` / `lint` / `format` | The usual guards                                              |
| `npm run deploy`                        | `wrangler deploy` to the account you are logged in to         |

Requirements: Node 24+, npm 11+. Local push testing needs `EXPO_ACCESS_TOKEN` in a gitignored `.dev.vars` file.

## The mobile app

Wolffish Mobile is the companion phone app — pair it to your desktop once by scanning a QR code, then reach your agent from anywhere over an end-to-end encrypted tunnel through this relay. It is no longer in the app stores; you build it from source with your own Expo account and install it on your own phone. The source and the step-by-step guide are in [`apps/mobile`](../../apps/mobile).

## License

[MIT](../../LICENSE) © Younes Alturkey
