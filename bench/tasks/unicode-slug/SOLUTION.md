# unicode-slug — reviewer notes

## Symptom
Two of the 8 visible tests fail: "emoji are kept and never cut in half" (output ends in a lone high surrogate) and "accents written as combining marks survive" (`Créme` becomes `creme`).

## Root cause (three files; the test points at `slug.js`, the cuts happen elsewhere)
1. `src/length.js` — `charLength` returns `String.prototype.length`, UTF-16 code units. Every astral character (emoji, many CJK extensions) counts as 2, so `truncate` decides to cut strings that are within budget.
2. `src/truncate.js` — `s.slice(0, max)` slices by UTF-16 unit and lands between the two halves of a surrogate pair: `'hello-🌍'.slice(0, 7)` is `'hello-\uD83C'`.
3. `src/slug.js` — no `normalize('NFC')`, and the keep-set `\p{L}\p{N}\p{Extended_Pictographic}` has no `\p{M}`, so a decomposed accent (base letter + combining mark, the form macOS file names and some editors produce) is stripped as "punctuation". The README promises NFC output and canonical-equivalence.

## Correct fix (7 changed lines)
```js
// src/length.js
return [...String(text)].length;
// src/truncate.js
const s = String(text); const cps = [...s];
if (cps.length <= max) return s;
return cps.slice(0, max).join('');
// src/slug.js
const DROP = /[^\p{L}\p{M}\p{N}\p{Extended_Pictographic}\s-]/gu;
let s = String(text).normalize('NFC').toLowerCase();
```
Normalize **first**: NFC must happen before the drop and before the length is measured, otherwise a decomposed `è` is two code points at the cut.

## Naive patch that passes the visible tests but fails verify.sh
Do everything inside `slug.js`, leaving the exported helpers alone: add `\p{M}` to the keep-set, replace the `truncate(...)` call with an inline `[...s].slice(0, maxLength).join('')`, and normalize to NFC **at the end** (`return s.replace(trailing, '').normalize('NFC')`). All 8 visible tests pass. The hidden check fails on all three of its tests: `truncate('aaaaa🚀bbbbb', 6)` and `charLength('🚀🚀')` still use UTF-16 units (lone surrogate, count 4), and NFD input truncated at 5 gives `crém` → NFC `crèm`, not `crème`, because the mark was counted before normalization. (Verified: 8/8 visible, `VERDICT: FAIL hidden check`.)

## What verify.sh checks
Pristine visible tests plus `hidden/hidden.test.js`: NFC/NFD inputs slug identically at several `maxLength`s and the output is NFC; a 4-byte emoji exactly at the cut boundary through `slugify`, `truncate` and `charLength`, with a well-formedness scan over every cut position.
