import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { removeOwnedWork, runStorageCommand } from '../qa/test-storage.mjs';

test('storage pruning only removes marked successful work directories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rw-storage-'));
  const work = path.join(root, 'TestWork');
  const report = path.join(root, 'Reports');
  const cache = path.join(root, 'Cache');
  await Promise.all([mkdir(work), mkdir(report), mkdir(cache)]);
  const run = path.join(work, 'Run_CodexV1-run');
  const success = path.join(run, 'success');
  const failure = path.join(run, 'failure');
  const unmarked = path.join(run, 'unmarked');
  const emptyRun = path.join(work, 'Run_CodexV1-unmarked');
  await Promise.all([mkdir(success, { recursive: true }), mkdir(failure, { recursive: true }),
    mkdir(unmarked, { recursive: true }), mkdir(emptyRun)]);
  await writeFile(path.join(success, '.reversewear-test-work.json'), JSON.stringify({ schema: 1, status: 'passed' }));
  await writeFile(path.join(failure, '.reversewear-test-work.json'), JSON.stringify({ schema: 1, status: 'failed' }));
  const originalLog = console.log;
  console.log = () => {};
  try {
    await runStorageCommand({ reportsRoot: report, workRoot: work, dictionaryCache: cache, apply: false, prune: true });
    await access(success);
    await runStorageCommand({ reportsRoot: report, workRoot: work, dictionaryCache: cache, apply: true, prune: true });
  } finally { console.log = originalLog; }
  await assert.rejects(access(success));
  await access(failure);
  await access(unmarked);
  await access(emptyRun);
  await rm(root, { recursive: true, force: true });
});

test('successful work removal rejects paths outside the work root and failed markers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rw-storage-'));
  const work = path.join(root, 'TestWork');
  const failed = path.join(work, 'Run_CodexV1-failed', 'failed');
  await mkdir(failed, { recursive: true });
  await writeFile(path.join(failed, '.reversewear-test-work.json'), JSON.stringify({ schema: 1, status: 'failed' }));
  await assert.rejects(removeOwnedWork(failed, work), /成功运行标记/);
  await assert.rejects(removeOwnedWork(root, work), /超出测试临时目录范围/);
  await rm(root, { recursive: true, force: true });
});
