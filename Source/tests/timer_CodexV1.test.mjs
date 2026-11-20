import test from 'node:test';
import assert from 'node:assert/strict';
import { Countdown, formatTime } from '../dist/timer.mjs';
test('duration uses elapsed wall time, pauses, resumes and completes once', () => {
  let now = 10000; const timer = new Countdown({}, () => now); timer.setDuration(5000); timer.toggle(); now += 1250; timer.tick(); assert.equal(timer.remaining, 3750); timer.toggle(); now += 10000; timer.tick(); assert.equal(timer.remaining, 3750); timer.toggle(); now += 4000; assert.equal(timer.tick(), true); assert.equal(timer.tick(), false); assert.equal(timer.remaining, 0); timer.reset(); assert.equal(timer.remaining, 5000);
});
test('reload restores absolute end time including a sleeping tab', () => {
  let now = 1000; const timer = new Countdown({}, () => now); timer.setDuration(60000); timer.toggle(); now += 45000; const restored = new Countdown(timer.serialize(), () => now); assert.equal(restored.remaining, 15000); now += 20000; assert.equal(restored.tick(), true);
});
test('deadline remains fixed across pause and validates future input', () => {
  let now = 1000; const timer = new Countdown({}, () => now); timer.setDeadline(11000); now += 1000; timer.toggle(); now += 3000; timer.toggle(); assert.equal(timer.remaining, 6000); assert.equal(timer.endAt, 11000); assert.throws(() => timer.setDeadline(now)); assert.throws(() => timer.setDuration(-1));
});
test('formatting rounds up and retains hours', () => { assert.deepEqual(formatTime(1), ['00', '01']); assert.deepEqual(formatTime(3661000), ['01', '01', '01']); assert.deepEqual(formatTime(0), ['00', '00']); });
