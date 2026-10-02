import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, replay } from '../src/store.js';

const names = (state) => state.items.map((it) => it.name);

test('add, rename and remove', () => {
  const store = createStore();
  store.dispatch({ type: 'add', id: 1, name: 'pear' });
  store.dispatch({ type: 'add', id: 2, name: 'apple' });
  store.dispatch({ type: 'rename', id: 1, name: 'plum' });
  assert.deepEqual(names(store.getState()), ['plum', 'apple']);
  store.dispatch({ type: 'remove', id: 2 });
  assert.deepEqual(names(store.getState()), ['plum']);
  assert.throws(() => store.dispatch({ type: 'add', id: 1, name: 'dup' }), /duplicate/);
  assert.throws(() => store.dispatch({ type: 'explode' }), /unknown event type/);
});

test('change listeners get the event with prev and next', () => {
  const store = createStore();
  const seen = [];
  store.on('change', ({ event, prev, next }) => seen.push([event.type, prev.items.length, next.items.length]));
  store.dispatch({ type: 'add', id: 1, name: 'a' });
  store.dispatch({ type: 'add', id: 2, name: 'b' });
  assert.deepEqual(seen, [['add', 0, 1], ['add', 1, 2]]);
});

test('unsubscribing stops further notifications', () => {
  const store = createStore();
  let calls = 0;
  const off = store.on('change', () => calls++);
  store.dispatch({ type: 'add', id: 1, name: 'a' });
  off();
  store.dispatch({ type: 'add', id: 2, name: 'b' });
  assert.equal(calls, 1);
  assert.equal(store.listenerCount('change'), 0);
});

test('a once listener does not starve the listener registered after it', () => {
  const store = createStore();
  const log = [];
  store.once('change', () => log.push('first'));
  store.on('change', () => log.push('second'));
  store.dispatch({ type: 'add', id: 1, name: 'a' });
  assert.deepEqual(log, ['first', 'second']);
  store.dispatch({ type: 'add', id: 2, name: 'b' });
  assert.deepEqual(log, ['first', 'second', 'second']);
});

test('after a sort event the prev snapshot still has the old order', () => {
  const store = createStore();
  store.dispatch({ type: 'add', id: 1, name: 'pear' });
  store.dispatch({ type: 'add', id: 2, name: 'apple' });
  store.dispatch({ type: 'add', id: 3, name: 'fig' });
  let snapshot;
  store.on('change', ({ prev, next }) => (snapshot = { prev: names(prev), next: names(next) }));
  store.dispatch({ type: 'sort' });
  assert.deepEqual(snapshot.next, ['apple', 'fig', 'pear']);
  assert.deepEqual(snapshot.prev, ['pear', 'apple', 'fig']);
});

test('replay folds events into a state', () => {
  const events = [
    { type: 'add', id: 1, name: 'b' },
    { type: 'add', id: 2, name: 'a' },
    { type: 'sort' },
    { type: 'remove', id: 1 },
  ];
  assert.deepEqual(names(replay(events)), ['a']);
});
