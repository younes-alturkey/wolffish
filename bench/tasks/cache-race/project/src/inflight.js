/** Collapses concurrent work for the same key onto one promise. */
export class Inflight {
  #map = new Map();

  has(key) {
    return this.#map.has(key);
  }

  drop(key) {
    this.#map.delete(key);
  }

  run(key, factory) {
    const existing = this.#map.get(key);
    if (existing) return existing;
    const p = Promise.resolve().then(factory);
    this.#map.set(key, p);
    // Free the slot once the work is done. The no-op rejection handler keeps
    // this side chain from surfacing as an unhandled rejection.
    p.then(() => this.#map.delete(key), () => {});
    return p;
  }
}
