import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createDesktopVocabulary } from '../desktop_vocabulary.mjs';

test('repeated lookup preserves one entry, source occurrences and review history', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'reversewear-vocab-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  let now = new Date(2026, 10, 14, 1);
  const db = createDesktopVocabulary(folder, { now: () => now, getDayStartMinutes: () => 240 });
  const pdf = { type: 'pdf', title: 'Voice study', fileId: '0123456789abcdef', page: 4 };
  const first = await db.saveVocabulary({ word: 'Voice', gloss: '嗓音', original: 'Voice onset was delayed.', source: pdf });
  assert.equal(first.dueDate, '2026-11-13');
  assert.equal((await db.listVocabulary()).dueCount, 1);
  const reviewed = await db.reviewVocabulary({ id: first.id, rating: 'good' });
  assert.equal(reviewed.dueDate, '2026-11-14');
  assert.equal((await db.listVocabulary()).dueCount, 0);
  const saved = await db.saveVocabulary({ word: 'voice', gloss: '声音', source: { ...pdf, page: 5 }, original: 'The voice was stable.' });
  assert.equal(saved.id, first.id);
  assert.equal(saved.repetitions, 1);
  assert.deepEqual(saved.sources.map(source => source.page), [5, 4]);
  const raw = await readFile(path.join(folder, 'Vocabulary', first.id + '.md'), 'utf8');
  assert.match(raw, /^private: true$/m);
  assert.match(raw, /Voice onset was delayed/);
  now = new Date(2026, 10, 14, 4);
  assert.equal((await db.listVocabulary()).dueCount, 1);
  await db.reviewVocabulary({ id: first.id, rating: 'again' });
  assert.equal((await db.listVocabulary()).entries[0].intervalDays, 0);
});

test('personal terms persist, match only their direction, and remain private', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'reversewear-terms-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const db = createDesktopVocabulary(folder);
  const item = await db.saveTerm({ source: 'voice onset time', target: '嗓音起始时间', note: '论文约定' });
  assert.equal((await db.matchedTerms('VOICE ONSET TIME was measured.', 'en-zh'))[0].id, item.id);
  assert.deepEqual(await db.matchedTerms('voice onset time', 'zh-en'), []);
  assert.match(await readFile(path.join(folder, 'Terminology', item.id + '.md'), 'utf8'), /private: true/);
  const reopened = createDesktopVocabulary(folder);
  assert.equal((await reopened.listTerms())[0].target, '嗓音起始时间');
  assert.equal(await reopened.removeTerm(item.id), true);
  assert.deepEqual(await reopened.listTerms(), []);
});
