import { compareBy } from './sort.js';
import { decodeCursor, encodeCursor } from './cursor.js';

/**
 * One page of `rows`, sorted by `sortBy`/`dir`, starting strictly after the
 * position described by `cursor` (or from the top when there is no cursor).
 */
export function listPage(rows, { sortBy, dir = 'asc', limit = 10, cursor = null }) {
  if (!sortBy) throw new Error('sortBy is required');
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');

  const cmp = compareBy(sortBy, dir);
  const sorted = rows.slice().sort(cmp);

  let start = 0;
  if (cursor) {
    const { sortKey, id } = decodeCursor(cursor);
    const probe = { [sortBy]: sortKey, id };
    start = sorted.findIndex((row) => cmp(row, probe) > 0);
    if (start === -1) start = sorted.length;
  }

  const items = sorted.slice(start, start + limit);
  const hasMore = start + limit < sorted.length;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ sortKey: last[sortBy], id: last.id }) : null;
  return { items: items.map(({ _seq, ...row }) => row), nextCursor };
}

/** Convenience: walk every page and return the ids in order. */
export function collectAll(rows, opts) {
  const ids = [];
  let cursor = null;
  let guard = 0;
  do {
    const page = listPage(rows, { ...opts, cursor });
    ids.push(...page.items.map((r) => r.id));
    cursor = page.nextCursor;
    if (++guard > 1000) throw new Error('pagination did not terminate');
  } while (cursor);
  return ids;
}
