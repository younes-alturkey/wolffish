// The suite pins a fixed zone so results do not depend on the machine it runs on.
process.env.TZ = 'Asia/Tokyo';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey } from '../src/keys.js';
import { dayRange, daysBetween } from '../src/range.js';
import { rollup } from '../src/rollup.js';

test('an instant in the middle of the day keys to that day', () => {
  assert.equal(dayKey('2024-05-01T12:00:00Z'), '2024-05-01');
  assert.equal(dayKey(new Date('2024-05-01T12:00:00Z')), '2024-05-01');
});

test('instants just before midnight stay on their own day', () => {
  assert.equal(dayKey('2024-05-01T23:30:00Z'), '2024-05-01');
  assert.equal(dayKey('2024-05-01T23:59:59.999Z'), '2024-05-01');
});

test('offsets are honoured: 09:30+09:00 is 00:30Z', () => {
  assert.equal(dayKey('2024-05-02T09:30:00+09:00'), '2024-05-02');
  assert.equal(dayKey('2024-05-02T02:30:00+09:00'), '2024-05-01');
});

test('dayRange enumerates inclusive days and daysBetween counts them', () => {
  assert.deepEqual(dayRange('2024-05-01', '2024-05-03'), ['2024-05-01', '2024-05-02', '2024-05-03']);
  assert.deepEqual(dayRange('2024-02-28', '2024-03-01'), ['2024-02-28', '2024-02-29', '2024-03-01']);
  assert.equal(daysBetween('2024-05-01', '2024-05-01'), 0);
  assert.throws(() => dayRange('2024-05-03', '2024-05-01'), /backwards/);
});

test('rollup buckets events by day, near midnight included', () => {
  const events = [
    { at: '2024-05-01T00:10:00Z', amount: 5 },
    { at: '2024-05-01T23:50:00Z', amount: 7 },
    { at: '2024-05-02T00:05:00Z', amount: 1 },
    { at: '2024-05-03T12:00:00Z', amount: 2 },
  ];
  assert.deepEqual(rollup(events, '2024-05-01', '2024-05-03'), [
    { day: '2024-05-01', count: 2, total: 12 },
    { day: '2024-05-02', count: 1, total: 1 },
    { day: '2024-05-03', count: 1, total: 2 },
  ]);
});

test('rollup keeps zero rows and ignores events outside the range', () => {
  const events = [
    { at: '2024-04-30T12:00:00Z', amount: 99 },
    { at: '2024-05-02T12:00:00Z', amount: 3 },
  ];
  assert.deepEqual(rollup(events, '2024-05-01', '2024-05-02'), [
    { day: '2024-05-01', count: 0, total: 0 },
    { day: '2024-05-02', count: 1, total: 3 },
  ]);
});
