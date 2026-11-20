import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLifeWorkbench } from '../desktop_life.mjs';

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reversewear-life-'));
  try { await run(root, createLifeWorkbench(root)); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('mood records are always private and saved as stable Markdown records', async () => fixture(async (root, life) => {
  const saved = await life.save({ kind: 'mood', title: '情绪复盘', private: false, fields: { trigger: '发生的事', feelings: '焦虑', thoughts: '担心', needs: '休息', nextStep: '散步' } });
  assert.equal(saved.private, true);
  assert.match(saved.relativePath, /^MoodJournal\/[a-f0-9-]+\.md$/i);
  assert.equal(saved.fields.feelings, '焦虑');
  const source = await readFile(path.join(root, 'Documents', saved.relativePath), 'utf8');
  assert.match(source, /private: true/);
  assert.match(source, /id: "/);
  assert.equal((await life.get({ id: saved.id, kind: 'mood' })).id, saved.id);
}));

test('thinking and content records preserve their editable fields and workflow stage', async () => fixture(async (_root, life) => {
  const thinking = await life.save({ kind: 'thinking', title: '问题', fields: { question: '如何推进？', freeWrite: '先把边界列出来', aiQuestions: '有哪些证据？', answers: '已有数据', conclusion: '先整理数据' } });
  assert.match(thinking.body, /<!-- ai:begin -->/);
  assert.equal(thinking.fields.aiQuestions, '有哪些证据？');
  assert.doesNotMatch(await readFile(path.join(_root, 'Documents', thinking.relativePath), 'utf8'), /"aiQuestions"/);
  const content = await life.save({ kind: 'content', title: '本地翻译经验', fields: { topic: '离线工具', stage: 'script', script: '脚本草稿' } });
  assert.equal(content.status, 'script');
  assert.equal((await life.list({ kind: 'content' })).length, 1);
}));

test('resaving a thinking page keeps a single AI block and preserves its fields', async () => fixture(async (root, life) => {
  const first = await life.save({ kind: 'thinking', title: '思考', private: true, fields: { question: '问题？', freeWrite: '我的正文', aiQuestions: '追问一', answers: '回答一', conclusion: '结论' } });
  const second = await life.save({ id: first.id, kind: 'thinking', title: first.title, private: first.private, fields: first.fields, expectedUpdatedAt: first.updatedAt });
  const source = await readFile(path.join(root, 'Documents', second.relativePath), 'utf8');
  assert.equal((source.match(/<!-- ai:begin -->/g) ?? []).length, 1);
  assert.equal((source.match(/<!-- ai:end -->/g) ?? []).length, 1);
  const reread = await life.get({ id: second.id, kind: 'thinking' });
  assert.equal(reread.fields.freeWrite, '我的正文');
  assert.equal(reread.fields.aiQuestions, '追问一');
  assert.equal(reread.fields.answers, '回答一');
}));

test('Markdown section edits are read back as the canonical field values', async () => fixture(async (root, life) => {
  const saved = await life.save({ kind: 'experience', title: '记录', fields: { happenedAt: '2026-11-13', place: '上海', event: '原文', learning: '原总结' } });
  assert.equal(saved.fields.happenedAt, '2026-11-13');
  assert.equal(saved.fields.place, '上海');
  const file = path.join(root, 'Documents', saved.relativePath);
  const source = await readFile(file, 'utf8');
  await writeFile(file, source.replace('原文', '外部编辑后的正文'), 'utf8');
  const readBack = await life.get({ id: saved.id, kind: 'experience' });
  assert.equal(readBack.fields.event, '外部编辑后的正文');
}));

test('stable IDs resolve after a record file is renamed', async () => fixture(async (root, life) => {
  const saved = await life.save({ kind: 'experience', title: '记录', fields: { event: '内容' } });
  const original = path.join(root, 'Documents', saved.relativePath);
  const renamed = path.join(path.dirname(original), 'renamed.md');
  await rename(original, renamed);
  assert.equal((await life.get({ id: saved.id, kind: 'experience' })).id, saved.id);
}));

test('template records can be applied and stale updates are rejected', async () => fixture(async (_root, life) => {
  const template = await life.saveTemplate({ title: '生活经历模板', area: '生活经历', body: '## 发生了什么\n\n\n## 学到什么\n\n' });
  assert.equal(template.kind, 'template');
  assert.equal((await life.list({ kind: 'template' })).length, 1);
  const record = await life.save({ kind: 'experience', title: '周末散步', fields: { event: '看到了湖', learning: '需要休息' } });
  await assert.rejects(life.save({ id: record.id, kind: 'experience', title: '冲突', fields: {}, expectedUpdatedAt: null }), /其他位置修改/);
}));

test('timeline segments share a workday record and repeated saves are idempotent', async () => fixture(async (root) => {
  const life = createLifeWorkbench(root, { getDayStartMinutes: () => 180 });
  const startAt = new Date(2026, 4, 12, 23, 50).toISOString();
  const endAt = new Date(2026, 4, 13, 0, 20).toISOString();
  const first = await life.appendTimeline({ sessionId: '8e74dd3c-61b4-4d18-86e9-9dd9f7a4b2bc', startAt, endAt, task: '整理资料' });
  const repeated = await life.appendTimeline({ sessionId: '8e74dd3c-61b4-4d18-86e9-9dd9f7a4b2bc', startAt, endAt, task: '整理资料' });
  const next = await life.appendTimeline({ sessionId: 'c8ab3ed2-a741-47dc-a1a5-16844661bedc',
    startAt: new Date(2026, 4, 13, 0, 25).toISOString(), endAt: new Date(2026, 4, 13, 0, 40).toISOString(), task: '校对笔记' });
  assert.equal(first.id, repeated.id);
  assert.equal(first.id, next.id);
  assert.equal(first.happenedAt, '2026-05-12');
  assert.equal((await life.list({ kind: 'experience' })).length, 1);
  assert.match(next.fields.event, /2026-05-12 23:50–2026-05-13 00:20 整理资料/);
  assert.match(next.fields.event, /00:25–00:40 校对笔记/);
  assert.equal((next.fields.event.match(/focus-session:/g) ?? []).length, 2);
}));

test('timeline append rejects an invalid session without creating records', async () => fixture(async (_root, life) => {
  await assert.rejects(life.appendTimeline({ task: 'no id' }), /编号无效/);
  assert.equal((await life.list({ kind: 'experience' })).length, 0);
}));
