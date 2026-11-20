import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopIdeaRotation } from '../desktop_idea_rotation.mjs';

test('resurfaces one stable fridge idea for a workday', async () => {
  const items = [
    { id: 'b', status: 'fridge' },
    { id: 'a', status: 'fridge' },
    { id: 'done', status: 'done' },
  ];
  let now = new Date('2026-11-14T10:00:00');
  const rotation = createDesktopIdeaRotation({ listIdeas: async () => items }, { now: () => now });
  const first = await rotation.getTodayResurfacing();
  const second = await rotation.getTodayResurfacing();
  assert.equal(first.workDate, '2026-11-14');
  assert.equal(first.item.id, second.item.id);
  assert.ok(['a', 'b'].includes(first.item.id));
  now = new Date('2026-11-15T10:00:00');
  assert.equal((await rotation.getTodayResurfacing()).workDate, '2026-11-15');
});

test('returns an empty resurfacing slot when the fridge is empty', async () => {
  const rotation = createDesktopIdeaRotation({ listIdeas: async () => [] }, { now: () => new Date('2026-11-14T10:00:00') });
  assert.deepEqual(await rotation.getTodayResurfacing(), { workDate: '2026-11-14', item: null });
});
