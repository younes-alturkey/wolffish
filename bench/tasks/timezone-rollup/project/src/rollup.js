import { dayKey } from './keys.js';
import { dayRange } from './range.js';

/**
 * One bucket per day in [fromKey, toKey]; events outside the range are ignored.
 * Each bucket: { day, count, total }.
 */
export function rollup(events, fromKey, toKey) {
  const buckets = new Map();
  for (const day of dayRange(fromKey, toKey)) buckets.set(day, { day, count: 0, total: 0 });
  for (const ev of events) {
    const bucket = buckets.get(dayKey(ev.at));
    if (!bucket) continue;
    bucket.count += 1;
    bucket.total += Number(ev.amount) || 0;
  }
  return [...buckets.values()];
}
