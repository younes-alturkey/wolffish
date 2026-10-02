// Runs under TZ=America/New_York (set by verify.sh): a zone with DST and a
// negative offset. 2024-03-10 is the spring-forward day (23h); 2024-11-03 the
// fall-back day (25h).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey } from '../src/keys.js';
import { dayRange, daysBetween } from '../src/range.js';
import { rollup } from '../src/rollup.js';

test('verify.sh pinned the zone', () => {
  assert.equal(process.env.TZ, 'America/New_York');
  assert.equal(new Date('2024-03-10T12:00:00Z').getTimezoneOffset(), 240);
});

test('UTC day keys do not follow the local clock', () => {
  assert.equal(dayKey('2024-03-11T03:30:00Z'), '2024-03-11'); // 23:30 on Mar 10 in New York
  assert.equal(dayKey('2024-03-10T23:59:00Z'), '2024-03-10');
  assert.equal(dayKey('2024-11-04T04:30:00Z'), '2024-11-04'); // 23:30 on Nov 3 in New York
});

test('the range spanning the spring-forward day has every day', () => {
  assert.equal(daysBetween('2024-03-09', '2024-03-11'), 2);
  assert.deepEqual(dayRange('2024-03-09', '2024-03-11'), ['2024-03-09', '2024-03-10', '2024-03-11']);
  assert.deepEqual(dayRange('2024-03-10', '2024-03-11'), ['2024-03-10', '2024-03-11']);
});

test('the range spanning the fall-back day has every day exactly once', () => {
  assert.equal(daysBetween('2024-11-02', '2024-11-04'), 2);
  assert.deepEqual(dayRange('2024-11-02', '2024-11-04'), ['2024-11-02', '2024-11-03', '2024-11-04']);
});

test('a week of one event per UTC day across the DST change rolls up 1 per day', () => {
  const days = ['2024-03-08', '2024-03-09', '2024-03-10', '2024-03-11', '2024-03-12'];
  const events = days.map((d) => ({ at: `${d}T02:30:00Z`, amount: 1 }));
  assert.deepEqual(
    rollup(events, '2024-03-08', '2024-03-12'),
    days.map((day) => ({ day, count: 1, total: 1 })),
  );
});
