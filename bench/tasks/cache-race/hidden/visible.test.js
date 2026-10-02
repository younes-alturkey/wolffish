import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoader } from '../src/loader.js';

const tick = () => new Promise((r) => setImmediate(r));

/** A fetch function whose promises are settled by the test, in any order. */
function controlled() {
  const pending = [];
  const fetchFn = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  return { fetchFn, pending };
}

test('a second get for the same key is served from cache', async () => {
  let n = 0;
  const loader = createLoader(async (key) => `${key}#${++n}`);
  assert.equal(await loader.get('a'), 'a#1');
  assert.equal(await loader.get('a'), 'a#1');
  assert.equal(loader.stats().fetches, 1);
});

test('concurrent gets for the same key share one fetch', async () => {
  const { fetchFn, pending } = controlled();
  const loader = createLoader(fetchFn);
  const p1 = loader.get('a');
  const p2 = loader.get('a');
  await tick();
  assert.equal(pending.length, 1);
  pending[0].resolve('v1');
  assert.deepEqual(await Promise.all([p1, p2]), ['v1', 'v1']);
  assert.equal(loader.stats().fetches, 1);
});

test('different keys are fetched independently', async () => {
  const loader = createLoader(async (key) => key.toUpperCase());
  assert.deepEqual(await Promise.all([loader.get('a'), loader.get('b')]), ['A', 'B']);
  assert.equal(loader.stats().fetches, 2);
});

test('invalidate makes the next get fetch again', async () => {
  let n = 0;
  const loader = createLoader(async () => `v${++n}`);
  assert.equal(await loader.get('a'), 'v1');
  loader.invalidate('a');
  assert.equal(await loader.get('a'), 'v2');
  assert.equal(loader.stats().fetches, 2);
});

test('refresh while a load is in flight: the refreshed value wins', async () => {
  const { fetchFn, pending } = controlled();
  const loader = createLoader(fetchFn);
  const first = loader.get('a');
  await tick();
  const second = loader.refresh('a');
  await tick();
  assert.equal(pending.length, 2, 'refresh starts its own fetch');

  pending[1].resolve('v2');
  assert.equal(await second, 'v2');
  pending[0].resolve('v1');
  assert.equal(await first, 'v1');

  assert.equal(await loader.get('a'), 'v2', 'the stale first result must not replace the refreshed value');
  assert.equal(loader.stats().fetches, 2);
});

test('rejects when fetchFn is not a function', () => {
  assert.throws(() => createLoader(null), TypeError);
});
