import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openClipboardStore } from '../../desktop_suite/clipboardStore.mjs';

async function withStore(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reversewear-clipboard-'));
  const store = await openClipboardStore(directory);
  try { await run({ store, directory }); }
  finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('clipboard store deduplicates content and indexes Chinese and English substrings', async () => {
  await withStore(async ({ store }) => {
    const first = await store.addItem({ type: 'text', text: 'Voice analysis 语音分析', source: { process: 'notepad.exe' } });
    const second = await store.addItem({ type: 'text', text: 'Voice analysis 语音分析', source: { process: 'browser.exe' } });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(first.item.id, second.item.id);
    assert.equal(second.item.usageCount, 2);
    assert.equal(store.search('分析').length, 1);
    assert.equal(store.search('Voice').length, 1);
    assert.equal(store.search('oi').length, 1);
  });
});

test('clipboard store preserves exact code whitespace and treats indentation as content', async () => {
  await withStore(async ({ store }) => {
    const source = '  function solve() {\n\treturn 7;\n  }\n';
    const windowsSource = '  function solve() {\r\n\treturn 7;\r\n  }\r\n';
    const first = await store.addItem({ type: 'text', text: source });
    const distinct = await store.addItem({ type: 'text', text: source.trim() });
    const windows = await store.addItem({ type: 'text', text: windowsSource });
    assert.equal(first.item.content.text, source);
    assert.equal(distinct.duplicate, false);
    assert.equal(distinct.item.content.text, source.trim());
    assert.equal(windows.item.content.text, windowsSource);
  });
});

test('clipboard store keeps board-pinned items beyond ordinary retention and can clear ordinary history', async () => {
  await withStore(async ({ store }) => {
    const board = store.createBoard('常用代码');
    const pinned = await store.addItem({ type: 'text', text: 'pinned alpha' });
    store.setBoardItem(board.id, pinned.item.id, true);
    await store.updateSettings({ maxItems: 1 });
    await store.addItem({ type: 'text', text: 'ordinary beta' });
    await store.addItem({ type: 'text', text: 'ordinary gamma' });
    assert.ok(store.getItem(pinned.item.id));
    assert.equal(store.search('').length, 2);
    assert.equal(await store.clearHistory(), 1);
    assert.equal(store.search('').length, 1);
    assert.equal(store.getItem(pinned.item.id).pinned, true);
  });
});

test('clipboard store writes image references as paths and validates image limits', async () => {
  await withStore(async ({ store }) => {
    const imageBuffer = Buffer.from('png sample');
    const saved = await store.addItem({ type: 'image', imageBuffer, imageWidth: 120, imageHeight: 80 });
    const imagePath = store.itemImagePath(saved.item.id);
    assert.ok(imagePath.endsWith(`${saved.item.content.image.split(path.sep).at(-1)}`));
    assert.equal((await stat(imagePath)).size, imageBuffer.length);
    await assert.rejects(store.addItem({ type: 'image', imageBuffer, imageWidth: 6400, imageHeight: 6400 }), /32 MP/);
  });
});

test('clipboard store stack is FIFO and starts empty on a fresh session', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reversewear-stack-'));
  let store = await openClipboardStore(directory);
  store.enqueueStack({ id: 'first', type: 'text' });
  store.enqueueStack({ id: 'second', type: 'text' });
  assert.equal(store.popStack().id, 'first');
  assert.equal(store.peekStack().item_id, 'second');
  store.close();
  store = await openClipboardStore(directory);
  assert.equal(store.peekStack(), null);
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test('clipboard store safely deletes boards while preserving ordinary records and supports bounded pagination', async () => {
  await withStore(async ({ store }) => {
    const board = store.createBoard('固定文本');
    const first = await store.addItem({ type: 'text', text: 'first matching entry' });
    await store.addItem({ type: 'text', text: 'second matching entry' });
    store.setBoardItem(board.id, first.item.id, true);
    assert.equal(store.search('matching', { type: 'all', limit: 1, offset: 1 }).length, 1);
    assert.equal(store.itemImagePath(''), null);
    assert.equal(await store.deleteBoard(''), false);
    assert.equal(await store.deleteBoard(board.id), true);
    assert.equal(store.getItem(first.item.id).pinned, false);
    assert.equal(await store.deleteBoard(board.id), false);
  });
});

test('clipboard store bounds the session stack at 100 entries', async () => {
  await withStore(async ({ store }) => {
    for (let index = 0; index < 102; index++) store.enqueueStack({ id: String(index) });
    assert.equal(store.getStats().count, 0);
    assert.equal(store.peekStack().item_id, '2');
    assert.deepEqual(store.listStack().slice(0, 2), [
      { id: '2', preview: '' }, { id: '3', preview: '' },
    ]);
    assert.equal(store.popStack().id, '2');
    assert.equal(store.getSettings().excludedProcesses.includes('keepassxc.exe'), true);
  });
});

test('clipboard settings normalize legacy process aliases and persist one canonical field pair', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reversewear-legacy-settings-'));
  let store = await openClipboardStore(directory);
  store.close();

  const database = new DatabaseSync(path.join(directory, 'clipboard.sqlite'));
  database.prepare('INSERT INTO settings(key,value_json) VALUES (?,?)').run('preferences', JSON.stringify({
    ignoredProcesses: ['Chrome.EXE', 'C:\\Tools\\Bitwarden.exe', '微信.exe'],
    plainSelectionCopy: true,
  }));
  database.close();

  store = await openClipboardStore(directory);
  try {
    assert.deepEqual(store.getSettings().excludedProcesses, ['chrome.exe', 'bitwarden.exe', '微信.exe']);
    assert.equal(store.getSettings().selectionCopyFallback, true);
    await store.updateSettings({ captureEnabled: true });
    const migratedDatabase = new DatabaseSync(path.join(directory, 'clipboard.sqlite'));
    const saved = JSON.parse(migratedDatabase.prepare('SELECT value_json FROM settings WHERE key=?').get('preferences').value_json);
    migratedDatabase.close();
    assert.deepEqual(saved.excludedProcesses, ['chrome.exe', 'bitwarden.exe', '微信.exe']);
    assert.equal(saved.selectionCopyFallback, true);
    assert.equal(Object.hasOwn(saved, 'ignoredProcesses'), false);
    assert.equal(Object.hasOwn(saved, 'plainSelectionCopy'), false);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('clipboard retention reduces 10000 ordinary records to the configured limit in one batch', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reversewear-retention-batch-'));
  let store = await openClipboardStore(directory);
  store.close();
  const database = new DatabaseSync(path.join(directory, 'clipboard.sqlite'));
  database.exec('DROP TRIGGER items_fts_insert; BEGIN IMMEDIATE;');
  const insert = database.prepare(`INSERT INTO items(id,content_hash,type,content_json,search_text,preview,
    image_relative_path,image_bytes,created_at,last_used_at) VALUES(?,?,'text',?,?,?,NULL,0,?,?)`);
  for (let index = 0; index < 10_000; index++) {
    const text = `retention item ${index}`;
    const timestamp = new Date(index * 1000).toISOString();
    insert.run(`retention-${index}`, `hash-${index}`, JSON.stringify({ text, html: '', rtf: '' }), text,
      text, timestamp, timestamp);
  }
  database.prepare(`INSERT INTO settings(key,value_json) VALUES('preferences',?)`).run(JSON.stringify({ maxItems: 10_000 }));
  database.exec(`INSERT INTO items_fts(item_id,search_text) SELECT id,search_text FROM items;
    CREATE TRIGGER items_fts_insert AFTER INSERT ON items BEGIN
      INSERT INTO items_fts(item_id,search_text) VALUES (new.id,new.search_text);
    END;
    COMMIT;`);
  database.close();
  store = await openClipboardStore(directory);
  try {
    const started = performance.now();
    await store.updateSettings({ maxItems: 500 });
    const elapsed = performance.now() - started;
    assert.equal(store.getStats().count, 500);
    assert.ok(store.search('retention item 9999').length, 'most recently used record remains indexed');
    assert.equal(store.search('retention item 0').length, 0);
    const added = await store.addItem({ type: 'text', text: 'new item after retention' });
    assert.equal(added.duplicate, false);
    assert.equal(store.search('after retention').length, 1);
    assert.ok(elapsed < 1000, `retention took ${elapsed.toFixed(1)} ms`);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('clipboard store sweeps abandoned and unreferenced image files while preserving indexed images', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reversewear-sweep-'));
  let store = await openClipboardStore(directory);
  const image = await store.addItem({ type: 'image', imageBuffer: Buffer.from('png retained'), imageWidth: 3, imageHeight: 2 });
  const imagePath = store.itemImagePath(image.item.id);
  store.close();
  const imageDirectory = path.join(directory, 'Images');
  const orphan = path.join(imageDirectory, 'orphan.png');
  const temporary = path.join(imageDirectory, 'crashed.png.part.tmp');
  await mkdir(imageDirectory, { recursive: true });
  await writeFile(orphan, 'orphan');
  await writeFile(temporary, 'partial');
  store = await openClipboardStore(directory);
  try {
    assert.equal(store.getItem(image.item.id).image.relativePath, path.join('Images', path.basename(imagePath)));
    assert.equal(await stat(imagePath).then(() => true, () => false), true);
    assert.equal(await stat(orphan).then(() => true, () => false), false);
    assert.equal(await stat(temporary).then(() => true, () => false), false);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
