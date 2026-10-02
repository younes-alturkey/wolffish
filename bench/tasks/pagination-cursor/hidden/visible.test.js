import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { listPage, collectAll } from '../src/paginate.js';
import { encodeCursor, decodeCursor } from '../src/cursor.js';

function seed(rows) {
  const store = createStore();
  for (const r of rows) store.insert(r);
  return store.all();
}

test('first page without a cursor is sorted ascending', () => {
  const rows = seed([
    { id: 'r1', score: 30 },
    { id: 'r2', score: 10 },
    { id: 'r3', score: 20 },
  ]);
  const page = listPage(rows, { sortBy: 'score', limit: 10 });
  assert.deepEqual(page.items.map((r) => r.id), ['r2', 'r3', 'r1']);
  assert.equal(page.nextCursor, null);
});

test('descending order with distinct scores pages cleanly', () => {
  const rows = seed([
    { id: 'r1', score: 1 },
    { id: 'r2', score: 2 },
    { id: 'r3', score: 3 },
    { id: 'r4', score: 4 },
    { id: 'r5', score: 5 },
  ]);
  assert.deepEqual(collectAll(rows, { sortBy: 'score', dir: 'desc', limit: 2 }), ['r5', 'r4', 'r3', 'r2', 'r1']);
});

test('a cursor round-trips through encode/decode', () => {
  const cursor = encodeCursor({ sortKey: 20, id: 'r2' });
  assert.deepEqual(decodeCursor(cursor), { sortKey: 20, id: 'r2' });
});

test('rows sharing a score are neither skipped nor repeated across pages', () => {
  const rows = seed([
    { id: 'r1', score: 10 },
    { id: 'r2', score: 20 },
    { id: 'r3', score: 20 },
    { id: 'r4', score: 20 },
    { id: 'r5', score: 30 },
  ]);
  const page1 = listPage(rows, { sortBy: 'score', limit: 2 });
  assert.deepEqual(page1.items.map((r) => r.id), ['r1', 'r2']);
  const page2 = listPage(rows, { sortBy: 'score', limit: 2, cursor: page1.nextCursor });
  assert.deepEqual(page2.items.map((r) => r.id), ['r3', 'r4']);
  assert.deepEqual(collectAll(rows, { sortBy: 'score', limit: 2 }), ['r1', 'r2', 'r3', 'r4', 'r5']);
});

test('malformed cursors are rejected', () => {
  assert.throws(() => listPage(seed([{ id: 'a', score: 1 }]), { sortBy: 'score', cursor: '%%%' }), /malformed/);
});

test('the last page has no next cursor', () => {
  const rows = seed([
    { id: 'a', score: 1 },
    { id: 'b', score: 2 },
    { id: 'c', score: 3 },
  ]);
  const p1 = listPage(rows, { sortBy: 'score', limit: 2 });
  const p2 = listPage(rows, { sortBy: 'score', limit: 2, cursor: p1.nextCursor });
  assert.deepEqual(p2.items.map((r) => r.id), ['c']);
  assert.equal(p2.nextCursor, null);
});
