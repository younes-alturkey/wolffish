import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, replay } from '../src/store.js';
import { Emitter } from '../src/emitter.js';

const names = (state) => state.items.map((it) => it.name);

test('a listener that removes itself (via off) does not skip the next listener', () => {
  const em = new Emitter();
  const log = [];
  const offA = em.on('x', () => { log.push('a'); offA(); });
  em.on('x', () => log.push('b'));
  em.on('x', () => log.push('c'));
  assert.equal(em.emit('x'), 3);
  assert.deepEqual(log, ['a', 'b', 'c']);
  em.emit('x');
  assert.deepEqual(log, ['a', 'b', 'c', 'b', 'c']);
});

test('a listener that removes a different, earlier listener does not shift the rest', () => {
  const em = new Emitter();
  const log = [];
  const a = () => log.push('a');
  em.on('x', a);
  em.on('x', () => { log.push('b'); em.off('x', a); });
  em.on('x', () => log.push('c'));
  em.on('x', () => log.push('d'));
  em.emit('x');
  assert.deepEqual(log, ['a', 'b', 'c', 'd']);
  assert.equal(em.count('x'), 3);
});

test('two once listeners in a row both fire, then are gone', () => {
  const store = createStore();
  const log = [];
  store.once('change', () => log.push(1));
  store.once('change', () => log.push(2));
  store.on('change', () => log.push(3));
  store.dispatch({ type: 'add', id: 1, name: 'a' });
  assert.deepEqual(log, [1, 2, 3]);
  assert.equal(store.listenerCount('change'), 1);
});

test('replay leaves its inputs untouched and is repeatable', () => {
  const initial = { items: [{ id: 1, name: 'pear' }, { id: 2, name: 'apple' }] };
  const events = [{ type: 'sort' }, { type: 'rename', id: 2, name: 'apricot' }, { type: 'remove', id: 1 }];
  const initialClone = structuredClone(initial);
  const eventsClone = structuredClone(events);
  const first = replay(events, initial);
  assert.deepEqual(initial, initialClone, 'initial state was mutated');
  assert.deepEqual(events, eventsClone, 'events were mutated');
  assert.deepEqual(names(first), ['apricot']);
  assert.deepEqual(names(replay(events, initial)), ['apricot']);
  assert.deepEqual(initial, initialClone);
});

test('a state held by a caller is unaffected by later dispatches', () => {
  const store = createStore({ items: [{ id: 1, name: 'b' }, { id: 2, name: 'a' }] });
  const held = store.getState();
  const heldNames = names(held);
  store.dispatch({ type: 'sort' });
  store.dispatch({ type: 'rename', id: 1, name: 'z' });
  assert.deepEqual(names(held), heldNames);
  assert.deepEqual(names(store.getState()), ['a', 'z']);
});
