import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { isManagedMarkdown } from './desktop_records.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const zipMagic = { local: 0x04034b50, central: 0x02014b50, end: 0x06054b50 };
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[n] = value >>> 0;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function put16(buffer, offset, value) { buffer.writeUInt16LE(value, offset); }
function put32(buffer, offset, value) { buffer.writeUInt32LE(value >>> 0, offset); }
function digest(data) { return createHash('sha256').update(data).digest('hex'); }

function safeZipPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') || /[\u0000-\u001f]/.test(value) || value.startsWith('/') || /^[a-z]:/i.test(value)) return false;
  const parts = value.split('/');
  return parts.every(part => part && part !== '.' && part !== '..');
}

function relativePathOverlap(first, second) {
  const relative = path.relative(path.resolve(first), path.resolve(second));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, rawData] of entries) {
    if (!safeZipPath(name)) throw new Error(`ZIP 中包含无效路径：${name}`);
    const nameBytes = encoder.encode(name);
    const data = Buffer.from(rawData);
    const compressed = deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    put32(local, 0, zipMagic.local);
    put16(local, 4, 20);
    put16(local, 6, 0x0800);
    put16(local, 8, 8);
    put32(local, 14, crc);
    put32(local, 18, compressed.length);
    put32(local, 22, data.length);
    put16(local, 26, nameBytes.length);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    put32(central, 0, zipMagic.central);
    put16(central, 4, 0x0314);
    put16(central, 6, 20);
    put16(central, 8, 0x0800);
    put16(central, 10, 8);
    put32(central, 16, crc);
    put32(central, 20, compressed.length);
    put32(central, 24, data.length);
    put16(central, 28, nameBytes.length);
    put32(central, 42, offset);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  put32(end, 0, zipMagic.end);
  put16(end, 8, entries.length);
  put16(end, 10, entries.length);
  put32(end, 12, centralDirectory.length);
  put32(end, 16, offset);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function readZip(buffer) {
  const limit = Math.max(0, buffer.length - 65557);
  let endOffset = -1;
  for (let index = buffer.length - 22; index >= limit; index--) {
    if (buffer.readUInt32LE(index) === zipMagic.end) { endOffset = index; break; }
  }
  if (endOffset < 0) throw new Error('ZIP 目录损坏。');
  const count = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  let cursor = buffer.readUInt32LE(endOffset + 16);
  if (cursor + centralSize > endOffset) throw new Error('ZIP 目录超出文件范围。');
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(cursor) !== zipMagic.central) throw new Error('ZIP 文件条目损坏。');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    if ((flags & 1) || ![0, 8].includes(method)) throw new Error('ZIP 使用了不支持的加密或压缩方式。');
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = decoder.decode(buffer.subarray(cursor + 46, cursor + 46 + nameLength));
    if (!safeZipPath(name) || entries.has(name)) throw new Error(`ZIP 路径无效或重复：${name}`);
    if (buffer.readUInt32LE(localOffset) !== zipMagic.local) throw new Error(`ZIP 文件头损坏：${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    if (compressed.length !== compressedSize) throw new Error(`ZIP 数据截断：${name}`);
    const data = method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`ZIP 校验失败：${name}`);
    entries.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function walkFiles(root, include, descend = () => true) {
  const result = [];
  let actualRoot;
  try { actualRoot = await realpath(root); } catch (error) { if (error.code === 'ENOENT') return result; throw error; }
  const pending = [actualRoot];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const file = path.join(directory, entry.name);
      const info = await lstat(file);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory() && descend(path.relative(actualRoot, file))) pending.push(file);
      else if (info.isFile() && include(file)) {
        const actual = await realpath(file);
        const relative = path.relative(actualRoot, actual);
        if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)) result.push({ file: actual, relative });
      }
    }
  }
  return result.sort((a, b) => a.relative.localeCompare(b.relative));
}

function gitEnvironment() {
  const environment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
  };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_COUNT']) delete environment[key];
  return environment;
}

async function ensureSafeDirectory(directory) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`目录路径包含重解析点或非目录：${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(current);
    }
    const actual = await realpath(current);
    if (process.platform === 'win32' ? actual.toLowerCase() !== current.toLowerCase() : actual !== current) {
      throw new Error(`目录解析后发生变化：${current}`);
    }
  }
  return absolute;
}

async function ensureNoReparsePoints(root) {
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw new Error(`历史仓库包含重解析点：${candidate}`);
      if (info.isDirectory()) pending.push(candidate);
    }
  }
}

