import assert from 'node:assert/strict';
import test from 'node:test';
import { timeLabel } from '../src/format.ts';

test('recent timestamps use relative time and older ones show a date', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  assert.equal(timeLabel('2026-11-05T11:59:50Z', now), 'Just now');
  assert.equal(timeLabel('2026-11-05T11:40:00Z', now), '20m ago');
  assert.equal(timeLabel('2026-11-05T02:00:00Z', now), '10h ago');
  assert.equal(timeLabel('2026-11-04T12:00:00Z', now), '4 Nov 2026');
  assert.equal(timeLabel('2026-11-05T12:00:30Z', now), 'Just now');
});
