# timezone-rollup — reviewer notes

## Symptom
Three visible tests fail (the suite pins `TZ=Asia/Tokyo` so the failure is machine-independent): "instants just before midnight stay on their own day", "offsets are honoured" and "rollup buckets events by day, near midnight included". `23:30Z` is `08:30` the next day in Tokyo.

## Root cause (two helpers, two files)
1. `src/keys.js` — `dayKey` builds the key from `getFullYear/getMonth/getDate`, which read the **local** calendar, on an instant that the README says must be keyed by its **UTC** calendar day. Any process not running in UTC shifts events near midnight to the neighbouring day.
2. `src/range.js` — `startOfDay` parses a key as **local** midnight (`new Date(y, m-1, d)`) and `daysBetween` does `Math.floor(diff / 86_400_000)`. On the spring-forward day the local day is 23 hours long, so a range that spans it is `n.958…` days and `floor` drops one; `dayRange` then enumerates one day too few and `rollup` silently omits the last day. The zone pinned by the visible suite (Tokyo) has no DST, so this only shows in a DST zone: the "missing day in New York" from the task prompt.

## Correct fix (about 8 changed lines)
```js
// src/keys.js
return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// src/range.js — do all day arithmetic in UTC, where every day is exactly DAY_MS
function startOfDay(key) { const { y, m, d } = parseKey(key); return new Date(Date.UTC(y, m - 1, d)); }
function format(date) { return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`; }
// daysBetween: Math.round (or keep floor — UTC days are exact) ; dayRange loop:
keys.push(format(new Date(first.getTime() + i * DAY_MS)));
```
(`Math.round` alone in `daysBetween` also fixes the DST count, but leaving local-midnight parsing in a module whose contract is UTC days is the same class of bug waiting for the next caller.)

## Naive patch that passes the visible tests but fails verify.sh
Change only `dayKey` to the `getUTC*` getters and stop. All 6 visible tests pass — `range.js` is self-consistently local (local parse, local `setDate`, local format), so it produces correct keys in any zone **without** DST. Under `TZ=America/New_York` the hidden check's `dayRange('2024-03-09', '2024-03-11')` returns two days instead of three and the week rollup across 2024-03-10 loses its last bucket. (Verified: this patch passes 6/6 visible and fails the hidden check.)

## What verify.sh checks
Pristine visible tests (Tokyo-pinned) plus `hidden/hidden.test.js` under `TZ=America/New_York`: near-midnight keys with a negative offset, the spring-forward and fall-back ranges, and a five-day rollup across the DST change with one event per UTC day.
