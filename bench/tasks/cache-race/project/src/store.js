/**
 * Values keyed by string, with a per-key generation counter that advances on
 * every invalidation. Writers pass the generation they observed when their
 * work started, so a result computed against an old generation is dropped.
 */
export class Store {
  #values = new Map();
  #gens = new Map();

  get(key) {
    return this.#values.get(key);
  }

  generation(key) {
    return this.#gens.get(key) ?? 0;
  }

  invalidate(key) {
    this.#values.delete(key);
    this.#gens.set(key, this.generation(key) + 1);
  }

  /** Returns true when the value was written, false when it was dropped as stale. */
  set(key, value, gen = this.generation(key)) {
    if (gen > this.generation(key)) return false;
    this.#values.set(key, value);
    return true;
  }
}
