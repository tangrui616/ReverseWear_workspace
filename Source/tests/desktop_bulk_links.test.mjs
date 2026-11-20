import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBulkLinkTools } from '../desktop_bulk_links.mjs';
import { createWorkbenchStore } from '../workbench-store.mjs';

const idA = 'aa000000-0000-4000-8000-000000000001';
const idB = 'bb000000-0000-4000-8000-000000000002';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reversewear-bulk-links-'));
  const documents = path.join(root, 'Documents');
  const settings = path.join(root, 'Settings', 'Stilltime');
  const links = path.join(documents, 'Links');
  await mkdir(links, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = path.join(links, `${idA}.md`);
  const b = path.join(links, `${idB}.md`);
  await writeFile(a, `---\nid: "${idA}"\ntype: "link"\ntitle: "Alpha"\nurl: "https://example.com/a#first"\ntags: ["research"]\nnote: "keep this"\n---\n\nbody A\n`);
  await writeFile(b, `---\nid: "${idB}"\ntype: "link"\ntitle: "Beta"\nurl: "https://EXAMPLE.com/a#second"\ntags: []\n---\n\nbody B\n`);
  return { documents, settings, a, b, tools: createBulkLinkTools({ documentsDirectory: documents, settingsDirectory: settings }) };
}

test('bulk tags and rename are undoable, and alias tags persist', async t => {
  const { tools, a, b } = await fixture(t);
  const untouched = await readFile(a, 'utf8');
  assert.deepEqual(await tools.bulkTag({ ids: [idA], add: ['research'] }), { changed: 0 });
  assert.equal(await readFile(a, 'utf8'), untouched);
  assert.deepEqual(await tools.bulkTag({ ids: [idA, idB], add: ['research/voice'] }), { changed: 2 });
  assert.match(await readFile(a, 'utf8'), /"research\/voice"/);
  assert.match(await readFile(a, 'utf8'), /body A\n/);
  await tools.saveTagAliases({ tag: 'research/voice', aliases: ['voice-study', '病理语音'] });
  assert.deepEqual((await tools.listLinks()).tags.find(item => item.name === 'research/voice'), { name: 'research/voice', aliases: ['voice-study', '病理语音'] });
  assert.deepEqual(await tools.renameTag({ from: 'research/voice', to: 'research/voice-analysis' }), { changed: 2 });
  assert.match(await readFile(b, 'utf8'), /"research\/voice-analysis"/);
  assert.equal((await tools.undo()).undone, true);
  assert.match(await readFile(a, 'utf8'), /"research\/voice"/);
  assert.equal((await tools.undo()).undone, false);
});

test('duplicate URL groups preserve both records and primary selection', async t => {
  const { tools, a, b } = await fixture(t);
  const listed = await tools.listLinks();
  assert.equal(listed.duplicateGroups.length, 1);
  assert.equal(listed.duplicateGroups[0].items.length, 2);
  await tools.setPrimary({ canonicalUrl: 'https://example.com/a', primaryId: idB });
  assert.equal((await tools.listLinks()).duplicateGroups[0].primaryId, idB);
  assert.match(await readFile(a, 'utf8'), /body A/);
  assert.match(await readFile(b, 'utf8'), /body B/);
});

test('undo reports external edits instead of overwriting them', async t => {
  const { tools, a } = await fixture(t);
  await tools.bulkTag({ ids: [idA], add: ['later'] });
  await writeFile(a, `${await readFile(a, 'utf8')}\nexternal edit\n`);
  assert.deepEqual(await tools.undo(), { undone: false, conflicts: [`${idA}.md`] });
  assert.match(await readFile(a, 'utf8'), /external edit/);
});

