import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, truncate, charLength } from '../src/index.js';

const wellFormed = (s) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s);

test('NFC and NFD inputs produce the same slug, also when truncated', () => {
  const nfc = 'Crème Brûlée à la Mode'.normalize('NFC');
  const nfd = nfc.normalize('NFD');
  assert.notEqual(nfc, nfd, 'test setup: the two forms must differ');
  assert.equal(slugify(nfd), slugify(nfc));
  assert.equal(slugify(nfc), 'crème-brûlée-à-la-mode');
  for (const max of [3, 5, 6, 11, 12]) {
    assert.equal(slugify(nfd, { maxLength: max }), slugify(nfc, { maxLength: max }), `maxLength=${max}`);
  }
  assert.equal(slugify(nfd, { maxLength: 5 }), 'crème');
  assert.equal(slugify(nfd, { maxLength: 5 }).normalize('NFC'), slugify(nfd, { maxLength: 5 }), 'output is NFC');
});

test('a 4-byte emoji exactly at the cut boundary', () => {
  const s = 'aaaaa🚀bbbbb';
  assert.equal(slugify(s, { maxLength: 6 }), 'aaaaa🚀');
  assert.equal(slugify(s, { maxLength: 5 }), 'aaaaa');
  assert.equal(slugify(s, { maxLength: 7 }), 'aaaaa🚀b');
  assert.equal(truncate(s, 6), 'aaaaa🚀');
  assert.equal(truncate(s, 5), 'aaaaa');
  assert.equal(truncate('🚀🚀🚀', 2), '🚀🚀');
  for (let max = 0; max <= 11; max++) {
    assert.ok(wellFormed(truncate(s, max)), `truncate(.., ${max}) left a lone surrogate`);
    assert.ok(wellFormed(slugify(s, { maxLength: max })), `slugify(.., ${max}) left a lone surrogate`);
  }
});

test('charLength counts characters, not UTF-16 units', () => {
  assert.equal(charLength('🚀🚀'), 2);
  assert.equal(charLength('a🚀b'), 3);
  assert.equal(charLength('日本語'), 3);
});
