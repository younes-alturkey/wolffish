# RELEASE.md — Cutting a Wolffish release

How to ship a new version of the desktop app from this monorepo. Written for an agent, fine for a human. Use judgment: the guard rails below exist to avoid a bad public release, not to make releasing a ceremony.

---

## What a release is

```
npm run release  ==  npm version patch  &&  git push origin main --tags
```

1. `npm version patch` bumps `1.0.N` → `1.0.N+1` in `package.json` + `package-lock.json`, commits that as `1.0.N+1`, and tags it `v1.0.N+1`.
2. The push of the `v*` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml): macOS, Windows and Linux builds, unsigned, attached to a GitHub Release together with the `latest*.yml` update manifests and the `install/` scripts. Release notes on GitHub are auto-generated from the commits.

The app checks that GitHub Release for updates, and the README's version badge reads from it too — so **there is no version to edit by hand anywhere**. `package.json` is the single source of truth and `npm version` owns it.

`npm version patch` refuses a dirty tree, so everything you want in the release is committed first, in its own commit. The bump commit touches only the two package files.

## The other packages

Only the desktop app is released this way. The rest of the repo rides along:

| Package | Versioning | Ships how |
|---|---|---|
| `packages/extension` | `npm run extension:bundle` bumps its own patch version and copies the build into the app | Bundled into the desktop app; commit the bump + bundle before the release |
| `packages/relay` | Own `package.json` version, bumped when it matters | Users deploy it themselves with `wrangler deploy` |
| `apps/mobile` | `APP_VERSION` / `CODE_VERSION` in `app.config.ts`, bumped when it matters | Users build it from source; `eas update` for their own phone |

None of these need touching for a desktop release unless you actually changed them. If you changed the extension, run the bundle so the new build is in the app. If you changed the relay or mobile app in a way worth noting, bump their version in the same commit — optional, nobody enforces it.

---

## Procedure

### 1. See what changed

```bash
git status && git diff
git log $(git describe --tags --abbrev=0)..HEAD --stat
```

Build a short list of what changed **from the user's point of view**. If nothing user-facing changed, don't cut a release.

### 2. Make sure it isn't broken

```bash
npm run typecheck && npm run lint
```

- **Lint findings in code this release touches:** fix them, re-run both, move on. Pre-existing noise in untouched files is left alone.
- **Typecheck errors, or anything that looks half-finished, clearly regressive, or like a committed secret:** stop and tell the user in a line each. Don't fix it silently and don't release past it.
- One quick independent look at the diff (a reviewer subagent, or `/code-review` at low effort) is enough. It's a smell test, not an audit.

### 3. Write the changelog (EN + AR)

The app shows these in its Changelog page and after an update, so they matter more than the GitHub notes.

- Next version = patch bump of the current `package.json` version (`1.0.323` → `1.0.324`). You write the entry ahead of the bump.
- Files: `src/changelog/<YYYY-MM>/en.md` and `ar.md`, by today's date. New month, new folder.
- Read the last couple of entries first and match them:
  - EN header: `## v1.0.324 — <YYYY-MM-DD> \`Latest\`` · AR header: `## الإصدار 1.0.324 — <YYYY-MM-DD> \`الأحدث\``
  - Move the `` `Latest` `` / `` `الأحدث` `` marker off the previous top entry.
  - One `### Headline` per notable change, then flowing benefit-first prose with the key phrases in **bold**. Written for a user. New entry at the top.
  - AR is a real translation of EN, same headlines, same content.

`docs/changelog/overview.mdx` (and `docs/ar/…`) is the docs site's changelog. It lags behind and is updated in batches; adding to it is welcome but not part of a release.

### 4. Commit, then release

```bash
git add -A && git commit -m "<what the release is about>"
git status            # clean
npm run release
```

One regular commit with the code, the changelog and any package bumps or bundles. Then `npm run release`. It pushes, so run it once, when you mean it.

Report the version and that the push went through. Then the workflow takes a while; the Release appears at <https://github.com/younes-alturkey/wolffish/releases> when the three builds finish.

---

## When something's off

A failing typecheck, a change that looks wrong, a diff you don't understand: stop before step 3, say what it is in a line or two, and let the user decide. Once resolved, start from step 1 again. Lint-only failures aren't a stop; you fix those.

## Quick reference

| Thing | Where | By hand? |
|---|---|---|
| Version | `package.json` → `"version"` | No — `npm run release` |
| Changelog EN / AR | `src/changelog/<YYYY-MM>/{en,ar}.md` | Yes, both |
| Extension build | `npm run extension:bundle` | Only if the extension changed |
| Relay / mobile versions | `packages/relay/package.json`, `apps/mobile/app.config.ts` | Only if you want to |
| Docs changelog | `docs/changelog/overview.mdx` | Optional |

**One line:** see what changed → typecheck + lint (fix lint, stop on real problems) → EN+AR changelog → commit → `npm run release`.
