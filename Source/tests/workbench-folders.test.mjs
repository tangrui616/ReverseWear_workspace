import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBulkLinkTools } from '../desktop_bulk_links.mjs';
import { createWorkbenchStore } from '../workbench-store.mjs';

const linkId = 'aa000000-0000-4000-8000-000000000001';
const recordId = 'bb000000-0000-4000-8000-000000000002';
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reversewear-workbench-folders-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documents = path.join(root, 'Documents');
  const settings = path.join(root, 'Settings', 'Stilltime');
  const store = createWorkbenchStore(root);
  const bulk = createBulkLinkTools({ documentsDirectory: documents, settingsDirectory: settings });
  return { root, documents, settings, store, bulk };
}

test('root notes stay root-level and nested same-name notes remain distinct', async t => {
  const { documents, store } = await fixture(t);
  const notes = path.join(documents, 'Notes');
  await mkdir(path.join(notes, 'Research'), { recursive: true });
  await writeFile(path.join(notes, 'Idea.md'), '---\nid: "11111111-1111-4111-8111-111111111111"\nschema: 1\nkind: "note"\n---\n\nroot body\n');
  await writeFile(path.join(notes, 'Research', 'Idea.md'), '---\nid: "22222222-2222-4222-8222-222222222222"\nschema: 1\nkind: "note"\n---\n\nnested body\n');

  const listed = await store.listNotes({ kind: 'note' });
  const rootNote = listed.find(item => item.id === '11111111-1111-4111-8111-111111111111');
  const nestedNote = listed.find(item => item.id === '22222222-2222-4222-8222-222222222222');
  assert.equal(rootNote.path, 'Idea.md');
  assert.equal(rootNote.folderPath, '');
  assert.equal(nestedNote.path, 'Research/Idea.md');
  assert.equal(nestedNote.folderPath, 'Research');
  assert.equal(rootNote.body, 'root body\n');
  assert.equal(nestedNote.body, 'nested body\n');
  assert.deepEqual((await store.listFolders({ scope: 'notes' })), ['Research']);
  const copy = path.join(notes, 'Research', 'Copy.md');
  await writeFile(copy, await readFile(path.join(notes, 'Idea.md')));
  await assert.rejects(store.saveNote({ kind: 'note', id: rootNote.id, body: 'ambiguous write' }), /重复/);
  await store.saveNote({ kind: 'note', id: rootNote.id, path: 'Research/Copy.md', body: 'explicit write' });
  assert.match(await readFile(copy, 'utf8'), /explicit write/);
  assert.match(await readFile(path.join(notes, 'Idea.md'), 'utf8'), /root body/);
});

test('folder creation accepts nested parents and rejects traversal and Windows device names', async t => {
  const { store } = await fixture(t);
  assert.deepEqual(await store.createFolder({ scope: 'notes', name: 'Research' }), { path: 'Research' });
  assert.deepEqual(await store.createFolder({ scope: 'notes', parentPath: 'Research', name: 'Drafts' }), { path: 'Research/Drafts' });
  await assert.rejects(() => store.createFolder({ scope: 'notes', parentPath: '../outside', name: 'Escape' }), /无效|越界|文件夹/);
  await assert.rejects(() => store.createFolder({ scope: 'notes', name: 'CON' }), /无效/);
  await assert.rejects(() => store.createFolder({ scope: 'notes', name: 'LPT1.txt' }), /无效/);
  await assert.rejects(() => store.createFolder({ scope: 'notes', name: 'Research' }), /同名/);
});

test('moving a plain external note preserves BOM and CRLF, assigns a stable ID, and keeps a backup', async t => {
  const { root, documents, store } = await fixture(t);
  const notes = path.join(documents, 'Notes');
  await mkdir(notes, { recursive: true });
  await store.createFolder({ scope: 'notes', name: 'Filed' });
  const source = path.join(notes, 'External.md');
  const original = '\uFEFF---\r\ntitle: "External note"\r\n---\r\n\r\nline one\r\nline two\r\n';
  await writeFile(source, original, 'utf8');
  const row = (await store.listNotes({ kind: 'note' })).find(item => item.name === 'External.md');
  assert.equal(row.externalMarkdown, true);

  const moved = await store.moveRecord({ scope: 'notes', relativePath: 'External.md', destination: 'Filed', expectedContentHash: row.contentHash });
  const movedPath = path.join(notes, 'Filed', 'External.md');
  const contents = await readFile(movedPath, 'utf8');
  assert.equal(moved.relativePath, 'Filed/External.md');
  assert.match(contents, /^\uFEFF---\r\n/);
  assert.match(contents, /\r\nid: "[a-f0-9]{16}"\r\nschema: 1\r\n---\r\n\r\nline one\r\nline two\r\n$/);
  assert.equal(contents.replaceAll('\r\n', '').includes('\n'), false);
  assert.equal(moved.id, row.id);
  assert.equal(moved.id, (await store.listNotes({ kind: 'note' })).find(item => item.path === 'Filed/External.md').id);
  assert.equal(moved.contentHash, hash(Buffer.from(contents)));
  const backupDir = path.join(root, 'FolderMoveBackups');
  const backups = await readdir(backupDir);
  assert.equal(backups.length, 1);
  assert.deepEqual(await readFile(path.join(backupDir, backups[0])), Buffer.from(original));
  await assert.rejects(() => access(source));
});

