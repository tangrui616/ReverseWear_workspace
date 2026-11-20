import assert from 'node:assert/strict';
import { link, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDesktopMirror } from '../desktop_mirror.mjs';
import { probeStartup } from '../main/startup-probe.mjs';

const record = (id, { private: isPrivate = false } = {}) => `---\nid: "${id}"\nschema: 1\ntitle: "测试记录"\nprivate: ${isPrivate}\n---\n\n# 测试记录\n\n## 原话\n我当时写下的原话\n\n## AI 整理\n<!-- ai:begin -->\n旧整理\n<!-- ai:end -->\n`;
const changeAiBlock = (source, text) => source.replace('旧整理', text);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reversewear-mirror-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documentsDirectory = path.join(root, 'Documents');
  const mirrorDirectory = path.join(root, 'Mirror');
  const stateDirectory = path.join(root, 'Runtime');
  await mkdir(path.join(documentsDirectory, 'Notes'), { recursive: true });
  const mirror = createDesktopMirror({ documentsDirectory, mirrorDirectory, stateDirectory });
  return { root, documentsDirectory, mirrorDirectory, stateDirectory, mirror };
}

test('镜像默认不导出，只有显式共享、ID 匹配的 Markdown 才复制', async t => {
  const f = await fixture(t);
  const original = record('note-01');
  await writeFile(path.join(f.documentsDirectory, 'Notes', 'one.md'), original);
  assert.deepEqual(await f.mirror.list(), []);
  await assert.rejects(f.mirror.share('wrong-id', 'Notes/one.md'), /ID/);
  await assert.rejects(f.mirror.share('note-01', '../secret.md'), /只允许共享/);
  await assert.rejects(f.mirror.share('note-01', 'Files/secret.md'), /受管理目录/);
  const shared = await f.mirror.share('note-01', 'Notes/one.md');
  assert.equal(shared.status, 'synced');
  assert.match(shared.mirrorPath, /Mirror/);
  assert.equal(await readFile(shared.mirrorPath, 'utf8'), original);
});

test('startup probe reports genuine pending mirror changes without reconciling files', async t => {
  const f = await fixture(t);
  const original = record('probe-note');
  const notes = path.join(f.documentsDirectory, 'Notes');
  const sourcePath = path.join(notes, 'probe.md');
  await writeFile(sourcePath, original);
  await writeFile(path.join(notes, '.hidden.md'), original);
  const { mirrorPath } = await f.mirror.share('probe-note', 'Notes/probe.md');
  await writeFile(sourcePath, changeAiBlock(original, 'only the source changed'));
  const first = await probeStartup(f.root, f.documentsDirectory, f.mirror);
  assert.deepEqual(first, {
    ok: true, dataRoot: f.root, noteCount: 1, linkCount: 0, mirror: { changed: 0, files: [], busy: false },
  });
  assert.equal(await readFile(mirrorPath, 'utf8'), original);
  const draft = changeAiBlock(original, 'external draft');
  await writeFile(mirrorPath, draft);
  const pending = await probeStartup(f.root, f.documentsDirectory, f.mirror);
  assert.deepEqual(pending.mirror.files, [path.join('Notes', 'probe.md')]);
  assert.equal(await readFile(mirrorPath, 'utf8'), draft);
  assert.match(await readFile(sourcePath, 'utf8'), /only the source changed/);
});

test('受管理 YAML plain scalar 可读取，重复或含糊隐私字段安全失败', async t => {
  const f = await fixture(t);
  const valid = '---\nid: plain-note\ntitle: Plain title\nschema: 1\nprivate: false # public\n---\n\nBody\n';
  await writeFile(path.join(f.documentsDirectory, 'Notes', 'plain.md'), valid);
  assert.equal((await f.mirror.share('plain-note', 'Notes/plain.md')).status, 'synced');
  const duplicate = '---\nid: duplicate-note\nprivate: false\nprivate: true\n---\nBody\n';
  await writeFile(path.join(f.documentsDirectory, 'Notes', 'duplicate.md'), duplicate);
  await assert.rejects(f.mirror.share('duplicate-note', 'Notes/duplicate.md'), /文件头无效/);
  const ambiguous = '---\nid: ambiguous-note\nprivate: yes\n---\nBody\n';
  await writeFile(path.join(f.documentsDirectory, 'Notes', 'ambiguous.md'), ambiguous);
  await assert.rejects(f.mirror.share('ambiguous-note', 'Notes/ambiguous.md'), /文件头无效/);
  await assert.rejects(f.mirror.share('missing-note', 'LinksSnapshots/missing.md'), /受管理目录/);
});

