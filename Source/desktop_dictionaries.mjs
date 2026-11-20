import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { crc32, createInflateRaw } from 'node:zlib';

const sources = {
  'en-zh': { archive: 'ecdict-sqlite-28.zip', member: 'stardict.db', name: 'ECDICT', limit: 1024 ** 3 },
  'zh-en': { archive: 'cedict_1_0_ts_utf-8_mdbg.zip', member: 'cedict_ts.u8', name: 'CC-CEDICT', limit: 32 * 1024 ** 2 },
};
const normalize = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
export const translationDirection = (text, direction) => Object.hasOwn(sources, direction)
  ? direction : /^\p{Script=Han}/u.test(String(text ?? '').replace(/^[\p{P}\p{S}\s]+/u, '')) ? 'zh-en' : 'en-zh';

async function locateZipMember(file, name, limit) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    async function read(length, offset) {
      if (length < 0 || offset < 0 || offset + length > size) throw new Error('词典压缩包目录损坏。');
      const buffer = Buffer.alloc(length);
      if ((await handle.read(buffer, 0, length, offset)).bytesRead !== length) throw new Error('词典压缩包读取不完整。');
      return buffer;
    }
    const tail = await read(Math.min(size, 65557), Math.max(0, size - 65557));
    let end = tail.length - 22;
    while (end >= 0 && (tail.readUInt32LE(end) !== 0x06054b50 || end + 22 + tail.readUInt16LE(end + 20) !== tail.length)) end--;
    if (end < 0) throw new Error('未找到词典压缩包目录。');
    const length = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    if (length > 4 * 1024 ** 2 || offset + length > size - tail.length + end) throw new Error('词典压缩包目录超出范围。');
    const directory = await read(length, offset);
    let cursor = 0;
    while (cursor + 46 <= directory.length && directory.readUInt32LE(cursor) === 0x02014b50) {
      const nameLength = directory.readUInt16LE(cursor + 28);
      const next = cursor + 46 + nameLength + directory.readUInt16LE(cursor + 30) + directory.readUInt16LE(cursor + 32);
      if (next > directory.length) break;
      if (directory.toString('utf8', cursor + 46, cursor + 46 + nameLength) === name) {
        const method = directory.readUInt16LE(cursor + 10);
        const crc = directory.readUInt32LE(cursor + 16);
        const compressed = directory.readUInt32LE(cursor + 20);
        const expected = directory.readUInt32LE(cursor + 24);
        const localOffset = directory.readUInt32LE(cursor + 42);
        const header = await read(30, localOffset);
        const start = localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
        if (header.readUInt32LE(0) !== 0x04034b50 || directory.readUInt16LE(cursor + 8) & 1 ||
            ![0, 8].includes(method) || expected > limit || !expected || !compressed || start + compressed > offset) {
          throw new Error('词典压缩包条目无效。');
        }
        return { method, start, compressed, expected, crc };
      }
      cursor = next;
    }
    throw new Error(`压缩包缺少词典文件 ${name}。`);
  } finally { await handle.close(); }
}