test('move hash guard rejects stale content and marked records move byte-for-byte without backups', async t => {
  const { root, documents, store } = await fixture(t);
  const notes = path.join(documents, 'Notes');
  await mkdir(notes, { recursive: true });
  await store.createFolder({ scope: 'notes', name: 'Filed' });
  const marked = path.join(notes, 'Marked.md');
  const markedText = `---\nid: "${recordId}"\nschema: 1\nkind: "note"\ntitle: "Marked"\n---\n\ncontent\n`;
  await writeFile(marked, markedText);
  await assert.rejects(() => store.moveRecord({ scope: 'notes', relativePath: 'Marked.md', destination: 'Filed', expectedContentHash: 'stale-hash' }), /外部修改/);
  assert.equal(await readFile(marked, 'utf8'), markedText);
  const before = await store.listNotes({ kind: 'note' }).then(rows => rows.find(row => row.id === recordId));
  const result = await store.moveRecord({ scope: 'notes', relativePath: 'Marked.md', destination: 'Filed', expectedContentHash: before.contentHash });
  assert.equal(result.relativePath, 'Filed/Marked.md');
  assert.equal(await readFile(path.join(notes, result.relativePath), 'utf8'), markedText);
  await assert.rejects(() => access(path.join(root, 'FolderMoveBackups')));
});

test('nested links, per-link note paths, and link association survive folder operations', async t => {
  const { documents, store, bulk } = await fixture(t);
  await store.createFolder({ scope: 'links', name: 'Reading' });
  const saved = await store.saveLink({ url: 'https://example.com/article', title: 'Article', folderPath: 'Reading', tags: ['paper'] });
  assert.equal(saved.item.path, `Reading/${saved.item.id}.md`);
  assert.equal(saved.item.folderPath, 'Reading');
  assert.equal((await store.listLinks()).find(item => item.id === saved.item.id).path, saved.item.path);
  assert.equal((await bulk.listLinks()).items.find(item => item.id === saved.item.id).relativePath, saved.item.path);

  await store.createFolder({ scope: 'link-notes', linkId: saved.item.id, name: 'Analysis' });
  const note = await store.saveLinkNote({ linkId: saved.item.id, folderPath: 'Analysis', title: 'Observation', body: 'linked note', tags: ['voice'] });
  assert.equal(note.path, `Analysis/${note.id}.md`);
  assert.equal(note.folderPath, 'Analysis');
  const index = await store.listLinkNotes(saved.item.id);
  assert.deepEqual(index.folders, ['Analysis']);
  assert.equal(index.files[0].path, note.path);
  const loaded = await store.getLinkNote(saved.item.id, note.path);
  assert.equal(loaded.body, 'linked note');
  assert.equal(loaded.relatedId, saved.item.id);
  const edited = await store.saveLinkNote({ ...loaded, linkId: saved.item.id, body: 'edited in folder' });
  assert.equal(edited.path, note.path);
  assert.equal((await store.getLinkNote(saved.item.id, note.path)).body, 'edited in folder');
  assert.equal((await store.listLinks()).find(item => item.id === saved.item.id).id, saved.item.id);

  await store.createFolder({ scope: 'links', name: 'Other' });
  const movedLink = await store.moveRecord({ scope: 'links', relativePath: saved.item.path, destination: 'Other' });
  assert.equal(movedLink.relativePath, `Other/${saved.item.id}.md`);
  assert.equal((await store.listLinkNotes(saved.item.id)).files[0].path, note.path);
  assert.equal((await store.getLinkNote(saved.item.id, note.path)).relatedId, saved.item.id);
  assert.equal(await readFile(path.join(documents, 'Links', movedLink.relativePath), 'utf8').then(text => text.includes('https://example.com/article')), true);
});

test('bulk tag changes and undo find a link after it has moved into a nested directory', async t => {
  const { store, bulk } = await fixture(t);
  await store.createFolder({ scope: 'links', name: 'Nested' });
  const saved = await store.saveLink({ url: 'https://example.com/nested', title: 'Nested link', tags: ['before'] });
  await store.moveRecord({ scope: 'links', relativePath: saved.item.path, destination: 'Nested' });
  const nestedFile = path.join((await store.linkWorkspace(saved.item.id)).linkFile);
  assert.match(nestedFile, /[\\/]Links[\\/]Nested[\\/]/);
  assert.deepEqual(await bulk.bulkTag({ ids: [saved.item.id], add: ['after'] }), { changed: 1 });
  assert.ok((await store.listLinks()).find(item => item.id === saved.item.id).tags.includes('after'));
  assert.deepEqual(await bulk.undo(), { undone: true, conflicts: [] });
  assert.deepEqual((await store.listLinks()).find(item => item.id === saved.item.id).tags, ['before']);
});