test('hard-linked originals and mirror drafts are rejected', async t => {
  const f = await fixture(t);
  const sourcePath = path.join(f.documentsDirectory, 'Notes', 'hardlink.md');
  await writeFile(sourcePath, record('hard-id'));
  const extraLink = path.join(f.documentsDirectory, 'Notes', 'alias.md');
  await link(sourcePath, extraLink);
  await assert.rejects(f.mirror.share('hard-id', 'Notes/hardlink.md'), /普通 Markdown 文件/);
  await rm(extraLink);
  await f.mirror.share('hard-id', 'Notes/hardlink.md');
  const mirrorFile = path.join(f.mirrorDirectory, 'Notes', 'hardlink.md');
  const mirrorAlias = path.join(f.mirrorDirectory, 'Notes', 'alias.md');
  await link(mirrorFile, mirrorAlias);
  assert.equal((await f.mirror.scanDrafts()).some(item => item.path.endsWith('alias.md')), false);
});

test('只接受 AI 区块修改，并检测审核期间的外部写入', async t => {
  const f = await fixture(t);
  const original = record('note-02');
  const sourcePath = path.join(f.documentsDirectory, 'Notes', 'two.md');
  await writeFile(sourcePath, original);
  await f.mirror.share('note-02', 'Notes/two.md');
  const mirrorPath = path.join(f.mirrorDirectory, 'Notes', 'two.md');
  await writeFile(mirrorPath, changeAiBlock(original, '新整理'));
  const pending = (await f.mirror.list())[0];
  assert.equal(pending.status, 'pending-review');
  await writeFile(mirrorPath, changeAiBlock(original, '用户审核期间改了文件'));
  await assert.rejects(f.mirror.review({ id: 'note-02', action: 'accept', expectedSourceHash: pending.sourceHash, expectedMirrorHash: pending.mirrorHash }), /已变化/);
  const refreshed = (await f.mirror.list())[0];
  await f.mirror.review({ id: 'note-02', action: 'accept', expectedSourceHash: refreshed.sourceHash, expectedMirrorHash: refreshed.mirrorHash });
  assert.match(await readFile(sourcePath, 'utf8'), /用户审核期间改了文件/);
  assert.equal((await f.mirror.list())[0].status, 'synced');
});

test('拒绝会归档 AI 版本并恢复镜像，保持原件不变', async t => {
  const f = await fixture(t);
  const original = record('note-03');
  const sourcePath = path.join(f.documentsDirectory, 'Notes', 'three.md');
  await writeFile(sourcePath, original);
  await f.mirror.share('note-03', 'Notes/three.md');
  const mirrorPath = path.join(f.mirrorDirectory, 'Notes', 'three.md');
  await writeFile(mirrorPath, changeAiBlock(original, '拒绝稿'));
  const pending = (await f.mirror.list())[0];
  const result = await f.mirror.review({ id: 'note-03', action: 'reject', expectedSourceHash: pending.sourceHash, expectedMirrorHash: pending.mirrorHash });
  assert.equal(result.status, 'rejected');
  assert.equal(await readFile(sourcePath, 'utf8'), original);
  assert.equal(await readFile(mirrorPath, 'utf8'), original);
  assert.match(await readFile(path.join(f.stateDirectory, 'rejected', result.archived), 'utf8'), /拒绝稿/);
});

test('原话、ID、私密和 .aiignore 阻止写回或撤回镜像副本', async t => {
  const f = await fixture(t);
  const sourcePath = path.join(f.documentsDirectory, 'Notes', 'four.md');
  const original = record('note-04');
  await writeFile(sourcePath, original);
  await f.mirror.share('note-04', 'Notes/four.md');
  const mirrorPath = path.join(f.mirrorDirectory, 'Notes', 'four.md');
  await writeFile(mirrorPath, changeAiBlock(original, '整理稿').replace('我当时写下的原话', '被改写的原话'));
  const pending = (await f.mirror.list())[0];
  await assert.rejects(f.mirror.review({ id: 'note-04', action: 'accept', expectedSourceHash: pending.sourceHash, expectedMirrorHash: pending.mirrorHash }), /「原话」/);
  await writeFile(sourcePath, record('note-04', { private: true }));
  assert.equal((await f.mirror.list())[0].status, 'blocked-private');
  await assert.rejects(readFile(mirrorPath), { code: 'ENOENT' });
  await writeFile(sourcePath, original);
  await writeFile(path.join(f.documentsDirectory, '.aiignore'), 'Notes/*\n');
  await assert.rejects(f.mirror.share('note-04', 'Notes/four.md'), /\.aiignore/);
});

