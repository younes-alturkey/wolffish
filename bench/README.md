# bench — small, nasty debugging tasks for comparing coding agents

Five self-contained projects, each carrying a real bug of the kind that trips agents: the failing test names a symptom, the root cause lives in a different file from the one the test points at, and the obvious local patch turns the visible test green while leaving the actual defect in place. A hidden check, kept outside the project the agent sees, catches that patch. Every project runs offline on Node's built-in test runner (`node --test`), so there is nothing to install.

| task | symptom the agent sees | where the bug really is | hidden check |
| --- | --- | --- | --- |
| `pagination-cursor` | tied rows skipped across pages | tie-break in `sort.js`, decoder in `cursor.js` | ties + descending order, out-of-id-order inserts |
| `timezone-rollup` | events near midnight land on the next day | local getters in `keys.js`, DST floor in `range.js` | `TZ=America/New_York` across a DST change |
| `cache-race` | `refresh()` mid-flight keeps the stale value | inverted guard in `store.js`, rejection path in `inflight.js` | a rejected first call must not poison the key |
| `unicode-slug` | emoji cut in half, decomposed accents dropped | UTF-16 counting in `length.js`/`truncate.js`, no NFC in `slug.js` | NFC/NFD equivalence under truncation, emoji at the boundary via the helpers |
| `event-order-mutation` | listener after a `once` never fires; `prev` already sorted | live-array iteration in `emitter.js`, in-place sort in `reducers.js` | manual `off` during emit, `replay` input untouched |

## Layout

```
bench/
  README.md
  run.mjs                 harness (drives an agent, then grades with verify.sh)
  tasks/<name>/
    TASK.md               the prompt the agent receives (user voice, no root-cause hints)
    project/              what the agent gets: package.json, README.md, src/, test/
    verify.sh             exits 0 and prints "VERDICT: PASS" only when truly fixed
    hidden/               pristine visible test + hidden test, copied in by verify.sh
    SOLUTION.md           root cause, correct fix, and the naive patch it rejects — reviewers only
```

`project/` is plain (no `.git`); the harness copies it to a temp dir and runs `git init` itself.

## Running one task by hand

```sh
# 1. give the agent its own copy
cp -R bench/tasks/cache-race/project /tmp/cache-race && cd /tmp/cache-race
cat ../../Users/.../bench/tasks/cache-race/TASK.md     # or just open TASK.md — this is the whole prompt
npm test                                                 # fails on the buggy code

# 2. let the agent (or you) work in /tmp/cache-race

# 3. grade it
bash bench/tasks/cache-race/verify.sh /tmp/cache-race
# ... test output ...
# VERDICT: PASS            or            VERDICT: FAIL <reason>
```

`verify.sh <project-dir>` never modifies the directory it is given: it copies it to a temp dir, overwrites the visible test file with the pristine copy from `hidden/` (so weakening or deleting the test does not help), adds `hidden/hidden.test.js`, runs the visible file, then the hidden file (for `timezone-rollup`, under `TZ=America/New_York`). The verdict is the last line on stdout and the exit code follows it.

## Calibration

Each task was checked three ways before landing here: the untouched project fails 1-3 of its 6-8 visible tests; the fix in `SOLUTION.md` (2-12 changed lines, always 15 or fewer) passes the visible tests and `verify.sh`; and the naive patch described in `SOLUTION.md` passes every visible test and fails `verify.sh`. Do not show agents anything under `hidden/` or `SOLUTION.md`.
