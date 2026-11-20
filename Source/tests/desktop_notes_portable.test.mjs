import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDesktopRecords, parseRecordMarkdown } from '../desktop_records.mjs';
import { createMarkdownIndex } from '../desktop_incremental_index.mjs';
import { createGlobalSearch } from '../desktop_global_search.mjs';
import { createWorkbenchStore } from '../workbench-store.mjs';

test('plain Notes markdown keeps its bytes until save and has a portable identity', async t => {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), 'reversewear-notes-portable-a-'));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), 'reversewear-notes-portable-b-'));
  t.after(() => Promise.all([rm(firstRoot, { recursive: true, force: true }), rm(secondRoot, { recursive: true, force: true })]));
  const relativeName = 'V22 更新说明.md';
  const source = '前言\n\n# V22 更新说明\n\n普通 UTF-8 Markdown 正文。\n';
  for (const root of [firstRoot, secondRoot]) {
    const notes = path.join(root, 'Documents', 'Notes');
    await mkdir(notes, { recursive: true });
    await writeFile(path.join(notes, relativeName), source, 'utf8');
    await writeFile(path.join(notes, '仅文件名.md'), '正文没有标题。', 'utf8');
    await writeFile(path.join(notes, '大写扩展名.MD'), '---\n\n普通正文。\n\n---\n\n~~~md\n# 围栏里的假标题\n~~~\n\nSetext 一级标题\n================\n', 'utf8');
    await writeFile(path.join(notes, '未知元数据.md'), '---\ncustomField: "保留值"\nsource: "外部 AI"\n---\n\n## 二级标题\n\n# 第一个一级标题\n', 'utf8');
    await writeFile(path.join(notes, 'CRLF 和 BOM.md'), '\uFEFF---\r\ncustomField: "BOM 与 CRLF"\r\n---\r\n\r\n# BOM 标题\r\n', 'utf8');
    await writeFile(path.join(notes, '.hidden.md'), '# hidden', 'utf8');
    await writeFile(path.join(notes, 'editor.tmp.md'), '# temporary', 'utf8');
  }
  const firstStore = createWorkbenchStore(firstRoot);
  const secondStore = createWorkbenchStore(secondRoot);
  const firstItems = await firstStore.listNotes({ kind: 'note' });
  const secondItems = await secondStore.listNotes({ kind: 'note' });
  const first = firstItems.find(item => item.name === relativeName);
  const second = secondItems.find(item => item.name === relativeName);
  assert.equal(firstItems.length, 5);
  assert.equal(first.title, 'V22 更新说明');
  assert.equal(first.externalMarkdown, true);
  assert.equal(first.relativePath, `Notes/${relativeName}`);
  assert.equal(first.id, second.id);
  assert.equal(firstItems.find(item => item.name === '仅文件名.md').title, '仅文件名');
  const thematic = firstItems.find(item => item.name === '大写扩展名.MD');
  assert.equal(thematic.title, 'Setext 一级标题');
  assert.equal(thematic.body, '---\n\n普通正文。\n\n---\n\n~~~md\n# 围栏里的假标题\n~~~\n\nSetext 一级标题\n================\n');
  assert.equal(parseRecordMarkdown(thematic.body, { ordinaryNotes: true }).body, thematic.body);
  const unknown = firstItems.find(item => item.name === '未知元数据.md');
  assert.equal(unknown.title, '第一个一级标题');
  assert.equal(unknown.metadata.customField, '保留值');
  assert.equal(await readFile(path.join(firstRoot, 'Documents', 'Notes', relativeName), 'utf8'), source);

  const edited = await firstStore.saveNote({ ...first, body: source + '工作台保存的补充。\n', expectedContentHash: first.contentHash });
  assert.equal(edited.id, first.id);
  assert.match(await readFile(path.join(firstRoot, 'Documents', 'Notes', relativeName), 'utf8'), /id: "/);
  await firstStore.saveNote({ ...unknown, body: unknown.body + '\n已编辑。\n', expectedContentHash: unknown.contentHash });
  const savedUnknown = await readFile(path.join(firstRoot, 'Documents', 'Notes', '未知元数据.md'), 'utf8');
  assert.match(savedUnknown, /customField: "保留值"/);
  assert.match(savedUnknown, /source: "外部 AI"/);
  assert.ok(savedUnknown.endsWith(unknown.body + '\n已编辑。\n'));
  const crlf = firstItems.find(item => item.name === 'CRLF 和 BOM.md');
  await firstStore.saveNote({ ...crlf, body: crlf.body + '第二行。\r\n', expectedContentHash: crlf.contentHash });
  const savedCrlf = await readFile(path.join(firstRoot, 'Documents', 'Notes', crlf.name), 'utf8');
  assert.ok(savedCrlf.startsWith('\uFEFF---\r\n'));
  assert.ok(savedCrlf.endsWith('# BOM 标题\r\n第二行。\r\n'));

  const records = createDesktopRecords(path.join(secondRoot, 'Documents'));
  const beforeMigration = (await records.list()).find(item => item.relativePath === path.join('Notes', relativeName));
  await records.migrate({ beforeMigrationSnapshot: async () => {} });
  const afterMigration = (await records.list()).find(item => item.relativePath === path.join('Notes', relativeName));
  assert.equal(afterMigration.id, beforeMigration.id);
  const raw = await readFile(path.join(secondRoot, 'Documents', 'Notes', relativeName), 'utf8');
  assert.match(raw, new RegExp(`id: "${first.id}"`));
});

