import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopDictionaries } from '../desktop_dictionaries.mjs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from 'node:zlib';

function zipSingleFile(name, contents) {
  const filename = Buffer.from(name);
  const source = Buffer.from(contents);
  const compressed = deflateRawSync(source);
  const crc = crc32(source);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(source.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(source.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + compressed.length, 16);
  return Buffer.concat([local, filename, compressed, central, filename, end]);
}

async function fixture(t, dictionaryContents) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reversewear-dictionary-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dictionaries = path.join(root, 'Dictionaries');
  const cache = path.join(root, 'Cache');
  await mkdir(dictionaries);
  const db = path.join(root, 'stardict.db');
  const database = new DatabaseSync(db);
  database.exec('CREATE TABLE stardict (word TEXT, phonetic TEXT, definition TEXT, translation TEXT)');
  database.prepare('INSERT INTO stardict VALUES (?, ?, ?, ?)').run('hello', 'həˈləʊ', 'greeting', '你好');
  database.close();
  const contents = await readFile(db);
  await writeFile(path.join(dictionaries, 'ecdict-sqlite-28.zip'), zipSingleFile('stardict.db', dictionaryContents ?? contents));
  const info = await stat(path.join(dictionaries, 'ecdict-sqlite-28.zip'));
  return { dictionariesDirectory: dictionaries, cacheDirectory: cache,
    cacheFile: path.join(cache, `${info.size}-${Math.trunc(info.mtimeMs)}-stardict.db`) };
}

test('parallel dictionary services publish one reusable verified cache', async t => {
  const paths = await fixture(t);
  const first = createDesktopDictionaries(paths);
  const second = createDesktopDictionaries(paths);
  const [left, right] = await Promise.all([
    first.lookup({ text: 'hello', direction: 'en-zh' }),
    second.lookup({ text: 'hello', direction: 'en-zh' }),
  ]);
  assert.equal(left.entries[0].translations[0], '你好');
  assert.equal(right.entries[0].translations[0], '你好');
  assert.equal((await readdir(paths.cacheDirectory)).filter(name => name.endsWith('.partial')).length, 0);
  const receipt = JSON.parse(await readFile(`${paths.cacheFile}.verified.json`, 'utf8'));
  assert.equal(receipt.size, (await stat(paths.cacheFile)).size);
  first.close();
  second.close();
});

test('same-sized modified cache is rejected and atomically rebuilt', async t => {
  const paths = await fixture(t);
  const service = createDesktopDictionaries(paths);
  await service.lookup({ text: 'hello', direction: 'en-zh' });
  service.close();
  const before = await stat(paths.cacheFile);
  const handle = await import('node:fs/promises').then(fs => fs.open(paths.cacheFile, 'r+'));
  await handle.write(Buffer.from([0]), 0, 1, 0);
  await handle.close();
  await utimes(paths.cacheFile, new Date(), new Date(before.mtimeMs + 2000));
  const retry = createDesktopDictionaries(paths);
  const result = await retry.lookup({ text: 'hello', direction: 'en-zh' });
  assert.equal(result.entries[0].translations[0], '你好');
  retry.close();
});

test('SQLite cache transaction lock is released when its owner process exits', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reversewear-dictionary-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'cache.lock.sqlite');
  const readyPath = path.join(root, 'owner.ready');
  const ownerCode = `const {DatabaseSync}=require('node:sqlite');const fs=require('node:fs');const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');fs.writeFileSync(process.argv[2],'ready');setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ['-e', ownerCode, lockPath, readyPath], { stdio: 'ignore', windowsHide: true });
  t.after(() => { if (owner.exitCode === null) owner.kill(); });
  for (let attempt = 0; attempt < 100 && !await stat(readyPath).catch(() => null); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(await stat(readyPath).catch(() => null), 'owner process acquired the transaction lock');
  owner.kill();
  await new Promise(resolve => owner.once('exit', resolve));
  const nextOwner = new DatabaseSync(lockPath);
  nextOwner.exec('BEGIN IMMEDIATE');
  nextOwner.exec('ROLLBACK');
  nextOwner.close();
});