export function createDesktopHistory({ documentsDirectory, settingsDirectory, historyDirectory, now = () => new Date() }) {
  const documents = path.resolve(documentsDirectory);
  const settings = path.resolve(settingsDirectory);
  const history = path.resolve(historyDirectory);
  const snapshots = path.join(history, 'Snapshots');
  const gitDirectory = path.join(history, 'MarkdownGit');
  const gitTemplate = path.join(history, 'GitTemplate');
  const gitIdentityName = 'reversewear.identity.json';
  const gitConfig = '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = true\n';
  const gitMarker = JSON.stringify({ schema: 1, format: 'bare-sha1', documentsDirectory: path.resolve(documents) });
  const origin = digest(encoder.encode(JSON.stringify([documents.toLowerCase(), settings.toLowerCase()])));

  async function runGit(args, { input, indexFile } = {}) {
    try {
      const environment = gitEnvironment();
      if (indexFile) environment.GIT_INDEX_FILE = indexFile;
      return execFileSync('git', [
        '-c', 'core.hooksPath=NUL', '-c', 'core.autocrlf=false',
        '--git-dir', gitDirectory, ...args,
      ], { input, encoding: input ? undefined : 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: environment, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('未找到 Git。ZIP 快照仍可使用，请安装 Git 后再启用 Markdown 历史记录。');
      throw new Error(`Markdown 历史记录失败：${String(error.stderr || error.message).trim()}`);
    }
  }

  async function gitReady() {
    try { execFileSync('git', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], env: gitEnvironment(), windowsHide: true }); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('未找到 Git。ZIP 快照仍可使用，请安装 Git 后再启用 Markdown 历史记录。');
      throw new Error(`无法检查 Git：${String(error.stderr || error.message).trim()}`);
    }
    await ensureSafeDirectory(history);
    if (relativePathOverlap(history, documents) || relativePathOverlap(history, settings)) throw new Error('历史与快照目录不能放在 Documents 或设置目录内部。');
    await ensureSafeDirectory(path.dirname(gitDirectory));
    await ensureSafeDirectory(gitTemplate);
    const repoExists = await lstat(gitDirectory).then(info => {
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Markdown 历史目录是重解析点或非目录。');
      return true;
    }).catch(error => error.code === 'ENOENT' ? false : Promise.reject(error));
    if (!repoExists) {
      const staging = path.join(history, `.MarkdownGit-${randomUUID()}.pending`);
      try {
        execFileSync('git', ['-c', `init.templateDir=${gitTemplate}`, 'init', '--bare', '--object-format=sha1', staging], {
          stdio: ['ignore', 'pipe', 'pipe'], env: gitEnvironment(), windowsHide: true,
        });
        await writeFile(path.join(staging, gitIdentityName), gitMarker, { encoding: 'utf8', flag: 'wx' });
        await writeFile(path.join(staging, 'config'), gitConfig, 'utf8');
        await writeFile(path.join(staging, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
        if (await lstat(gitDirectory).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))) throw new Error('Markdown 历史目录已被其他程序创建。');
        await rename(staging, gitDirectory);
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(() => {});
        if (error.code === 'ENOENT') throw new Error('未找到 Git。ZIP 快照仍可使用，请安装 Git 后再启用 Markdown 历史记录。');
        throw new Error(`无法建立隔离的 Markdown 历史仓库：${String(error.stderr || error.message).trim()}`);
      }
    } else {
      const markerInfo = await lstat(path.join(gitDirectory, gitIdentityName)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!markerInfo || markerInfo.isSymbolicLink()) throw new Error('Markdown 历史目录缺少有效的工作台标记，已停止使用以避免改动外部 Git 仓库。');
      if ((await readFile(path.join(gitDirectory, gitIdentityName), 'utf8')) !== gitMarker) throw new Error('Markdown 历史目录属于其他数据位置或版本。');
      const configInfo = await lstat(path.join(gitDirectory, 'config')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!configInfo || configInfo.isSymbolicLink() || (await readFile(path.join(gitDirectory, 'config'), 'utf8')) !== gitConfig) throw new Error('Markdown 历史配置与工作台预期不符，已停止使用。');
      const headInfo = await lstat(path.join(gitDirectory, 'HEAD'));
      if (headInfo.isSymbolicLink() || (await readFile(path.join(gitDirectory, 'HEAD'), 'utf8')) !== 'ref: refs/heads/main\n') throw new Error('Markdown 历史 HEAD 无效。');
    }
    for (const child of ['objects', 'refs']) {
      const info = await lstat(path.join(gitDirectory, child));
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Markdown 历史组件无效：${child}`);
    }
    await ensureNoReparsePoints(gitDirectory);
  }

  async function createSnapshot({ reason = 'daily', externalDirectory } = {}) {
    await ensureSafeDirectory(snapshots);
    const created = now();
    const stamp = created.toISOString().replace(/[:.]/g, '-');
    const day = [created.getFullYear(), String(created.getMonth() + 1).padStart(2, '0'), String(created.getDate()).padStart(2, '0')].join('-');
    const daily = reason === 'daily';
    if (daily) {
      const existing = await readdir(snapshots).catch(() => []);
      const matches = existing.filter(name => name.startsWith(`daily-${day}-`) && name.endsWith('.zip')).sort().reverse();
      for (const match of matches) {
        const prior = path.join(snapshots, match);
        const priorSummary = await verifySnapshot(prior).catch(() => null);
        if (priorSummary?.reason === 'daily' && priorSummary.origin === origin) {
          if (externalDirectory) {
            await copyVerifiedSnapshot(prior, externalDirectory, match);
            await rotateDailySnapshots(await realpath(externalDirectory));
          }
          await rotateDailySnapshots(snapshots);
          return prior;
        }
      }
    }
    const entries = [];
    const manifest = [];
    for (const item of await walkFiles(
      documents,
      file => path.extname(file).toLowerCase() === '.md' && isManagedMarkdown(path.relative(documents, file)),
      relative => {
        const parts = relative.split(path.sep);
        const category = parts[0]?.toLowerCase();
        if (parts.length === 1) return ['links', 'notes', 'daily', 'weekly', 'memos', 'experiments', 'files', 'inbox', 'ideas', 'linknotes', 'linkssnapshots',
          'plans', 'inspirationboard', 'weeklyreviews', 'lifeexperiences', 'moodjournal', 'thinkingpages', 'contentboard', 'templates', 'customareas', 'vocabulary',
          'terminology'].includes(category);
        if (['links', 'notes', 'daily', 'weekly', 'memos'].includes(category)) return true;
        if (parts.length >= 2 && category === 'linknotes') return /^(?:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}|[a-f\d]{16})$/i.test(parts[1]);
        if (parts.length === 2 && ['linknotes', 'linkssnapshots'].includes(category)) return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$|^[a-f0-9]{16}$/i.test(parts[1]);
        if (parts.length === 2 && category === 'plans') return ['daily', 'weekly'].includes(parts[1].toLowerCase());
        return false;
      },
    )) {
      const data = await readFile(item.file);
      const name = `Documents/${item.relative.split(path.sep).join('/')}`;
      entries.push([name, data]);
      manifest.push({ path: name, sha256: digest(data), size: data.length });
    }
    for (const item of await walkFiles(settings, file => ['settings.json', 'appearance.json', 'risk-preferences.json', 'link-organization.json'].includes(path.basename(file)))) {
      const data = await readFile(item.file);
      const name = `Settings/${path.basename(settings)}/${item.relative.split(path.sep).join('/')}`;
      entries.push([name, data]);
      manifest.push({ path: name, sha256: digest(data), size: data.length });
    }
    const metadata = Buffer.from(JSON.stringify({ schema: 1, origin, createdAt: created.toISOString(), reason, files: manifest }, null, 2) + '\n');
    entries.push(['manifest.json', metadata]);
    const zip = createZip(entries);
    validateSnapshotEntries(readZip(zip));
    const filename = `${daily ? 'daily' : 'manual'}-${daily ? day : stamp}-${randomUUID()}.zip`;
    const target = path.join(snapshots, filename);
    const pending = `${target}.pending`;
    await writeFile(pending, zip, { flag: 'wx' });
    await rename(pending, target);
    const verification = await verifySnapshot(target).catch(error => ({ valid: false, error }));
    if (!verification.valid) {
      await unlink(target).catch(() => {});
      throw new Error(`快照写入后校验失败，已移除无效文件：${verification.error?.message ?? ''}`);
    }
    if (externalDirectory) await copyVerifiedSnapshot(target, externalDirectory, filename);
    if (daily) await rotateDailySnapshots(snapshots);
    if (daily && externalDirectory) await rotateDailySnapshots(await realpath(externalDirectory));
    return target;
  }

  async function rotateDailySnapshots(directory) {
    const candidates = (await readdir(directory)).filter(name => /^daily-\d{4}-\d{2}-\d{2}-.+\.zip$/.test(name)).sort().reverse();
    const verified = [];
    for (const name of candidates) {
      const file = path.join(directory, name);
      const info = await lstat(file).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) continue;
      const summary = await verifySnapshot(file).catch(() => null);
      if (summary?.reason === 'daily' && summary.origin === origin) verified.push(file);
    }
    for (const old of verified.slice(14)) await unlink(old);
  }

  async function copyVerifiedSnapshot(source, externalDirectory, filename) {
    await verifySnapshot(source);
    await ensureSafeDirectory(externalDirectory);
    const externalRoot = await realpath(externalDirectory);
    if (relativePathOverlap(history, externalRoot)) throw new Error('异盘快照目录必须位于本地历史目录之外。');
    const externalFile = path.join(externalRoot, filename);
    const externalInfo = await lstat(externalFile).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (externalInfo?.isSymbolicLink() || (externalInfo && !externalInfo.isFile())) throw new Error('异盘备份目标存在重解析点或非文件。');
    const externalPending = `${externalFile}.${randomUUID()}.pending`;
    try {
      await copyFile(source, externalPending);
      await verifySnapshot(externalPending);
      await rename(externalPending, externalFile);
      await verifySnapshot(externalFile);
    } finally { await unlink(externalPending).catch(() => {}); }
  }

  async function verifySnapshot(file) {
    const { files, ...summary } = validateSnapshotEntries(readZip(await readFile(file)));
    return summary;
  }

  function validateSnapshotEntries(entries) {
    const raw = entries.get('manifest.json');
    if (!raw) throw new Error('快照没有清单。');
    const manifest = JSON.parse(raw.toString('utf8'));
    if (manifest.schema !== 1 || !Array.isArray(manifest.files)) throw new Error('快照清单版本无效。');
    const files = new Map();
    for (const item of manifest.files) {
      if (!safeZipPath(item.path) || !['Documents/', 'Settings/'].some(prefix => item.path.startsWith(prefix)) || files.has(item.path)) throw new Error(`快照路径越界或重复：${item.path}`);
      const data = entries.get(item.path);
      if (!data || data.length !== item.size || digest(data) !== item.sha256) throw new Error(`快照内容校验失败：${item.path}`);
      files.set(item.path, item.sha256);
    }
    if (entries.size !== manifest.files.length + 1) throw new Error('快照包含未登记的文件。');
    if (!/^[a-f0-9]{64}$/i.test(manifest.origin ?? '')) throw new Error('快照缺少有效的数据源标识。');
    return { valid: true, origin: manifest.origin, createdAt: manifest.createdAt, reason: manifest.reason, count: manifest.files.length, files };
  }

  async function listSnapshots() {
    await ensureSafeDirectory(snapshots);
    const result = [];
    for (const name of (await readdir(snapshots)).filter(value => value.endsWith('.zip')).sort().reverse()) {
      const file = path.join(snapshots, name);
      try { result.push({ name, file, ...(await verifySnapshot(file)) }); }
      catch (error) { result.push({ name, file, valid: false, error: error.message }); }
    }
    return result;
  }

  async function restoreSnapshot(file, destination) {
    const backup = await readFile(file);
    const entries = readZip(backup);
    const verified = validateSnapshotEntries(entries);
    if (!verified.valid) throw new Error('快照尚未通过校验。');
    const target = path.resolve(destination);
    await ensureSafeDirectory(path.dirname(target));
    const targetInfo = await lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (targetInfo?.isSymbolicLink() || (targetInfo && !targetInfo.isDirectory())) throw new Error('恢复目标必须是实际目录，现有路径未被改动。');
    if (targetInfo && (await readdir(target)).length) throw new Error('恢复目标必须是空目录，现有文件未被改动。');
    const staging = path.join(path.dirname(target), `.${path.basename(target)}-${randomUUID()}.restore`);
    await mkdir(staging);
    try {
      for (const [name, data] of entries) {
        if (name === 'manifest.json') continue;
        const parts = name.split('/');
        const relative = parts[0] === 'Documents'
          ? path.join('Documents', ...parts.slice(1))
          : path.join('Settings', ...parts.slice(1));
        const output = path.resolve(staging, relative);
        const rel = path.relative(staging, output);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`恢复路径越界：${name}`);
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, data, { flag: 'wx' });
        if (digest(await readFile(output)) !== verified.files.get(name)) throw new Error(`恢复后文件校验失败：${name}`);
      }
      if (targetInfo) await rmdir(target);
      await rename(staging, target);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return { destination: target, count: verified.count };
  }

  async function recordAcceptedFiles(files, message = 'Accepted AI changes') {
    const actualRoot = await realpath(documents);
    const staged = [];
    const contentsByPath = new Map();
    for (const candidate of files) {
      const actual = await realpath(candidate);
      const relative = path.relative(actualRoot, actual);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.extname(actual).toLowerCase() !== '.md' || !(await stat(actual)).isFile()) {
        throw new Error(`Git 历史只允许 Documents 内的 Markdown 文件：${candidate}`);
      }
      const gitPath = relative.split(path.sep).join('/');
      staged.push(gitPath);
      contentsByPath.set(gitPath, await readFile(actual));
    }
    if (!staged.length) return { committed: false };
    await gitReady();
    const indexDirectory = await ensureSafeDirectory(path.join(history, 'Indexes'));
    const indexFile = path.join(indexDirectory, `${randomUUID()}.index`);
    let parent = null;
    try { parent = (await runGit(['rev-parse', '--verify', 'refs/heads/main'])).trim(); }
    catch { /* A new repository has no branch yet. */ }
    try {
      if (parent) await runGit(['read-tree', parent], { indexFile });
      else await runGit(['read-tree', '--empty'], { indexFile });
      for (const relativePath of staged) {
        const blob = (await runGit(['hash-object', '-w', '--stdin'], { input: contentsByPath.get(relativePath) })).toString().trim();
        await runGit(['update-index', '--add', '--cacheinfo', `100644,${blob},${relativePath}`], { indexFile });
      }
      const tree = (await runGit(['write-tree'], { indexFile })).trim();
      if (parent && (await runGit(['rev-parse', `${parent}^{tree}`])).trim() === tree) return { committed: false };
      const commitArgs = ['-c', 'user.name=ReverseWear Workbench', '-c', 'user.email=local@reversewear.invalid', 'commit-tree', tree];
      if (parent) commitArgs.push('-p', parent);
      commitArgs.push('-m', String(message).slice(0, 120));
      const revision = (await runGit(commitArgs, { input: Buffer.alloc(0) })).toString().trim();
      await runGit(['update-ref', 'refs/heads/main', revision, parent ?? '0000000000000000000000000000000000000000']);
    } finally {
      await unlink(indexFile).catch(() => {});
      await unlink(indexFile + '.lock').catch(() => {});
    }
    return { committed: true, files: staged };
  }

  async function recordAcceptedRelativePath(relativePath, message) {
    if (!safeZipPath(relativePath)) throw new Error('历史记录相对路径无效。');
    const candidate = path.resolve(documents, ...relativePath.split('/'));
    return recordAcceptedFiles([candidate], message ?? `Accepted AI change: ${relativePath}`);
  }

  async function listRecordHistory(relativePath) {
    if (!safeZipPath(relativePath) || path.extname(relativePath).toLowerCase() !== '.md') throw new Error('历史记录只支持相对路径 Markdown 文件。');
    await gitReady();
    const output = await runGit(['log', '--format=%H%x09%aI%x09%s', 'refs/heads/main', '--', relativePath]);
    return output.trim() ? output.trimEnd().split(/\r?\n/).map(line => {
      const [revision, createdAt, ...title] = line.split('\t');
      return { revision, createdAt, title: title.join('\t') };
    }) : [];
  }

  async function restoreRecord(relativePath, revision) {
    if (!safeZipPath(relativePath) || path.extname(relativePath).toLowerCase() !== '.md') throw new Error('恢复只支持相对路径 Markdown 文件。');
    if (typeof revision !== 'string' || !/^[a-f0-9]{40}$/i.test(revision)) throw new Error('Git 版本编号无效。');
    await gitReady();
    const actualRoot = await realpath(documents);
    const target = path.resolve(actualRoot, ...relativePath.split('/'));
    const relative = path.relative(actualRoot, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('恢复目标越界。');
    const existing = await readFile(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing) await recordAcceptedFiles([target], `Before restore: ${relativePath}`);
    const currentHash = existing ? digest(existing) : null;
    const contents = await runGit(['show', `${revision}:${relativePath}`]);
    if (currentHash !== null && digest(await readFile(target)) !== currentHash) throw new Error('恢复期间原文件发生修改，已保留最新内容。');
    const pending = `${target}.${randomUUID()}.restore`;
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await writeFile(pending, contents, { flag: 'wx' });
      await rename(pending, target);
    } finally { await unlink(pending).catch(() => {}); }
    await recordAcceptedFiles([target], `Restored ${relativePath}`);
    return { relativePath, revision };
  }

  return { ensureGitReady: gitReady, createSnapshot, verifySnapshot, listSnapshots, restoreSnapshot, recordAcceptedFiles, recordAcceptedRelativePath, listRecordHistory, restoreRecord };
}
