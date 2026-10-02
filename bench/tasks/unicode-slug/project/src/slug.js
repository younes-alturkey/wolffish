import { truncate } from './truncate.js';
import { charLength } from './length.js';

// Everything that is not a letter, digit, pictograph, whitespace or dash goes.
const DROP = /[^\p{L}\p{N}\p{Extended_Pictographic}\s-]/gu;

// A few symbols read better as words than as nothing at all.
const SYMBOL_WORDS = { '&': 'and', '@': 'at', '+': 'plus', '%': 'percent' };

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function slugify(text, { maxLength = 40, separator = '-' } = {}) {
  let s = String(text).toLowerCase();
  s = s.replace(/[&@+%]/g, (m) => ` ${SYMBOL_WORDS[m]} `);
  s = s.replace(DROP, '');
  s = s.trim().replace(/[\s-]+/gu, separator);
  s = truncate(s, maxLength);
  const trailing = new RegExp(`(?:${escapeRe(separator)})+$`, 'u');
  return s.replace(trailing, '');
}

/**
 * Slugs for a list of titles, made unique by appending `-2`, `-3`, ... to
 * repeats. The suffix counts against `maxLength`, so a long title is shortened
 * to make room rather than overflowing.
 */
export function uniqueSlugs(titles, options = {}) {
  const { maxLength = 40, separator = '-' } = options;
  const seen = new Map();
  return titles.map((title) => {
    const base = slugify(title, { maxLength, separator });
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    if (n === 1) return base;
    const suffix = `${separator}${n}`;
    const room = maxLength - charLength(suffix);
    return `${slugify(base, { maxLength: room, separator })}${suffix}`;
  });
}
