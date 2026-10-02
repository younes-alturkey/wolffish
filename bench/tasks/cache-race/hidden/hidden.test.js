import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoader } from '../src/loader.js';

const tick = () => new Promise((r) => setImmediate(r));
const unhandled = [];
process.on('unhandledRejection', (err) => unhandled.push(err));

function controlled() {
  const pending = [];
  const fetchFn = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  return { fetchFn, pending };
}

test('a rejected fetch is not cached: the next get tries again and succeeds', async () => {
  let n = 0;
  const loader = createLoader(async () => {
    n += 1;
    if (n === 1) throw new Error('upstream flake');
    return 'ok';
  });
  await assert.rejects(loader.get('a'), /upstream flake/);
  assert.equal(await loader.get('a'), 'ok');
  assert.equal(await loader.get('a'), 'ok');
  assert.equal(loader.stats().fetches, 2);
});

test('concurrent callers all see the rejection, then a later call recovers', async () => {
  const { fetchFn, pending } = controlled();
  const loader = createLoader(fetchFn);
  const p1 = loader.get('k');
  const p2 = loader.get('k');
  await tick();
  pending[0].reject(new Error('down'));
  await assert.rejects(p1, /down/);
  await assert.rejects(p2, /down/);
  const p3 = loader.get('k');
  await tick();
  assert.equal(pending.length, 2, 'a fresh fetch must start after the rejection');
  pending[1].resolve('up');
  assert.equal(await p3, 'up');
});

test('a load that started before invalidate() does not repopulate the cache', async () => {
  const { fetchFn, pending } = controlled();
  const loader = createLoader(fetchFn);
  const first = loader.get('a');
  await tick();
  loader.invalidate('a');
  pending[0].resolve('stale');
  assert.equal(await first, 'stale', 'the original caller still gets what it asked for');
  const again = loader.get('a');
  await tick();
  assert.equal(pending.length, 2, 'the value fetched before invalidate must not be served');
  pending[1].resolve('fresh');
  assert.equal(await again, 'fresh');
  assert.equal(await loader.get('a'), 'fresh');
});

test('no unhandled rejections leaked from the loader', async () => {
  await tick();
  await tick();
  assert.deepEqual(unhandled, []);
});