async function extractDictionary(file, destination, source) {
  const { method, start, compressed, expected, crc } = await locateZipMember(file, source.member, source.limit);
  const receiptPath = `${destination}.verified.json`;
  async function verifiedCache() {
    const cached = await stat(destination).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (cached?.size !== expected) return false;
    const receipt = await readFile(receiptPath, 'utf8').then(JSON.parse).catch(() => null);
    return receipt?.size === expected && receipt.crc === crc &&
      receipt.mtimeMs === cached.mtimeMs && receipt.ctimeMs === cached.ctimeMs;
  }
  if (await verifiedCache()) return destination;
  const lockPath = `${destination}.lock.sqlite`;
  const lock = new DatabaseSync(lockPath);
  for (let attempt = 0; ; attempt += 1) {
    try {
      lock.exec('BEGIN IMMEDIATE');
      break;
    } catch (error) {
      if (![5, 6].includes(error.errcode & 0xff)) {
        lock.close();
        throw error;
      }
      if (attempt >= 900) {
        lock.close();
        throw new Error(`等待词典缓存事务锁超时：${lockPath}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  const temporary = `${destination}.partial`;
  const receiptTemporary = `${receiptPath}.partial`;
  let readBytes = 0;
  let checksum = 0;
  const validator = new Transform({
    transform(chunk, _encoding, callback) {
      readBytes += chunk.length;
      if (readBytes > expected) return callback(new Error('词典解压大小超出预期。'));
      checksum = crc32(chunk, checksum);
      callback(null, chunk);
    },
    flush(callback) {
      callback(readBytes === expected && checksum === crc ? null : new Error('词典压缩包内容校验失败。'));
    },
  });
  const decompression = method === 8 ? [createInflateRaw()] : [];
  try {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await unlink(receiptTemporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (await verifiedCache()) return destination;
    const cached = await stat(destination).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    let matchesArchive = false;
    if (cached?.size === expected) {
      let cachedCrc = 0;
      for await (const chunk of createReadStream(destination)) cachedCrc = crc32(chunk, cachedCrc);
      matchesArchive = cachedCrc === crc;
    }
    if (!matchesArchive) {
      await pipeline(createReadStream(file, { start, end: start + compressed - 1 }), ...decompression,
        validator, createWriteStream(temporary, { flags: 'wx' }));
      await rename(temporary, destination);
    }
    const info = await stat(destination);
    await writeFile(receiptTemporary, JSON.stringify({ size: expected, crc, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }));
    await rename(receiptTemporary, receiptPath);
    return destination;
  } finally {
    await unlink(temporary).catch(() => {});
    await unlink(receiptTemporary).catch(() => {});
    lock.close();
  }
}

function readCedict(contents) {
  const dictionary = new Map();
  for (const line of contents.split(/\r?\n/)) {
    const match = /^([^\s#]+) ([^\s]+) \[([^\]]+)\] \/(.+)\/$/.exec(line);
    if (!match) continue;
    const [, traditional, simplified, phonetic, senses] = match;
    const entry = { word: simplified, traditional, simplified, phonetic, definitions: [],
      translations: senses.split('/'), source: 'CC-CEDICT' };
    for (const key of new Set([traditional, simplified].map(normalize))) {
      if (!dictionary.has(key)) dictionary.set(key, []);
      dictionary.get(key).push(entry);
    }
  }
  return term => (dictionary.get(term) ?? []).slice(0, 12);
}

export function createDesktopDictionaries({ dictionariesDirectory, cacheDirectory }) {
  const readers = new Map();
  let database;
  async function load(direction) {
    const source = sources[direction];
    const archive = path.join(dictionariesDirectory, source.archive);
    const info = await stat(archive).catch(error => {
      if (error.code === 'ENOENT') throw new Error(`未找到词典 ${archive}。`);
      throw error;
    });
    await mkdir(cacheDirectory, { recursive: true });
    const file = await extractDictionary(archive,
      path.join(cacheDirectory, `${info.size}-${Math.trunc(info.mtimeMs)}-${source.member}`), source);
    if (direction === 'zh-en') return readCedict(await readFile(file, 'utf8'));
    const candidate = new DatabaseSync(file, { readOnly: true, allowExtension: false });
    try {
      candidate.exec('PRAGMA trusted_schema = OFF');
      const find = candidate.prepare('SELECT word, phonetic, definition, translation FROM stardict WHERE word = ? COLLATE NOCASE LIMIT 12');
      database = candidate;
      const split = value => String(value ?? '').split(/\r?\n|\\n/).map(entry => entry.trim()).filter(Boolean);
      return query => find.all(query).map(row => ({
        word: row.word, phonetic: row.phonetic ?? '', definitions: split(row.definition),
        translations: split(row.translation), source: 'ECDICT',
      }));
    } catch (error) { candidate.close(); throw error; }
  }
  return {
    async lookup({ text, direction } = {}) {
      if (typeof text !== 'string' || !text.trim() || text.length > 512) throw new Error('请输入 1–512 个字符的单词或短语。');
      const start = performance.now();
      const query = normalize(text).replace(/^[“”"‘’'「『(（]+|[“”"‘’'」』)）。.!！?？,，;；]+$/g, '').trim();
      direction = translationDirection(query, direction);
      if (!readers.has(direction)) {
        readers.set(direction, load(direction).catch(error => { readers.delete(direction); throw error; }));
      }
      const entries = (await readers.get(direction))(query);
      return { query, direction, entries, elapsedMs: performance.now() - start };
    },
    close() { database?.close(); },
  };
}
