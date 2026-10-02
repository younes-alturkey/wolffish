const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export const reducers = {
  add(state, event) {
    if (state.items.some((it) => it.id === event.id)) throw new Error(`duplicate id ${event.id}`);
    return { ...state, items: [...state.items, { id: event.id, name: event.name }] };
  },

  remove(state, event) {
    return { ...state, items: state.items.filter((it) => it.id !== event.id) };
  },

  rename(state, event) {
    return {
      ...state,
      items: state.items.map((it) => (it.id === event.id ? { ...it, name: event.name } : it)),
    };
  },

  sort(state) {
    return { ...state, items: state.items.sort(byName) };
  },
};

export function reduce(state, event) {
  const fn = reducers[event.type];
  if (!fn) throw new Error(`unknown event type: ${event.type}`);
  return fn(state, event);
}
