import { Store } from './store.js';
import { Inflight } from './inflight.js';

export function createLoader(fetchFn) {
  if (typeof fetchFn !== 'function') throw new TypeError('fetchFn must be a function');
  const store = new Store();
  const inflight = new Inflight();
  let fetches = 0;

  function get(key) {
    const hit = store.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const gen = store.generation(key);
    return inflight.run(key, async () => {
      fetches += 1;
      const value = await fetchFn(key);
      store.set(key, value, gen);
      return value;
    });
  }

  function invalidate(key) {
    store.invalidate(key);
  }

  function refresh(key) {
    store.invalidate(key);
    inflight.drop(key);
    return get(key);
  }

  return { get, invalidate, refresh, stats: () => ({ fetches }) };
}
