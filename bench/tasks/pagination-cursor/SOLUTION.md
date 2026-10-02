# pagination-cursor — reviewer notes

## Symptom
`test/paginate.test.js` — "rows sharing a score are neither skipped nor repeated" fails (page 2 returns `r5` instead of `r3, r4`) and the cursor round-trip test fails (decoded cursor has no `id`).

## Root cause (two files, neither is `paginate.js`)
1. `src/cursor.js` — `decodeCursor` destructures only `[sortKey]` and returns `{ sortKey }`; the `id` that `encodeCursor` wrote is discarded. The probe row in `listPage` therefore has `id: undefined`.
2. `src/sort.js` — `compareBy` breaks ties with `a._seq - b._seq` (insertion order). The cursor probe is not a stored row and has no `_seq`, so every tie against the probe evaluates to `NaN`, `NaN > 0` is false, and `findIndex` skips all rows tied with the cursor. Even with a correct decoder the comparator can never place a probe among tied rows, and insertion order is not what the cursor encodes.

## Correct fix (4 changed lines)
```js
// src/cursor.js
const [sortKey, id] = parsed;
return { sortKey, id };

// src/sort.js  (tie-break by id, in the same direction as the sort)
if (a.id < b.id) return -sign;
if (a.id > b.id) return sign;
return 0;
```
The comparator is now a total order on (field, id) that flips with `dir`, so the same comparator sorts the rows and positions the probe, and a descending listing is the exact reverse of the ascending one (the README's stated contract).

## Naive patch that passes the visible tests but fails verify.sh
Fix the decoder, leave `sort.js` alone, and replace the probe comparison in `paginate.js` with an inline predicate (direction-aware on the field, `id` on ties):
```js
const past = (row) => (dir === "desc" ? row[sortBy] < sortKey : row[sortBy] > sortKey);
start = sorted.findIndex((row) => past(row) || (row[sortBy] === sortKey && row.id > id));
```
The visible tests insert tied rows in id order, so the `_seq` sort and the id-based predicate happen to agree. The hidden check inserts tied rows out of id order and pages both directions: the array is sorted by insertion order within a tie group but the predicate resumes by id, so rows are repeated or skipped, and the tie order does not flip with `dir`, so desc is not the reverse of asc. (Verified: this patch passes all 6 visible tests and fails the hidden check.)

## What verify.sh checks
Pristine visible tests + `hidden/hidden.test.js`: desc/asc paging with ties at several page sizes visits every row exactly once, desc equals reversed asc, and page boundaries between tied rows are right in both directions.