test('隐私开关仅改 frontmatter，标为 private 后撤回镜像，取消后仍需显式共享', async t => {
  const f = await fixture(t);
  const sourcePath = path.join(f.documentsDirectory, 'Notes', 'privacy.md');
  const original = record('note-privacy');
  await writeFile(sourcePath, original);
  await f.mirror.share('note-privacy', 'Notes/privacy.md');
  const mirrorPath = path.join(f.mirrorDirectory, 'Notes', 'privacy.md');
  const privateResult = await f.mirror.setPrivate('note-privacy', true, 'Notes/privacy.md');
  assert.equal(privateResult.status, 'private');
  const marked = await readFile(sourcePath, 'utf8');
  assert.match(marked, /private: true/);
  assert.match(marked, /我当时写下的原话/);
  await assert.rejects(readFile(mirrorPath), { code: 'ENOENT' });
  assert.equal((await f.mirror.setPrivate('note-privacy', false, 'Notes/privacy.md')).status, 'public-not-shared');
  await assert.rejects(readFile(mirrorPath), { code: 'ENOENT' });
});

test('链接设为 private 时同时撤回其链接笔记草稿并归档镜像副本', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.documentsDirectory, 'Links'), { recursive: true });
  await mkdir(path.join(f.documentsDirectory, 'LinkNotes', 'link-parent'), { recursive: true });
  const linkFile = '---\nid: "link-parent"\ntype: "link"\nurl: "https://example.org"\n---\n\n# Link\n';
  await writeFile(path.join(f.documentsDirectory, 'Links', 'link.md'), linkFile);
  const note = '---\nid: "note-child"\nrelatedId: "link-parent"\n---\n\n# Analysis\n';
  await writeFile(path.join(f.documentsDirectory, 'LinkNotes', 'link-parent', 'analysis.md'), note);
  await f.mirror.share('link-parent', 'Links/link.md');
  await f.mirror.share('note-child', path.join('LinkNotes', 'link-parent', 'analysis.md'));
  await f.mirror.setPrivate('link-parent', true, 'Links/link.md');
  assert.equal((await f.mirror.list()).length, 0);
  await assert.rejects(readFile(path.join(f.mirrorDirectory, 'Links', 'link.md')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(f.mirrorDirectory, 'LinkNotes', 'link-parent', 'analysis.md')), { code: 'ENOENT' });
  assert.equal((await f.mirror.scanDrafts()).length, 0);
});

test('source-only changes refresh mirror, and mirror deletion never deletes the original', async t => {
  const f = await fixture(t);
  const original = record('note-05');
  const sourcePath = path.join(f.documentsDirectory, 'Notes', 'five.md');
  const mirrorPath = path.join(f.mirrorDirectory, 'Notes', 'five.md');
  await writeFile(sourcePath, original);
  await f.mirror.share('note-05', 'Notes/five.md');
  const updated = changeAiBlock(original, '本地修改');
  await writeFile(sourcePath, updated);
  assert.equal((await f.mirror.list())[0].status, 'synced');
  assert.equal(await readFile(mirrorPath, 'utf8'), updated);
  await rm(mirrorPath);
  assert.equal((await f.mirror.list())[0].status, 'mirror-deleted');
  assert.equal(await readFile(sourcePath, 'utf8'), updated);
  const removed = (await f.mirror.list())[0];
  await f.mirror.review({ id: 'note-05', action: 'restore-deleted', expectedSourceHash: removed.sourceHash });
  assert.equal(await readFile(mirrorPath, 'utf8'), updated);
  assert.equal((await f.mirror.list())[0].status, 'synced');
});

