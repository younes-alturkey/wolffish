# STAGE.md — Wolffish Staging Procedure

Instructions for an agent **staging finished work into the upcoming release** of `wolffish-app` — everything [RELEASE.md](RELEASE.md) does **except cutting the release**. A version accumulates work across several staging passes; when the user decides it's complete, RELEASE.md ships it. Follow the steps **in order**. If anything looks wrong, **stop and report** (see [If issues are found](#if-issues-are-found--stop)).

---

## What "staging" means

The upcoming version is always a **patch bump of the current `package.json` version** — if `package.json` says `1.0.232`, everything stages into **`1.0.233`**. Each staging pass lands one batch of work on `main`: the source changes **+** changelog entries written **as if the bump already happened** **+** the README badge, committed and pushed together. Because staging never touches `package.json`, every subsequent pass computes the **same** upcoming version and adds to the **same** changelog block — until `npm run release` finally creates that version and the cycle starts over.

---

## Non-negotiables (read before doing anything)

- **Never run `npm run release` or `npm version` from this procedure, and never hand-edit the version** in `package.json` / `package-lock.json`. The whole point of staging is that **more work will join this version before it ships** — creating the version commit or tag ends the collection early and publishes a build.
- **The changelog is written as if the bump already happened:** entries go under the upcoming version's header (`1.0.N+1`), carrying the `` `Latest` `` / `` `الأحدث` `` marker, even though `package.json` still says `1.0.N`.
- **Both changelog languages, always.** Every entry in `en.md` **and** `ar.md`; AR is a full translation, not a stub.
- **Stay on `main`.** No branches. Push with plain `git push origin main` — a commit without a tag does **not** trigger the published build; the tag (created only by `npm run release`) is what publishes.
- **When in doubt, stop.** A halted stage costs nothing.

---

## Procedure

### 1. Analyze all changes

- Run `git status` and `git diff` (and `git diff --staged`) to see everything pending.
- Build a short list of **what actually changed from the user's point of view** — features, fixes, behavior changes. You need this for the changelog anyway.
- Unlike a release, **nothing user-facing is not a reason to stop**: an internal-only batch still gets staged — it simply adds no changelog section. Say so in your report.

### 2. Quick third-party sanity check (not a deep audit)

Identical rules to RELEASE.md step 2:

- Run `npm run typecheck` and `npm run lint`.
- **Lint problems: fix them yourself — don't halt.** Keep behavior identical, re-run both guards until clean; the fixes ride the staging commit. Pre-existing lint noise in files this batch never touched is left alone (just note it).
- **Code problems: STOP and await instructions.** A failing typecheck (errors *or* warnings), obvious breakage, half-finished work, a clear regression, committed secrets — never self-fixed. Go to [If issues are found](#if-issues-are-found--stop).
- Do **one** independent review pass over the diff (a reviewer subagent, or `/code-review` at low effort). Smell test, not a full review — don't rabbit-hole.

### 3. Write the changelog entries (EN + AR) — as if the bump already happened

Only reach this step if step 2 came back clean and the batch has user-facing changes.

1. **Compute the upcoming version:** patch bump of the current `package.json` version (`1.0.232` → **`1.0.233`**).
2. **Pick the changelog folder by today's date:** `src/changelog/<YYYY-MM>/`. If the month rolled over and the folder doesn't exist yet, create it with `en.md` and `ar.md`.
3. **First stage after a release** (no `1.0.N+1` block exists yet): create it at the **top** of both files, matching house style exactly — read the last 2–3 entries first. Header EN: `## v1.0.233 — <today> \`Latest\`` · AR: `## الإصدار 1.0.233 — <today> \`الأحدث\``. **Move the `` `Latest` `` / `` `الأحدث` `` marker off the previous top entry.**
4. **Every later stage** (the block already exists): **append** one `### Headline` section per new notable change to the **same block**, after its existing sections, and **refresh the header date to today** in both files. Never open a second block for the same version.
5. **Month rollover while staged:** if the block sits in an older month's files (staged in July, still unreleased in August), **move the whole block** to today's month folder — top of the new files, deleted from the old ones. The old month's top entry keeps **no** `Latest` marker. The month folder always reflects the month the version is currently expected to ship in.
6. House style as in RELEASE.md: one `### Headline` per notable change, flowing **benefit-first prose** written for a user (not a commit list), key phrases in **bold**, AR a genuine translation with the same headlines. EN and AR in lockstep.

### 4. Bump the version in the README (idempotent)

- Edit **`README.md`**, the version badge line only, to the **same upcoming version** as the changelog block (`1.0.233`).
- If an earlier staging pass already set it, verify and move on.
- **Do not touch `package.json` / `package-lock.json`.**

### 5. Commit and push — no bump, no tag

1. **One regular commit** with everything: source changes (including step-2 lint fixes) + changelog EN/AR + README badge. Concise message summarizing the batch's headline changes (e.g. `add: chart cards, channel format gates`).
2. Confirm the tree is clean: `git status`.
3. Push:
   ```
   git push origin main
   ```
   Plain push, **no tags** — nothing publishes. **Never run `npm run release` here.**
4. Report what was staged and confirm the push. **No Discord notes** — those belong to RELEASE.md step 6, at ship time.

---

## Hand-off to RELEASE.md

When the user decides the version is complete, RELEASE.md runs on top of the staged state. Its changelog + README steps become mostly **verification**: the block and badge already exist — confirm they cover everything since the last tag (`git log $(git describe --tags --abbrev=0)..HEAD --stat`), refresh the header date to release day (moving the block's month folder if it rolled), then commit anything pending and `npm run release`.

---

## If issues are found — STOP

Same semantics as RELEASE.md: any blocker — failing typecheck, a bad or breaking change, a lint error unfixable without changing behavior, an unclear diff — means **stop immediately**, report the issues minimally (one line each, no fixes, no long analysis), and hand the decision to the user. Once addressed, start over from step 1. Plain lint failures are NOT blockers — step 2 has you fix those yourself and continue.

---

## Quick reference

| Thing | Where | Touch during staging? |
|---|---|---|
| Version source of truth | `package.json` → `"version"` | **Never** — stays at `1.0.N` until release |
| Release command | `npm run release` | **Never** — RELEASE.md only |
| Version badge | `README.md` badge line | **Yes** — upcoming version, idempotent |
| Changelog (English) | `src/changelog/<YYYY-MM>/en.md` | **Yes** — create or append to the `1.0.N+1` block |
| Changelog (Arabic) | `src/changelog/<YYYY-MM>/ar.md` | **Yes** — full translation, in lockstep |

```bash
git status && git diff                 # 1. see all changes
npm run typecheck && npm run lint      # 2. guards — lint issues: self-fix; code issues: STOP
# 3. changelog: create or APPEND to the 1.0.N+1 block (as if bumped), refresh its date, EN + AR
# 4. README badge → 1.0.N+1 (skip if an earlier pass already set it)
git add -A && git commit -m "<summary>"  # 5. one regular commit …
git push origin main                     #    … plain push — NO npm run release, NO tags
```

**One-line summary:** analyze → quick third-party check (lint problems: fix yourself; code problems: stop) → if clean, write or extend the upcoming version's EN+AR changelog block as if the bump happened + bump the README badge → commit everything → plain `git push origin main` — and leave `npm run release`, the tag, and the Discord notes to RELEASE.md when the version is done collecting.
