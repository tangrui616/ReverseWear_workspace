import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createDesktopRecords } from '../desktop_records.mjs';
import { createLinkSnapshots, createLocalSearch } from '../desktop_library_tools.mjs';
import { DEFAULT_DATA_ROOT, loadDataPointer, saveDataPointer, verifyDataRoot } from '../desktop_data_root.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'reversewear-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('data root validates existing settings and preserves the last valid pointer after failed selection', async t => {
  const root = await fixture(t);
  const first = path.join(root, 'OneDrive', 'Workspace');
  const second = path.join(root, 'broken');
  await mkdir(first, { recursive: true });
  await mkdir(path.join(second, 'Settings', 'Stilltime'), { recursive: true });
  await writeFile(path.join(second, 'Settings', 'Stilltime', 'settings.json'), '{"schemaVersion":99}');
  const pointer = path.join(root, 'config', 'pointer.json');
  assert.equal(await loadDataPointer(pointer), DEFAULT_DATA_ROOT);
  const selected = await verifyDataRoot(first);
  assert.equal(selected.root, first);
  assert.ok(selected.warning);
  await saveDataPointer(pointer, first);
  await assert.rejects(verifyDataRoot(second), /无法使用配置/);
  await assert.rejects(verifyDataRoot(path.join(root, 'not-there')), { code: 'ENOENT' });
  assert.equal(await loadDataPointer(pointer), first);
});

test('snapshots retain manually pasted versions and local search rebuilds after external edits', async t => {
  const root = await fixture(t);
  const documentsDirectory = path.join(root, 'Documents');
  const notes = path.join(documentsDirectory, 'Notes');
  await mkdir(notes, { recursive: true });
  const noteFile = path.join(notes, 'record.md');
  const plain = '---\nid: 4e3345e6-0bb3-4e39-a802-590764321245\ntitle: 病理Voice\ntags: ["Datasets"]\nschema: 1\n---\n';
  await writeFile(noteFile, plain + '外部原文');
  const cacheFile = path.join(root, 'runtime', 'search-index.json');
  const search = createLocalSearch({ records: createDesktopRecords(documentsDirectory), documentsDirectory, cacheFile });
  t.after(() => search.close());
  assert.equal((await search('病理voice')).length, 1);
  assert.equal((await search('DATASETS')).length, 1);
  await writeFile(noteFile, plain + '外部更新后的内容');
  assert.equal((await search('更新后')).length, 1);
  assert.equal((await search('外部原文')).length, 0);
  await unlink(cacheFile);
  assert.equal((await search('病理')).length, 1);
  const id = 'a402ce0f-b820-4e02-a478-3569cac7dd88';
  const backend = createLinkSnapshots(root, { listLinks: async () => [{ id, url: 'https://example.invalid/' }] });
  const first = await backend.save(id, '第一份文章快照');
  const second = await backend.save(id, '第二份更新内容<script>not running</script>');
  assert.equal((await backend.list(id)).length, 2);
  assert.match(await backend.read(id, first), /第一份文章快照/);
  assert.match(await backend.read(id, second), /<script>not running<\/script>/);
  await assert.rejects(backend.read(id, '../../Notes/record'), /快照 ID/);
});