test('interrupted bulk writes recover from the on-disk journal', async t => {
  const { tools, settings, a } = await fixture(t);
  const before = await readFile(a, 'utf8');
  const after = before.replace('tags: ["research"]', 'tags: ["research", "new"]');
  await writeFile(a, after);
  const digest = value => createHash('sha256').update(value).digest('hex');
  await mkdir(settings, { recursive: true });
  await writeFile(path.join(settings, 'link-organization.pending.json'), JSON.stringify({
    schema: 1,
    files: [{ file: path.basename(a), before, beforeHash: digest(before), afterHash: digest(after) }],
  }));
  await tools.listLinks();
  assert.equal(await readFile(a, 'utf8'), before);
  await assert.rejects(() => readFile(path.join(settings, 'link-organization.pending.json')),
    error => error.code === 'ENOENT');
});

test('a committed transaction marker prevents rollback after journal cleanup interruption', async t => {
  const { tools, settings, a } = await fixture(t);
  const before = await readFile(a, 'utf8');
  await tools.bulkTag({ ids: [idA], add: ['committed'] });
  const current = await readFile(a, 'utf8');
  const registryPath = path.join(settings, 'link-organization.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const digest = value => createHash('sha256').update(value).digest('hex');
  await writeFile(path.join(settings, 'link-organization.pending.json'), JSON.stringify({
    schema: 1,
    txId: registry.lastTxId,
    files: [{ file: path.basename(a), before, beforeHash: digest(before), afterHash: digest(current) }],
  }));
  await tools.listLinks();
  assert.equal(await readFile(a, 'utf8'), current);
  assert.equal(JSON.parse(await readFile(registryPath, 'utf8')).undo.kind, 'bulk');
  await assert.rejects(() => readFile(path.join(settings, 'link-organization.pending.json')),
    error => error.code === 'ENOENT');
});

test('alias and primary changes expose a safe undo state', async t => {
  const { tools } = await fixture(t);
  await tools.setPrimary({ canonicalUrl: 'https://example.com/a#one', primaryId: idB });
  assert.equal((await tools.listLinks()).canUndo, true);
  assert.equal((await tools.undo()).undone, true);
  assert.equal((await tools.listLinks()).duplicateGroups[0].primaryId, idA);
  await tools.saveTagAliases({ tag: 'research', aliases: ['病理语音'] });
  assert.equal((await tools.undo()).undone, true);
  assert.deepEqual((await tools.listLinks()).tags.find(tag => tag.name === 'research').aliases, []);
});

test('link edits allow unchanged duplicate URLs and reject unknown IDs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reversewear-link-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createWorkbenchStore(root);
  const first = (await store.saveLink({ url: 'https://example.com/read#first', title: 'First' })).item;
  const secondId = idB;
  const links = path.join(root, 'Documents', 'Links');
  await writeFile(path.join(links, `${secondId}.md`), `---\nid: "${secondId}"\ntype: "link"\ntitle: "Second"\nurl: "https://example.com/read#other"\ntags: []\nnote: "original"\n---\n\nsecond body\n`);
  const updated = await store.saveLink({ id: secondId, url: 'https://example.com/read#new-fragment', title: 'Second edited', note: 'updated' });
  assert.equal(updated.item.id, secondId);
  assert.equal(updated.item.title, 'Second edited');
  await assert.rejects(() => store.saveLink({ id: idA, url: 'https://example.com/read', title: 'Unknown' }), /已经不存在/);
  const bulk = createBulkLinkTools({ documentsDirectory: path.join(root, 'Documents'), settingsDirectory: path.join(root, 'Settings', 'Stilltime') });
  await bulk.saveTagAliases({ tag: 'study', aliases: ['voice'] });
  await store.saveLink({ id: first.id, url: first.url, title: 'First', tags: ['study'] });
  assert.equal((await store.listLinks('voice')).some(link => link.id === first.id), true);
  await store.saveLink({ id: first.id, url: first.url, title: 'First', tags: ['constructor'] });
  assert.doesNotThrow(() => store.listLinks('unmatched'));
  assert.equal((await store.listLinks('unmatched')).some(link => link.id === first.id), false);
  await bulk.saveTagAliases({ tag: '__proto__', aliases: ['prototype-term'] });
  assert.deepEqual((await bulk.listLinks()).tags.find(tag => tag.name === '__proto__').aliases, ['prototype-term']);
});
