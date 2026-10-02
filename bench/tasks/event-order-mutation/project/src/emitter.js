export class Emitter {
  #listeners = new Map();

  on(name, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    if (!this.#listeners.has(name)) this.#listeners.set(name, []);
    this.#listeners.get(name).push(fn);
    return () => this.off(name, fn);
  }

  once(name, fn) {
    const off = this.on(name, (...args) => {
      off();
      fn(...args);
    });
    return off;
  }

  off(name, fn) {
    const list = this.#listeners.get(name);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  }

  count(name) {
    return this.#listeners.get(name)?.length ?? 0;
  }

  emit(name, ...args) {
    const list = this.#listeners.get(name);
    if (!list) return 0;
    let called = 0;
    for (let i = 0; i < list.length; i++) {
      list[i](...args);
      called += 1;
    }
    return called;
  }
}
