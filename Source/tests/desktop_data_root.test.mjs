import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveDataRoot, saveDataPointer } from '../desktop_data_root.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ReverseWear-data-root-'));
  await mkdir(path.join(root, 'settings'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const makeRoot = async (...parts) => {
    const result = path.join(root, ...parts);
    await mkdir(result, { recursive: true });
    return result;
  };
  return { root, makeRoot };
}

test('portable Notes take precedence and stay discoverable after the application folder moves', async t => {
  const { root, makeRoot } = await fixture(t);
  const pointerFile = path.join(root, 'settings', 'data-root.json');
  const legacyRoot = await makeRoot('legacy');
  const firstLauncher = await makeRoot('portable-old');
  await mkdir(path.join(firstLauncher, 'Documents', 'Notes'), { recursive: true });
  await saveDataPointer(pointerFile, legacyRoot, { portableDirectory: firstLauncher });

  const movedLauncher = await makeRoot('新环境', 'V22');
  await cp(path.join(firstLauncher, 'Documents'), path.join(movedLauncher, 'Documents'), { recursive: true });

  const result = await resolveDataRoot({ pointerFile, portableDirectory: movedLauncher, defaultDataRoot: legacyRoot });
  assert.equal(result.root, movedLauncher);
  assert.equal(result.portable, true);
  assert.equal(result.source, 'portable');
});

test('portable override applies only to its launcher directory and adjacent data can be explicitly selected', async t => {
  const { root, makeRoot } = await fixture(t);
  const pointerFile = path.join(root, 'settings', 'data-root.json');
  const legacyRoot = await makeRoot('legacy');
  const launcher = await makeRoot('launcher');
  const selectedRoot = await makeRoot('selected');
  await saveDataPointer(pointerFile, legacyRoot);
  await saveDataPointer(pointerFile, selectedRoot, { portableDirectory: launcher });

  const current = await resolveDataRoot({ pointerFile, portableDirectory: launcher, defaultDataRoot: legacyRoot });
  assert.equal(current.root, selectedRoot);
  assert.equal(current.source, 'override');

  const moved = await makeRoot('moved-launcher');
  const afterMove = await resolveDataRoot({ pointerFile, portableDirectory: moved, defaultDataRoot: legacyRoot });
  assert.equal(afterMove.root, legacyRoot);
  assert.equal(afterMove.source, 'legacy');

  await mkdir(path.join(launcher, 'Documents', 'Notes'), { recursive: true });
  await saveDataPointer(pointerFile, launcher, { portableDirectory: launcher });
  const automatic = await resolveDataRoot({ pointerFile, portableDirectory: launcher, defaultDataRoot: legacyRoot });
  assert.equal(automatic.root, launcher);
  assert.equal(automatic.source, 'portable');
  assert.equal(automatic.portable, true);
  const pointer = JSON.parse(await readFile(pointerFile, 'utf8'));
  assert.equal(pointer.root, legacyRoot, 'launcher-scoped selection preserves the shared legacy pointer');
  assert.deepEqual(pointer.portableOverrides, {}, 'selecting a launcher with Notes clears its stale override');
});

test('legacy pointer remains active when no portable Notes folder exists', async t => {
  const { root, makeRoot } = await fixture(t);
  const pointerFile = path.join(root, 'settings', 'data-root.json');
  const legacyRoot = await makeRoot('legacy');
  const launcher = await makeRoot('launcher');
  await saveDataPointer(pointerFile, legacyRoot);

  const result = await resolveDataRoot({ pointerFile, portableDirectory: launcher, defaultDataRoot: path.join(root, 'default') });
  assert.equal(result.root, legacyRoot);
  assert.equal(result.portable, false);
  assert.equal(result.source, 'legacy');
});

test('without a portable launcher the saved legacy root is used', async t => {
  const { root, makeRoot } = await fixture(t);
  const pointerFile = path.join(root, 'settings', 'data-root.json');
  const legacyRoot = await makeRoot('legacy');
  await saveDataPointer(pointerFile, legacyRoot);

  const result = await resolveDataRoot({ pointerFile });
  assert.equal(result.root, legacyRoot);
  assert.equal(result.portable, false);
  assert.equal(result.source, 'legacy');
});

test('an existing but malformed portable Notes directory is reported for recovery', async t => {
  const { root, makeRoot } = await fixture(t);
  const pointerFile = path.join(root, 'settings', 'data-root.json');
  const legacyRoot = await makeRoot('legacy');
  const launcher = await makeRoot('launcher');
  await mkdir(path.join(launcher, 'Documents'), { recursive: true });
  await writeFile(path.join(launcher, 'Documents', 'Notes'), 'not a directory');
  await saveDataPointer(pointerFile, legacyRoot);

  await assert.rejects(
    resolveDataRoot({ pointerFile, portableDirectory: launcher, defaultDataRoot: legacyRoot }),
    /便携笔记目录结构异常/,
  );
  const pointer = JSON.parse(await readFile(pointerFile, 'utf8'));
  assert.equal(pointer.root, legacyRoot);
});

test('a matching explicit launcher override works when its adjacent Notes folder is malformed', async t => {
  const { root, makeRoot } = await fixture(t);
  const pointerFile = path.join(root, 'settings', 'data-root.json');
  const launcher = await makeRoot('launcher');
  const selectedRoot = await makeRoot('selected');
  await mkdir(path.join(launcher, 'Documents'), { recursive: true });
  await writeFile(path.join(launcher, 'Documents', 'Notes'), 'not a directory');
  await saveDataPointer(pointerFile, selectedRoot, { portableDirectory: launcher });

  const result = await resolveDataRoot({ pointerFile, portableDirectory: launcher });
  assert.equal(result.root, selectedRoot);
  assert.equal(result.source, 'override');
  assert.equal(result.portable, false);
});

test('valid same-directory Notes are recognized even when the host pointer is unreadable', async t => {
  const { root, makeRoot } = await fixture(t);
  const pointerFile = path.join(root, 'settings', 'data-root.json');
  const launcher = await makeRoot('新环境', 'V22');
  await mkdir(path.join(launcher, 'Documents', 'Notes'), { recursive: true });
  await writeFile(pointerFile, '{broken json');

  const result = await resolveDataRoot({ pointerFile, portableDirectory: launcher });
  assert.equal(result.root, launcher);
  assert.equal(result.source, 'portable');
  assert.equal(result.portable, true);
});

test('a chooser selection recovers a malformed pointer and scopes the new root to this launcher', async t => {
  const { root, makeRoot } = await fixture(t);
  const pointerFile = path.join(root, 'settings', 'data-root.json');
  const launcher = await makeRoot('launcher');
  const legacyRoot = await makeRoot('legacy');
  const selectedRoot = await makeRoot('selected');
  await writeFile(pointerFile, '{broken json');

  await assert.rejects(resolveDataRoot({
    pointerFile, portableDirectory: launcher, defaultDataRoot: legacyRoot,
  }));
  await saveDataPointer(pointerFile, selectedRoot, {
    portableDirectory: launcher, defaultDataRoot: legacyRoot,
  });
  const result = await resolveDataRoot({
    pointerFile, portableDirectory: launcher, defaultDataRoot: legacyRoot,
  });
  assert.equal(result.root, selectedRoot);
  const pointer = JSON.parse(await readFile(pointerFile, 'utf8'));
  assert.equal(pointer.root, legacyRoot);
  assert.equal(pointer.portableOverrides[launcher], selectedRoot);
});

test('selecting a legacy root preserves unknown pointer fields and portable overrides', async t => {
  const { root, makeRoot } = await fixture(t);
  const pointerFile = path.join(root, 'settings', 'data-root.json');
  const oldRoot = await makeRoot('old');
  const nextRoot = await makeRoot('next');
  const launcher = await makeRoot('launcher');
  await writeFile(pointerFile, JSON.stringify({
    root: oldRoot,
    portableOverrides: { [launcher]: oldRoot },
    otherSetting: { keep: true },
  }));

  await saveDataPointer(pointerFile, nextRoot);
  const pointer = JSON.parse(await readFile(pointerFile, 'utf8'));
  assert.equal(pointer.root, nextRoot);
  assert.deepEqual(pointer.portableOverrides, { [launcher]: oldRoot });
  assert.deepEqual(pointer.otherSetting, { keep: true });
});

test('portable directory aliases collapse to one canonical override key', async t => {
  const { root, makeRoot } = await fixture(t);
  const pointerFile = path.join(root, 'settings', 'data-root.json');
  const launcher = await makeRoot('launcher');
  const selectedRoot = await makeRoot('selected');
  const oldKey = launcher.toUpperCase();
  await writeFile(pointerFile, JSON.stringify({
    root: selectedRoot,
    portableOverrides: { [launcher]: oldKey, [oldKey]: oldKey },
  }));

  await saveDataPointer(pointerFile, selectedRoot, { portableDirectory: launcher });
  const pointer = JSON.parse(await readFile(pointerFile, 'utf8'));
  assert.equal(Object.keys(pointer.portableOverrides).length, 1);
  assert.equal(pointer.portableOverrides[launcher], selectedRoot);
});
