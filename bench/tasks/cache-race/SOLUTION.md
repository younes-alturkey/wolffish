# cache-race — reviewer notes

## Symptom
`test/loader.test.js` — "refresh while a load is in flight: the refreshed value wins" fails: after the refreshed fetch resolves `v2`, the older fetch resolves `v1` and the next `get('a')` returns `v1`.

## Root cause (two files, neither is `loader.js`)
1. `src/store.js` — the stale-write guard in `Store.set` is inverted: `if (gen > this.generation(key)) return false;`. A writer's generation can never exceed the current one, so the guard never fires and a result computed against generation 0 overwrites the generation-1 value. Should be `gen < …`.
2. `src/inflight.js` — `run` clears the slot only on fulfilment: `p.then(() => this.#map.delete(key), () => {})`. The "silence unhandled rejection" no-op is the rejection branch, so a rejected promise stays in the map forever and every later `get(key)` is handed the same rejected promise: one upstream flake poisons the key permanently. The visible suite never rejects, so this is invisible until the hidden check.

## Correct fix (2 changed lines)
```js
// src/store.js
if (gen < this.generation(key)) return false;

// src/inflight.js — clear on both outcomes, without creating a new unhandled chain
const clear = () => this.#map.delete(key);
p.then(clear, clear);
```
Trap for the second line: `p.finally(clear)` alone is wrong; it returns a *new* promise that rejects whenever `p` rejects, and nobody awaits it, so the hidden suite's `unhandledRejection` listener catches a leak (Node would otherwise crash the run). `p.finally(clear).catch(() => {})` is also fine.

## Naive patch that passes the visible tests but fails verify.sh
Fix the stale write in `loader.js` instead of `store.js`, and never open `inflight.js`:
```js
const value = await fetchFn(key);
if (store.generation(key) === gen) store.set(key, value, gen);
return value;
```
All 6 visible tests pass. The hidden check's rejection tests fail: the first `get` rejects, and the second `get` rejects with the same error without calling `fetchFn` again (`fetches` stays 1). (Verified: 6/6 visible, `VERDICT: FAIL hidden check`.)

## What verify.sh checks
Pristine visible tests plus `hidden/hidden.test.js`: a rejected first call is retried by the next call (sequential and concurrent forms), a value fetched before `invalidate()` is not stored, and no unhandled rejections leak from the loader.
