/** A tiny in-memory table. Rows keep the order they were inserted in. */
export function createStore() {
  const rows = [];
  let seq = 0;
  return {
    insert(row) {
      if (row.id === undefined) throw new Error('row needs an id');
      rows.push({ ...row, _seq: seq++ });
    },
    all() {
      return rows.slice();
    },
    size() {
      return rows.length;
    },
  };
}
