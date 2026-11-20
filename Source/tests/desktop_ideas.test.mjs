import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDesktopIdeas } from '../desktop_ideas.mjs';

async function withStore(run, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reversewear-ideas-'));
  const store = createDesktopIdeas(root, options);
  try { await run(store, root); }
  finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

test('capture appends readable exact text and returns the same item for a repeated capture id', async () => {
  await withStore(async (store, root) => {
    const input = { text: '第一行\n第二行  保留空格', source: 'https://example.com/article#part', captureId: '12345678-1234-1234-1234-123456789abc' };
    const first = await store.appendCapture(input);
    const again = await store.appendCapture(input);
    assert.equal(first.duplicate, false);
    assert.equal(again.duplicate, true);
    assert.equal(again.item.text, input.text);
    assert.equal(first.item.source, 'https://example.com/article#part');
    const saved = await readFile(path.join(root, 'Documents', 'Inbox', `${first.item.date}.md`), 'utf8');
    assert.match(saved, /> 第一行\n> 第二行  保留空格/);
    assert.equal((await store.listCaptures()).length, 1);
  });
});

test('emotion ideas default private and retain their source and immutable original when edited', async () => {
  await withStore(async (store, root) => {
    const capture = await store.appendCapture({ text: '收件箱中的原话。', source: 'https://example.com/source', captureId: '22345678-1234-1234-1234-123456789abc' });
    const captureDate = capture.item.date;
    const created = await store.createIdea({
      original: '渲染器篡改的原话', area: 'emotion', title: '想法',
      source: { type: 'pdf', fileId: '12345678-1234-1234-1234-123456789abc', page: 4, quote: '不可信来源' },
      tags: ['研究', '记录'], followup: '后续补充', captureId: capture.item.id, captureDate,
    });
    assert.equal(created.item.private, true);
    assert.equal(created.item.original, '收件箱中的原话。');
    assert.deepEqual(created.item.source, { type: 'link', linkId: null, url: 'https://example.com/source', title: '' });
    const inbox = await readFile(path.join(root, 'Documents', 'Inbox', `${captureDate}.md`), 'utf8');
    assert.match(inbox, /private: true/);
    assert.match(inbox, /schema: 1/);
    assert.match(inbox, /id: "/);
    const updated = await store.saveIdea({ ...created.item, title: '修订标题', original: '篡改原话', followup: '新补充', expectedUpdatedAt: created.item.updatedAt });
    assert.equal(updated.original, '收件箱中的原话。');
    assert.equal(updated.followup, '新补充');
    assert.equal(updated.source.url, 'https://example.com/source');
    assert.equal(updated.private, true);
    const repeated = await store.createIdea({ captureId: created.item.captureId, original: '重复创建' });
    assert.equal(repeated.duplicate, true);
    assert.equal(repeated.item.id, created.item.id);
  });
});

test('preserves existing AI block on local edits and rejects stale saves', async () => {
  await withStore(async (store, root) => {
    const created = await store.createIdea({ original: '原话 <!-- ai:begin --> 注入 <!-- ai:end -->', title: '原题' });
    const actualFile = path.join(root, 'Documents', 'Ideas', `${created.item.id}.md`);
    let markdown = await readFile(actualFile, 'utf8');
    markdown = markdown.replace('<!-- ai:begin -->\n## AI 整理\n<!-- ai:end -->', '<!-- ai:begin -->\n## AI 整理\n建议保留来源背景。\n<!-- ai:end -->');
    await (await import('node:fs/promises')).writeFile(actualFile, markdown, 'utf8');
    const current = (await store.listIdeas())[0];
    assert.match(current.aiBlock, /建议保留来源背景/);
    assert.equal(current.original, '原话 <!-- ai:begin --> 注入 <!-- ai:end -->');
    const saved = await store.saveIdea({ ...current, title: '本地改题', expectedUpdatedAt: current.updatedAt });
    assert.match(saved.aiBlock, /建议保留来源背景/);
    await assert.rejects(store.saveIdea({ ...current, title: '过期编辑', expectedUpdatedAt: current.updatedAt }), /其他位置更新|其他程序修改/);
  });
});

test('rejects inbox hardlinks and preserves existing content on failed append', async () => {
  await withStore(async (store, root) => {
    const date = '2026-11-14';
    const directory = path.join(root, 'Documents', 'Inbox');
    await mkdir(directory, { recursive: true });
    const outside = path.join(root, 'outside.md');
    const inboxPath = path.join(directory, `${date}.md`);
    await writeFile(outside, '原始文件内容');
    await link(outside, inboxPath);
    await assert.rejects(store.appendCapture({ text: '不应写入' }), /收件箱文件路径异常/);
    assert.equal(await readFile(outside, 'utf8'), '原始文件内容');
  }, { now: () => new Date(2026, 10, 14, 12, 0, 0) });
});

test('defaults to unclassified and imports legacy body-only idea sections', async () => {
  await withStore(async (store, root) => {
    const created = await store.createIdea({ original: '没分类的原话' });
    assert.equal(created.item.area, 'unclassified');
    const id = created.item.id;
    const legacy = path.join(root, 'Documents', 'Ideas', `${id}.md`);
    await writeFile(legacy, `---\nid: "${id}"\ntype: "idea"\n---\n\n# 历史卡片\n\n## 原话\n保留旧版原话\n\n## 我的后续想法\n保留旧版补充\n\n<!-- ai:begin -->\n旧版 AI 内容\n<!-- ai:end -->\n`, 'utf8');
    const [item] = await store.listIdeas();
    assert.equal(item.original, '保留旧版原话');
    assert.equal(item.followup, '保留旧版补充');
    await store.saveIdea({ ...item, title: '升级后的卡片' });
    const saved = await readFile(legacy, 'utf8');
    assert.match(saved, /保留旧版原话/);
    assert.match(saved, /保留旧版补充/);
  });
});

test('uses configured work-day boundary for inbox file dates', async () => {
  await withStore(async (store, root) => {
    await store.appendCapture({ text: '凌晨记录' });
    const files = await (await import('node:fs/promises')).readdir(path.join(root, 'Documents', 'Inbox'));
    assert.deepEqual(files, ['2026-11-13.md']);
    assert.equal((await store.listCaptures({ date: '2026-11-13' })).length, 1);
  }, { getDayStartMinutes: () => 240, now: () => new Date(2026, 10, 14, 1, 0, 0) });
});
