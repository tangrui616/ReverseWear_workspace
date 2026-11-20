import test from 'node:test';
import assert from 'node:assert/strict';
import { getWorkDate, setDayStartMinutes } from '../dist/date-boundary.mjs';

test('work date follows the selected local day boundary across month edges', () => {
  setDayStartMinutes(240);
  assert.equal(getWorkDate(new Date(2026, 10, 14, 1, 0)), '2026-11-13');
  assert.equal(getWorkDate(new Date(2026, 10, 14, 4, 0)), '2026-11-14');
  assert.equal(getWorkDate(new Date(2026, 2, 1, 1, 0)), '2026-02-28');
});

test('day boundary is clamped and invalid values reset to local midnight', () => {
  setDayStartMinutes(2400);
  assert.equal(getWorkDate(new Date(2026, 10, 14, 23, 59)), '2026-11-14');
  setDayStartMinutes(Number.NaN);
  assert.equal(getWorkDate(new Date(2026, 10, 14, 1, 0)), '2026-11-14');
});