test('Harness busy marker pauses share and review, and explicit drafts are scoped and non-overwriting', async t => {
  const f = await fixture(t);
  const source = record('note-06');
  await writeFile(path.join(f.documentsDirectory, 'Notes', 'six.md'), source);
  await mkdir(f.mirrorDirectory, { recursive: true });
  await writeFile(path.join(f.mirrorDirectory, '.harness-busy'), 'busy');
  await assert.rejects(f.mirror.share('note-06', 'Notes/six.md'), /正在整理/);
  await rm(path.join(f.mirrorDirectory, '.harness-busy'));
  await mkdir(path.join(f.mirrorDirectory, 'Notes'), { recursive: true });
  await writeFile(path.join(f.mirrorDirectory, 'Notes', 'new.md'), '# New note\n');
  const drafts = await f.mirror.scanDrafts();
  assert.equal(drafts[0].path, path.join('Notes', 'new.md'));
  const accepted = await f.mirror.review({ action: 'accept', relativePath: drafts[0].path, expectedMirrorHash: drafts[0].hash });
  assert.equal(accepted.status, 'accepted-new');
  assert.match(await readFile(path.join(f.documentsDirectory, 'Notes', 'new.md'), 'utf8'), /schema: 1/);
  await assert.rejects(f.mirror.review({ action: 'accept', relativePath: drafts[0].path, expectedMirrorHash: drafts[0].hash }), /已存在/);
});

test('new link-note drafts require an existing public link ID', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.documentsDirectory, 'Links'), { recursive: true });
  await writeFile(path.join(f.documentsDirectory, 'Links', 'link.md'), `---\nid: "link-01"\ntype: "link"\nurl: "https://example.org"\n---\n\n# Link\n`);
  await mkdir(path.join(f.mirrorDirectory, 'LinkNotes', 'link-01'), { recursive: true });
  const draftPath = path.join(f.mirrorDirectory, 'LinkNotes', 'link-01', 'analysis.md');
  await writeFile(draftPath, '---\nrelatedId: "link-01"\n---\n\n# Analysis\n');
  const draft = (await f.mirror.scanDrafts())[0];
  const accepted = await f.mirror.review({ action: 'accept', relativePath: draft.path, expectedMirrorHash: draft.hash });
  const result = await readFile(path.join(f.documentsDirectory, accepted.path), 'utf8');
  assert.match(result, /relatedId: "link-01"/);
  assert.match(result, /id: "/);
});

test('interrupted accepted writes retain a journal and recover on next launch', async t => {
  const f = await fixture(t);
  const original = record('note-07');
  const sourcePath = path.join(f.documentsDirectory, 'Notes', 'seven.md');
  await writeFile(sourcePath, original);
  await f.mirror.share('note-07', 'Notes/seven.md');
  const mirrorPath = path.join(f.mirrorDirectory, 'Notes', 'seven.md');
  await writeFile(mirrorPath, changeAiBlock(original, 'recover this'));
  const pending = (await f.mirror.list())[0];
  let failOnce = true;
  const crashing = createDesktopMirror({
    documentsDirectory: f.documentsDirectory, mirrorDirectory: f.mirrorDirectory, stateDirectory: f.stateDirectory,
    onAccepted() { if (failOnce) { failOnce = false; throw new Error('simulated interruption'); } },
  });
  await assert.rejects(crashing.review({ id: 'note-07', action: 'accept', expectedSourceHash: pending.sourceHash, expectedMirrorHash: pending.mirrorHash }), /simulated interruption/);
  const restarted = createDesktopMirror({ documentsDirectory: f.documentsDirectory, mirrorDirectory: f.mirrorDirectory, stateDirectory: f.stateDirectory });
  assert.equal((await restarted.recover()).status, 'ready');
  assert.match(await readFile(sourcePath, 'utf8'), /recover this/);
  assert.equal((await restarted.list())[0].status, 'synced');
  await assert.rejects(readFile(path.join(f.stateDirectory, 'mirror-accept-journal.json')), { code: 'ENOENT' });
});