test('notes index coalesces editor temporary rename and search uses portable ID', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reversewear-notes-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documents = path.join(root, 'Documents');
  const notes = path.join(documents, 'Notes');
  await mkdir(notes, { recursive: true });
  const changed = [];
  const index = createMarkdownIndex(documents, {
    scopedCategories: ['notes'], reconcileEvery: 5000,
    onChange: paths => changed.push(...paths),
  });
  t.after(() => index.close());
  await index.read();
  await new Promise(resolve => setTimeout(resolve, 80));
  changed.length = 0;

  const file = path.join(notes, '外部更新.md');
  const pending = path.join(notes, '外部更新.md.pending');
  await writeFile(pending, '# 新版本\n\n搜索验收词。\n', 'utf8');
  await new Promise(resolve => setTimeout(resolve, 90));
  await rename(pending, file);
  await new Promise(resolve => setTimeout(resolve, 180));
  const snapshot = await index.read();
  const entries = snapshot.entries.filter(item => item.relativePath === path.join('Notes', '外部更新.md'));
  assert.equal(entries.length, 1);
  assert.ok(changed.includes(path.join('Notes', '外部更新.md')));

  const search = createGlobalSearch(index, { documentsDirectory: documents });
  const result = await search.query({ query: '搜索验收词' });
  assert.equal(result.results.length, 1);
  const stored = await createWorkbenchStore(root).listNotes({ kind: 'note' });
  assert.equal(result.results[0].id, stored[0].id);
  assert.equal(stored[0].body, '# 新版本\n\n搜索验收词。\n');
  assert.equal((await readFile(file, 'utf8')), '# 新版本\n\n搜索验收词。\n');

  const setext = path.join(notes, '大写标题.MD');
  await writeFile(setext, '---\n\n正文\n\n---\n\n```md\n# FencedFalseHeading\n```\n\nSetextToken\n============\n', 'utf8');
  index.invalidate(path.join('Notes', '大写标题.MD'));
  await index.read();
  const headingResult = await search.query({ query: 'SetextToken' });
  assert.equal(headingResult.results[0].title, 'SetextToken');
});

test('same-path external replacement rejects a stale note save and preserves both versions', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reversewear-notes-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notes = path.join(root, 'Documents', 'Notes');
  await mkdir(notes, { recursive: true });
  const file = path.join(notes, 'Conflict.md');
  await writeFile(file, '# Starting version\n', 'utf8');
  const store = createWorkbenchStore(root);
  const opened = (await store.listNotes({ kind: 'note' }))[0];
  await writeFile(file, '# External version\n', 'utf8');
  await assert.rejects(store.saveNote({ ...opened, body: '# Unsaved workbench version\n', expectedContentHash: opened.contentHash }), /其他位置修改/);
  assert.equal(await readFile(file, 'utf8'), '# External version\n');
});
