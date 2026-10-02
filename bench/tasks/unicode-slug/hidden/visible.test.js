import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, uniqueSlugs, truncate, truncateWords, charLength } from '../src/index.js';

test('ascii titles', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  Release  notes: v2.1 (final) '), 'release-notes-v21-final');
});

test('custom separator and trailing separators are trimmed', () => {
  assert.equal(slugify('Foo Bar Baz', { separator: '_' }), 'foo_bar_baz');
  assert.equal(slugify('Foo Bar Baz', { maxLength: 7 }), 'foo-bar');
});

test('non-latin letters are kept', () => {
  assert.equal(slugify('Ünïcödé Straße'), 'ünïcödé-straße');
  assert.equal(slugify('日本語 タイトル'), '日本語-タイトル');
});

test('emoji are kept and never cut in half', () => {
  assert.equal(slugify('Hello 🌍 World', { maxLength: 7 }), 'hello-🌍');
  assert.equal(slugify('I 🚀 Node', { maxLength: 3 }), 'i-🚀');
});

test('accents written as combining marks survive', () => {
  // "Crème Brûlée" with each accent as a separate combining mark (U+0300 grave, U+0302 circumflex, U+0301 acute).
  const decomposed = 'Crème Brûlée';
  assert.equal(slugify(decomposed), 'crème-brûlée');
});

test('symbols become words and repeated titles get numbered', () => {
  assert.equal(slugify('Tom & Jerry @ 100%'), 'tom-and-jerry-at-100-percent');
  assert.deepEqual(uniqueSlugs(['Hello', 'hello!', 'Hello']), ['hello', 'hello-2', 'hello-3']);
});

test('truncateWords cuts at a word boundary', () => {
  assert.equal(truncateWords('alpha-beta-gamma', 12), 'alpha-beta');
  assert.equal(truncateWords('alphabetagamma', 5), 'alpha');
});

test('truncate and charLength on plain text', () => {
  assert.equal(truncate('abcdef', 3), 'abc');
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(charLength('abc'), 3);
  assert.throws(() => truncate('abc', -1), RangeError);
});
