import test from 'node:test';
import assert from 'node:assert/strict';
import { createGlobalSearch } from '../desktop_global_search.mjs';

function mockIndex(entries) { return { read: async () => ({ revision: 1, entries }) }; }
function entry(relativePath, metadata, body, updatedAt = '2026-11-14T12:00:00.000Z') {
  return { relativePath, parsed: { metadata, body }, updatedAt };
}

test('global search filters Chinese and English mixed content and returns an exact anchor', async () => {
  const search = createGlobalSearch(mockIndex([
    entry('Ideas/idea-a.md', { id: '11111111-1111-4111-8111-111111111111', type: 'idea', area: 'research', status: 'action', tags: ['声学', 'dataset'], createdAt: '2026-11-10' }, '# 声学数据集\n\nVocal pathology benchmark for Chinese speech.'),
    entry('Notes/note.md', { id: '22222222-2222-4222-8222-222222222222', type: 'note', tags: ['声学'], createdAt: '2026-10-10' }, '# 另一个记录\n\nPathology notes.'),
  ]));
  const result = await search.query({ query: '声学 vocal', filters: { area: 'research', status: 'action', from: '2026-11-01' } });
  assert.equal(result.total, 1);
  assert.equal(result.results[0].id, '11111111-1111-4111-8111-111111111111');
  assert.equal(result.results[0].anchor, 'Vocal pathology benchmark for Chinese speech.');
  assert.ok(result.results[0].matchRanges.length >= 1);
});

test('backlinks resolve stable references and include note routing metadata', async () => {
  const target = '11111111-1111-4111-8111-111111111111';
  const search = createGlobalSearch(mockIndex([
    entry('Ideas/target.md', { id: target, type: 'idea' }, '# Target'),
    entry('Notes/reference.md', { id: '22222222-2222-4222-8222-222222222222', type: 'note', fileId: 'pdf-id', page: 8, related: [target] }, '# Reference\n\nRelates to this.'),
  ]));
  const links = await search.backlinks(target);
  assert.equal(links.length, 1);
  assert.equal(links[0].fileId, 'pdf-id');
  assert.equal(links[0].page, 8);
  assert.equal(links[0].anchor, null);
});

test('10,000 warm indexed documents search using trigram candidates', async context => {
  const entries = Array.from({ length: 10_000 }, (_, index) => entry(`Notes/${index}.md`, {
    id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`, type: 'note', createdAt: '2026-11-14',
  }, `# Note ${index}\n\n${index === 9864 ? '中文 voice onset time analysis' : 'General archive entry with routine text.'}`));
  const search = createGlobalSearch(mockIndex(entries));
  await search.query({ query: 'warmup' });
  const result = await search.query({ query: 'voice onset' });
  const short = await search.query({ query: '中文' });
  assert.equal(result.total, 1);
  assert.equal(result.results[0].title, 'Note 9864');
  assert.ok(result.elapsedMs < 300, `warm query ${result.elapsedMs.toFixed(1)} ms`);
  assert.equal(short.total, 1);
  assert.ok(short.elapsedMs < 300, `warm short query ${short.elapsedMs.toFixed(1)} ms`);
  context.diagnostic(`10,000 records: trigram ${result.elapsedMs.toFixed(2)} ms, two characters ${short.elapsedMs.toFixed(2)} ms`);
});

test('search postings handle edits, replacements and deletes', async () => {
  const original = entry('Notes/a.md', {}, '# Original\n原始数据');
  let snapshot = { revision: 1, entries: [original] };
  const search = createGlobalSearch({ read: async () => snapshot });
  assert.equal((await search.query({ query: '原始数据' })).total, 1);
  snapshot = { revision: 2, entries: [entry('Notes/a.md', {}, '# New\n更新内容')] };
  assert.equal((await search.query({ query: '原始数据' })).total, 0);
  assert.equal((await search.query({ query: '更新内容' })).total, 1);
  assert.equal((await search.query({ filters: { type: 'note' } })).total, 1);
  snapshot = { revision: 3, entries: [] };
  assert.equal((await search.query({ query: '更新内容' })).total, 0);
});
