import { parseKey } from './keys.js';

const DAY_MS = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');

function startOfDay(key) {
  const { y, m, d } = parseKey(key);
  return new Date(y, m - 1, d);
}

function format(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Number of whole days from `fromKey` to `toKey` (0 when equal). */
export function daysBetween(fromKey, toKey) {
  return Math.floor((startOfDay(toKey) - startOfDay(fromKey)) / DAY_MS);
}

/** Every day key from `fromKey` to `toKey`, inclusive, in order. */
export function dayRange(fromKey, toKey) {
  const n = daysBetween(fromKey, toKey);
  if (n < 0) throw new Error(`range is backwards: ${fromKey} > ${toKey}`);
  const first = startOfDay(fromKey);
  const keys = [];
  for (let i = 0; i <= n; i++) {
    const day = new Date(first);
    day.setDate(first.getDate() + i);
    keys.push(format(day));
  }
  return keys;
}
