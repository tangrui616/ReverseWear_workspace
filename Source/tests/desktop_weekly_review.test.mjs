import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDesktopIdeas } from '../desktop_ideas.mjs';
import { createWeeklyReview } from '../desktop_weekly_review.mjs';

async function withReview(run, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reversewear-weekly-'));
  const ideas = createDesktopIdeas(root, options);
  const review = createWeeklyReview(root, { ideas, ...options });
  try { await run({ root, ideas, review }); }
  finally { ideas.close(); await rm(root, { recursive: true, force: true }); }
}

test('workweek boundaries use the configured local workday and ISO week', async () => {
  await withReview(async ({ review }) => {
    assert.equal(review.weekForDate('2026-01-01'), '2026-W01');
    assert.equal(review.weekForDate('2026-12-31'), '2026-W53');
    assert.throws(() => review.weekForDate('2026-02-30'), /日期无效/);
    const current = await review.listWeekIdeas({ week: '2026-W01' });
    assert.equal(current.start, '2025-12-29');
    assert.equal(current.end, '2026-01-04');
  });
});

test('weekly recap is persisted privately and stale or new competing writes are rejected', async () => {
  await withReview(async ({ root, review }) => {
    const week = '2026-W46';
    const first = await review.saveReview({ week, recap: { biggestWin: '推进实验', stuckPoint: '设备延迟', nextThree: ['整理数据', '复现实验', '写结论'], mood: '平稳' }, expectedUpdatedAt: null });
    assert.equal(first.recap.private, true);
    const file = path.join(root, 'Documents', 'WeeklyReviews', `${week}.md`);
    const markdown = await readFile(file, 'utf8');
    assert.match(markdown, /private: true/);
    assert.match(markdown, /## 本周最大的收获\n\n推进实验/);
    await assert.rejects(review.saveReview({ week, expectedUpdatedAt: null, recap: {} }), /其他位置修改/);
    const before = await review.getReview({ week });
    await writeFile(file, markdown.replace('推进实验', '外部更新'), 'utf8');
    const future = new Date(Date.now() + 5000);
    await utimes(file, future, future);
    await assert.rejects(review.saveReview({ week, expectedUpdatedAt: before.updatedAt, recap: {} }), /其他位置修改/);
    const external = await review.getReview({ week });
    assert.equal(external.recap.biggestWin, '外部更新');
    assert.deepEqual(external.recap.nextThree, ['整理数据', '复现实验', '写结论']);
  });
});

test('Harness draft template is created once and reading never alters returned content', async () => {
  await withReview(async ({ root, review }) => {
    const week = '2026-W46';
    const created = await review.writeDraftTemplate({ week });
    assert.equal(created.created, true);
    const first = await review.readDraft({ week });
    assert.equal(first.exists, true);
    assert.match(first.content, /本周新想法/);
    await assert.rejects(review.writeDraftTemplate({ week }), /未覆盖/);
    await mkdir(path.dirname(created.path), { recursive: true });
    await writeFile(created.path, '# Harness 返回稿\n可以继续编辑', 'utf8');
    const returned = await review.readDraft({ week });
    assert.match(returned.content, /Harness 返回稿/);
    assert.equal((await readFile(created.path, 'utf8')), returned.content);
    assert.equal(path.relative(root, created.path), path.join('AI-Mirror', 'Weekly-Review', `${week}.md`));
  });
});

test('weekly decisions keep archived ideas recoverable and preserve stable IDs', async () => {
  let clock = new Date('2026-11-12T10:00:00');
  await withReview(async ({ ideas, review }) => {
    const created = await ideas.createIdea({ title: '本周灵感', original: '保留正文' });
    clock = new Date('2026-11-12T10:00:05');
    const result = await review.decideIdeas({ week: '2026-W46', decisions: [{ id: created.item.id, decision: 'archived', expectedUpdatedAt: created.item.updatedAt }] });
    assert.equal(result.items[0].id, created.item.id);
    assert.equal(result.items[0].status, 'archived');
    assert.equal(result.items[0].original, '保留正文');
    assert.equal((await ideas.getIdea(created.item.id)).weeklyDecisions['2026-W46'], 'archived');
  }, { now: () => clock });
});
