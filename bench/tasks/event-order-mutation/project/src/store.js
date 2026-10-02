import { Emitter } from './emitter.js';
import { reduce } from './reducers.js';

export const EMPTY = Object.freeze({ items: Object.freeze([]) });

export function createStore(initial = EMPTY) {
  let state = initial;
  const emitter = new Emitter();
  return {
    getState: () => state,
    dispatch(event) {
      const prev = state;
      state = reduce(prev, event);
      emitter.emit('change', { event, prev, next: state });
      return state;
    },
    on: (name, fn) => emitter.on(name, fn),
    once: (name, fn) => emitter.once(name, fn),
    listenerCount: (name) => emitter.count(name),
  };
}

/** Fold `events` into `initial` without a store. */
export function replay(events, initial = EMPTY) {
  let state = initial;
  for (const event of events) state = reduce(state, event);
  return state;
}
