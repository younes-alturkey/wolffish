import { charLength } from './length.js';

/** `text` shortened to at most `max` characters. */
export function truncate(text, max) {
  if (!Number.isInteger(max) || max < 0) throw new RangeError('max must be a non-negative integer');
  const s = String(text);
  if (charLength(s) <= max) return s;
  return s.slice(0, max);
}

/**
 * Like `truncate`, but prefers to cut at the last `separator` before the limit
 * so words stay whole. Falls back to a hard cut when there is no separator.
 */
export function truncateWords(text, max, separator = '-') {
  const s = String(text);
  if (charLength(s) <= max) return s;
  const hard = truncate(s, max);
  const at = hard.lastIndexOf(separator);
  return at > 0 ? hard.slice(0, at) : hard;
}
