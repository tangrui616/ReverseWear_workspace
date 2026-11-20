import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDesktopHistory } from '../desktop_history.mjs';

test('ZIP snapshots verify and restore Markdown plus settings into an empty directory', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reversewear-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documents = path.join(root, 'Documents');
  const settings = path.join(root, 'Settings', 'Stilltime');
  await mkdir(path.join(documents, 'Notes'), { recursive: true });
  await mkdir(settings, { recursive: true });
  await mkdir(path.join(documents, 'Files', 'pdf-id'), { recursive: true });
  await mkdir(path.join(documents, 'Files', 'pdf-id', 'payload'), { recursive: true });
  await mkdir(path.join(documents, 'Inbox'), { recursive: true });
  await mkdir(path.join(documents, 'Ideas'), { recursive: true });
  await mkdir(path.join(documents, 'Scratch'), { recursive: true });
  await writeFile(path.join(documents, 'Notes', 'one.md'), '# Saved\r\n正文\r\n', 'utf8');
  await writeFile(path.join(documents, 'Files', 'pdf-id', 'source.pdf'), Buffer.from([0, 1, 2]));
  await writeFile(path.join(documents, 'Files', 'pdf-id', 'payload', 'readme.md'), 'Ignore attachment subtree', 'utf8');
  await writeFile(path.join(documents, 'Inbox', '2026-11-14.md'), '# Capture\n', 'utf8');
  await writeFile(path.join(documents, 'Ideas', 'idea.md'), '# Idea\n', 'utf8');
  await writeFile(path.join(documents, 'Scratch', 'unmanaged.md'), '# Skip\n', 'utf8');
  await writeFile(path.join(settings, 'settings.json'), '{"schemaVersion":1}\n', 'utf8');
  const history = createDesktopHistory({ documentsDirectory: documents, settingsDirectory: settings, historyDirectory: path.join(root, 'Runtime', 'History') });
  const snapshot = await history.createSnapshot({ reason: 'before-migration' });
  const verification = await history.verifySnapshot(snapshot);
  assert.equal(verification.valid, true);
  assert.equal(verification.reason, 'before-migration');
  assert.equal(verification.count, 4);
  assert.match(verification.origin, /^[a-f0-9]{64}$/);
  const destination = path.join(root, 'restored');
  await history.restoreSnapshot(snapshot, destination);
  assert.equal(await readFile(path.join(destination, 'Documents', 'Notes', 'one.md'), 'utf8'), '# Saved\r\n正文\r\n');
  assert.equal(await readFile(path.join(destination, 'Settings', 'Stilltime', 'settings.json'), 'utf8'), '{"schemaVersion":1}\n');
  await assert.rejects(stat(path.join(destination, 'Documents', 'Files', 'pdf-id', 'source.pdf')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(destination, 'Documents', 'Inbox', '2026-11-14.md'), 'utf8'), '# Capture\n');
  await assert.rejects(stat(path.join(destination, 'Documents', 'Files', 'pdf-id', 'payload', 'readme.md')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(destination, 'Documents', 'Scratch', 'unmanaged.md')), { code: 'ENOENT' });
  await assert.rejects(history.restoreSnapshot(snapshot, destination), /必须是空目录/);
});

test('daily snapshots are deduplicated and rotation retains fourteen verified copies', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reversewear-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documents = path.join(root, 'Documents');
  await mkdir(documents, { recursive: true });
  let day = 1;
  const history = createDesktopHistory({ documentsDirectory: documents, settingsDirectory: path.join(root, 'Settings', 'Stilltime'), historyDirectory: path.join(root, 'Runtime', 'History'), now: () => new Date(`2026-01-${String(day).padStart(2, '0')}T12:00:00`) });
  const first = await history.createSnapshot();
  assert.equal(await history.createSnapshot(), first);
  for (day = 2; day <= 16; day++) await history.createSnapshot();
  const dailyFiles = (await readdir(path.dirname(first))).filter(name => name.startsWith('daily-'));
  assert.equal(dailyFiles.length, 14);
  assert.ok(dailyFiles.every(name => name.endsWith('.zip')));
});

test('corrupt daily snapshot is replaced safely and external copy can be retried', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reversewear-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documents = path.join(root, 'Documents');
  const snapshotDirectory = path.join(root, 'Runtime', 'History');
  const externalDirectory = path.join(root, 'External');
  await mkdir(documents, { recursive: true });
  await writeFile(path.join(documents, 'note.md'), '# Note\n', 'utf8');
  const history = createDesktopHistory({ documentsDirectory: documents, settingsDirectory: path.join(root, 'Settings', 'Stilltime'), historyDirectory: snapshotDirectory, now: () => new Date('2026-01-02T12:00:00') });
  const first = await history.createSnapshot();
  await writeFile(first, 'corrupted');
  const recovered = await history.createSnapshot();
  assert.notEqual(recovered, first);
  assert.equal((await history.verifySnapshot(recovered)).valid, true);
  await history.createSnapshot({ externalDirectory });
  const external = path.join(externalDirectory, path.basename(recovered));
  assert.equal((await history.verifySnapshot(external)).valid, true);
  await writeFile(external, 'corrupted external copy');
  await history.createSnapshot({ externalDirectory });
  assert.equal((await history.verifySnapshot(external)).valid, true);
});

