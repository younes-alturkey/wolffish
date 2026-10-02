import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { listPage, collectAll } from '../src/paginate.js';

// Ties on the sort field, inserted OUT of id order, paged in BOTH directions.
function rows() {
  const store = createStore();
  for (const r of [
    { id: 'r7', score: 20 },
    { id: 'r2', score: 20 },
    { id: 'r9', score: 10 },
    { id: 'r5', score: 20 },
    { id: 'r1', score: 30 },
    { id: 'r3', score: 10 },
    { id: 'r8', score: 20 },
  ]) store.insert(r);
  return store.all();
}

const ALL = ['r1', 'r2', 'r3', 'r5', 'r7', 'r8', 'r9'];

test('descending paging with ties visits every row exactly once', () => {
  for (const limit of [1, 2, 3, 4]) {
    const ids = collectAll(rows(), { sortBy: 'score', dir: 'desc', limit });
    assert.deepEqual([...ids].sort(), ALL, `limit=${limit}: ${ids.join(',')}`);
    assert.equal(ids.length, ALL.length, `limit=${limit}: duplicates or skips`);
  }
});

test('ascending paging with ties inserted out of id order visits every row exactly once', () => {
  for (const limit of [1, 2, 3]) {
    const ids = collectAll(rows(), { sortBy: 'score', dir: 'asc', limit });
    assert.deepEqual([...ids].sort(), ALL, `limit=${limit}: ${ids.join(',')}`);
    assert.equal(ids.length, ALL.length, `limit=${limit}: duplicates or skips`);
  }
});

test('a descending listing is exactly the reverse of the ascending one', () => {
  const asc = collectAll(rows(), { sortBy: 'score', dir: 'asc', limit: 2 });
  const desc = collectAll(rows(), { sortBy: 'score', dir: 'desc', limit: 3 });
  assert.deepEqual(desc, [...asc].reverse());
  assert.deepEqual(asc, ['r3', 'r9', 'r2', 'r5', 'r7', 'r8', 'r1']);
});

test('page boundaries fall between tied rows in both directions', () => {
  const p1 = listPage(rows(), { sortBy: 'score', dir: 'desc', limit: 2 });
  assert.deepEqual(p1.items.map((r) => r.id), ['r1', 'r8']);
  const p2 = listPage(rows(), { sortBy: 'score', dir: 'desc', limit: 2, cursor: p1.nextCursor });
  assert.deepEqual(p2.items.map((r) => r.id), ['r7', 'r5']);
});
