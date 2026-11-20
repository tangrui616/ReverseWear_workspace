import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createResearchStore } from '../research-store.mjs';
import { createWorkbenchStore } from '../workbench-store.mjs';

test('link and note edits preserve private, schema and extension frontmatter', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reversewear-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createWorkbenchStore(root);
  const link = (await store.saveLink({ url: 'https://example.com', title: 'Article' })).item;
  const linkFile = path.join(root, 'Documents', 'Links', `${link.id}.md`);
  let raw = await readFile(linkFile, 'utf8');
  raw = raw.replace('---\n\n', 'private: true\nschema: 1\ncustomField: "preserve"\n---\n\n');
  await writeFile(linkFile, raw, 'utf8');
  await store.saveLink({ id: link.id, url: 'https://example.com', title: 'Edited' });
  const savedLink = await readFile(linkFile, 'utf8');
  assert.match(savedLink, /private: true/);
  assert.match(savedLink, /schema: 1/);
  assert.match(savedLink, /customField: "preserve"/);

  const note = await store.saveNote({ kind: 'note', date: '2026-11-14', title: 'Record', body: 'body' });
  const noteFile = path.join(root, 'Documents', 'Notes', `2026-11-14-${note.id}.md`);
  raw = await readFile(noteFile, 'utf8');
  raw = raw.replace('---\n\n', 'private: true\nschema: 1\ncustomField: "preserve"\n---\n\n');
  await writeFile(noteFile, raw, 'utf8');
  await store.saveNote({ ...note, title: 'Edited record' });
  const savedNote = await readFile(noteFile, 'utf8');
  assert.match(savedNote, /private: true/);
  assert.match(savedNote, /customField: "preserve"/);
});

test('experiment and plan edits preserve schema and metadata and retain stable IDs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reversewear-research-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createResearchStore(root);
  const experiment = await store.saveExperiment({ name: 'Study', date: '2026-11-14', progress: 5 });
  const defaultExperimentFile = path.join(root, 'Documents', 'Experiments', `${experiment.id}.md`);
  const experimentFile = path.join(root, 'Documents', 'Experiments', 'renamed-study.md');
  await rename(defaultExperimentFile, experimentFile);
  let raw = await readFile(experimentFile, 'utf8');
  raw = raw.replace('---\n\n', 'schema: 1\nprivate: true\ncustomField: "preserve"\n---\n\n');
  await writeFile(experimentFile, raw, 'utf8');
  const loaded = (await store.listExperiments())[0];
  await store.saveExperiment({ ...loaded, progress: 6 });
  const savedExperiment = await readFile(experimentFile, 'utf8');
  await assert.rejects(stat(defaultExperimentFile), { code: 'ENOENT' });
  assert.match(savedExperiment, /schema: 1/);
  assert.match(savedExperiment, /private: true/);
  assert.match(savedExperiment, /customField: "preserve"/);
  assert.match(savedExperiment, new RegExp(`id: "${experiment.id}"`));

  await store.mutatePlan({ period: 'day', date: '2026-11-14', action: 'add', text: 'task' });
  const planFile = path.join(root, 'Documents', 'Plans', 'Daily', '2026-11-14.md');
  raw = await readFile(planFile, 'utf8');
  raw = raw.replace('---\n\n', 'schema: 1\ncustomField: "preserve"\n---\n\n');
  await writeFile(planFile, raw, 'utf8');
  const plan = await store.getPlan({ period: 'day', date: '2026-11-14' });
  await store.mutatePlan({ period: 'day', date: '2026-11-14', action: 'toggle', id: plan.tasks[0].id, done: true });
  const savedPlan = await readFile(planFile, 'utf8');
  assert.match(savedPlan, /schema: 1/);
  assert.match(savedPlan, /customField: "preserve"/);
  assert.match(savedPlan, /id: "[a-f0-9]{32}"/);
});

test('notes reject stale edits and link notes preserve their file, metadata, and relationship', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reversewear-note-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createWorkbenchStore(root);
  const note = await store.saveNote({ kind: 'note', date: '2026-11-14', title: 'First', body: 'original' });
  const loadedNote = (await store.listNotes({ kind: 'note' }))[0];
  assert.equal(loadedNote.contentHash, note.contentHash);
  await store.saveNote({ ...loadedNote, body: 'external update' });
  await assert.rejects(store.saveNote({ ...loadedNote, body: 'stale editor', expectedContentHash: loadedNote.contentHash }), /其他位置修改/);

  const link = (await store.saveLink({ url: 'https://example.com/article', title: 'Article' })).item;
  const { folder } = await store.linkWorkspace(link.id);
  const fileName = '11111111-2222-4333-8444-555555555555.md';
  const filePath = path.join(folder, fileName);
  await writeFile(filePath, `---\nid: "11111111-2222-4333-8444-555555555555"\nschema: 1\ntype: "link-note"\nrelatedId: "${link.id}"\ntitle: "Research"\nprivate: true\ncustomField: "keep"\n---\n\nold body`, 'utf8');
  const existing = await store.getLinkNote(link.id, fileName);
  const saved = await store.saveLinkNote({ linkId: link.id, name: existing.name, title: 'Updated', date: '2026-11-15', tags: ['paper'], body: 'new body', expectedContentHash: existing.expectedContentHash });
  assert.equal(saved.name, fileName);
  assert.equal(saved.relatedId, link.id);
  assert.match(await readFile(filePath, 'utf8'), /private: true/);
  assert.match(await readFile(filePath, 'utf8'), /customField: "keep"/);
  assert.equal((await store.getLinkNote(link.id, fileName)).body, 'new body');
  await assert.rejects(store.saveLinkNote({ linkId: link.id, name: existing.name, body: 'stale body', expectedContentHash: existing.expectedContentHash }), /其他位置修改/);
  const created = await store.saveLinkNote({ linkId: link.id, title: 'New note', body: 'draft content' });
  assert.equal(created.relatedId, link.id);
  assert.match((await store.readLinkNote(link.id, created.name)), /draft content/);
});