test('external retention never removes snapshots from another data root', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reversewear-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const external = path.join(root, 'USB');
  const createRootHistory = async label => {
    const documents = path.join(root, label, 'Documents');
    await mkdir(documents, { recursive: true });
    const settings = path.join(root, label, 'Settings', 'Stilltime');
    return createDesktopHistory({
      documentsDirectory: documents,
      settingsDirectory: settings,
      historyDirectory: path.join(root, label, 'Runtime', 'History'),
      now: () => new Date(`2026-02-${String(day).padStart(2, '0')}T12:00:00`),
    });
  };
  let day = 1;
  const first = await createRootHistory('First');
  const second = await createRootHistory('Second');
  for (day = 1; day <= 16; day++) {
    await first.createSnapshot({ externalDirectory: external });
    await second.createSnapshot({ externalDirectory: external });
  }
  const snapshots = await Promise.all((await readdir(external)).filter(name => name.startsWith('daily-')).map(async name => ({ name, ...(await first.verifySnapshot(path.join(external, name))) })));
  assert.equal(snapshots.length, 28);
  assert.equal(new Set(snapshots.map(item => item.origin)).size, 2);
});

test('Git history contains only explicitly accepted Markdown and restores a selected revision', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reversewear-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documents = path.join(root, 'Documents');
  const file = path.join(documents, 'Notes', 'idea.md');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '# Version one\n', 'utf8');
  const history = createDesktopHistory({ documentsDirectory: documents, settingsDirectory: path.join(root, 'Settings', 'Stilltime'), historyDirectory: path.join(root, 'Runtime', 'History') });
  assert.deepEqual(await history.recordAcceptedFiles([file], 'baseline'), { committed: true, files: ['Notes/idea.md'] });
  const versions = await history.listRecordHistory('Notes/idea.md');
  assert.equal(versions.length, 1);
  await writeFile(file, '# Version two\n', 'utf8');
  await history.recordAcceptedFiles([file], 'accept edit');
  assert.equal((await history.listRecordHistory('Notes/idea.md')).length, 2);
  await history.restoreRecord('Notes/idea.md', versions[0].revision);
  assert.equal(await readFile(file, 'utf8'), '# Version one\n');
  const outside = path.join(root, 'outside.md');
  await writeFile(outside, 'outside', 'utf8');
  await assert.rejects(history.recordAcceptedFiles([outside]), /只允许 Documents 内/);
});

test('Git history rejects foreign repo config and never runs Markdown filters', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reversewear-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documents = path.join(root, 'Documents');
  const historyDirectory = path.join(root, 'Runtime', 'History');
  await mkdir(path.join(documents, 'Notes'), { recursive: true });
  await mkdir(path.join(documents, 'MarkdownGit'), { recursive: true });
  const note = path.join(documents, 'Notes', 'idea.md');
  const attributes = path.join(documents, '.gitattributes');
  await writeFile(attributes, '*.md filter=malicious\n', 'utf8');
  await writeFile(note, '# Raw content\n', 'utf8');
  const history = createDesktopHistory({ documentsDirectory: documents, settingsDirectory: path.join(root, 'Settings', 'Stilltime'), historyDirectory });
  await history.recordAcceptedFiles([note]);
  const revision = (await history.listRecordHistory('Notes/idea.md'))[0].revision;
  await writeFile(note, '# Modified\n', 'utf8');
  await history.restoreRecord('Notes/idea.md', revision);
  assert.equal(await readFile(note, 'utf8'), '# Raw content\n');

  const foreignRoot = path.join(root, 'OtherRuntime', 'History');
  const foreignRepo = path.join(foreignRoot, 'MarkdownGit');
  await mkdir(foreignRepo, { recursive: true });
  const foreignConfig = '[core]\n\tbare = true\n\tsshCommand = "malicious"\n';
  await writeFile(path.join(foreignRepo, 'config'), foreignConfig, 'utf8');
  const foreign = createDesktopHistory({ documentsDirectory: documents, settingsDirectory: path.join(root, 'Settings', 'Stilltime'), historyDirectory: foreignRoot });
  await assert.rejects(foreign.ensureGitReady(), /缺少有效的工作台标记/);
  assert.equal(await readFile(path.join(foreignRepo, 'config'), 'utf8'), foreignConfig);
});