test('changed draft after source write remains in the journal and requires manual recovery', async t => {
  const f = await fixture(t);
  const draftPath = path.join(f.mirrorDirectory, 'Notes', 'interrupted.md');
  await mkdir(path.dirname(draftPath), { recursive: true });
  await writeFile(draftPath, '# Draft\n');
  const draft = (await f.mirror.scanDrafts())[0];
  const destination = path.join(f.documentsDirectory, 'Notes', 'interrupted.md');
  const crashing = createDesktopMirror({
    documentsDirectory: f.documentsDirectory, mirrorDirectory: f.mirrorDirectory, stateDirectory: f.stateDirectory,
    onAccepted: async () => { await writeFile(destination, '# User changed after write\n'); throw new Error('simulated crash'); },
  });
  await assert.rejects(crashing.review({ action: 'accept', relativePath: draft.path, expectedMirrorHash: draft.hash }), /simulated crash/);
  const restarted = createDesktopMirror({ documentsDirectory: f.documentsDirectory, mirrorDirectory: f.mirrorDirectory, stateDirectory: f.stateDirectory });
  await assert.rejects(restarted.recover(), /又发生变化/);
  assert.match(await readFile(destination, 'utf8'), /User changed/);
  assert.equal(await readFile(path.join(f.stateDirectory, 'mirror-accept-journal.json'), 'utf8').then(() => 'present', () => 'missing'), 'present');
});

test('filesystem watcher reports busy even with an empty baseline and suppresses partial drafts', async t => {
  const f = await fixture(t);
  let resolveChange;
  let timeout;
  const observed = new Promise((resolve, reject) => {
    resolveChange = value => { clearTimeout(timeout); resolve(value); };
    timeout = setTimeout(() => reject(new Error('mirror watch did not report file change')), 3000);
  });
  const stop = await f.mirror.watch(value => { if (value.busy) resolveChange(value); });
  t.after(() => stop());
  await writeFile(path.join(f.mirrorDirectory, '.harness-busy'), '');
  const update = await observed.then(value => { if (!value.busy) throw new Error('expected busy state'); return value; });
  assert.deepEqual(update.entries, []);
  assert.deepEqual(update.drafts, []);
});

test('conflicting edits can merge an AI-only block while retaining original metadata and user body edits', async t => {
  const f = await fixture(t);
  const original = record('note-08');
  const sourcePath = path.join(f.documentsDirectory, 'Notes', 'eight.md');
  const mirrorPath = path.join(f.mirrorDirectory, 'Notes', 'eight.md');
  await writeFile(sourcePath, original);
  await f.mirror.share('note-08', 'Notes/eight.md');
  const sourceChanged = original.replace('测试记录', '用户的新标题').replace('我当时写下的原话', '我当时写下的原话');
  await writeFile(sourcePath, sourceChanged);
  await writeFile(mirrorPath, changeAiBlock(original, 'AI 更新整理'));
  const conflict = (await f.mirror.list())[0];
  assert.equal(conflict.status, 'conflict');
  await f.mirror.review({ id: 'note-08', action: 'accept', expectedSourceHash: conflict.sourceHash, expectedMirrorHash: conflict.mirrorHash });
  const merged = await readFile(sourcePath, 'utf8');
  assert.match(merged, /title: "用户的新标题"/);
  assert.match(merged, /用户的新标题/);
  assert.match(merged, /AI 更新整理/);
  assert.equal((await f.mirror.list())[0].status, 'synced');
});

test('legacy notes without AI delimiters accept one appended AI block and retain concurrent human edits', async t => {
  const f = await fixture(t);
  const original = '---\nid: "note-legacy"\nschema: 1\ntitle: "旧笔记"\ntags: ["原标签"]\n---\n\n# 旧笔记\n\n研究原文。\n';
  const sourcePath = path.join(f.documentsDirectory, 'Notes', 'legacy.md');
  const mirrorPath = path.join(f.mirrorDirectory, 'Notes', 'legacy.md');
  await writeFile(sourcePath, original);
  await f.mirror.share('note-legacy', 'Notes/legacy.md');
  await writeFile(mirrorPath, original.trimEnd() + '\n\n<!-- ai:begin -->\n整理补充\n<!-- ai:end -->\n');
  await writeFile(sourcePath, original + '\n用户补充的内容。\n');
  const conflict = (await f.mirror.list())[0];
  assert.equal(conflict.status, 'conflict');
  await f.mirror.review({ id: 'note-legacy', action: 'accept', expectedSourceHash: conflict.sourceHash, expectedMirrorHash: conflict.mirrorHash });
  const merged = await readFile(sourcePath, 'utf8');
  assert.match(merged, /tags: \["原标签"\]/);
  assert.match(merged, /用户补充的内容/);
  assert.match(merged, /<!-- ai:begin -->\n整理补充/);
});
