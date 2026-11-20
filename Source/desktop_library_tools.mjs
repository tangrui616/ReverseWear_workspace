import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createMarkdownIndex } from './desktop_incremental_index.mjs';

const linkIdPattern = /^(?:[0-9a-f]{16}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$/i;
const snapshotPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.md$/i;

async function checkedFolder(parent, name, create) {
  const folder = path.join(parent, name);
  if (create) await mkdir(folder).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(folder).catch(error => {
    if (!create && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink() || path.relative(folder, await realpath(folder))) {
    throw new Error('快照目录异常：' + folder);
  }
  return folder;
}

export function createLinkSnapshots(dataRoot, workbench) {
  async function locate(id, create) {
    if (typeof id !== 'string' || !linkIdPattern.test(id)) throw new Error('链接 ID 无效。');
    const link = (await workbench.listLinks()).find(item => item.id === id);
    if (!link) throw new Error('找不到链接记录。');
    const documents = await checkedFolder(await realpath(dataRoot), 'Documents', create);
    const snapshots = documents ? await checkedFolder(documents, 'LinksSnapshots', create) : null;
    return { folder: snapshots ? await checkedFolder(snapshots, id, create) : null, link };
  }
  return {
    async save(id, text) {
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 2_000_000) throw new Error('请输入正文，单份快照最大 2 MB。');
      const { folder, link } = await locate(id, true);
      const snapshotId = randomUUID();
      const created = new Date().toISOString();
      const file = path.join(folder, snapshotId + '.md');
      const temporary = file + '.pending';
      const metadata = { id: snapshotId, type: 'link-snapshot', schema: 1, linkId: id, url: link.url, created, private: true };
      const front = Object.entries(metadata).map(([key, value]) => key + ': ' + JSON.stringify(value)).join('\n');
      try {
        await writeFile(temporary, `---\n${front}\n---\n${text}`, { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, file);
      } finally {
        await unlink(temporary).catch(() => {});
      }
      return snapshotId;
    },
    async list(id) {
      const { folder } = await locate(id, false);
      if (!folder) return [];
      const records = [];
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (!entry.isFile() || !snapshotPattern.test(entry.name)) continue;
        const info = await lstat(path.join(folder, entry.name));
        if (!info.isSymbolicLink() && info.nlink === 1) records.push({ id: entry.name.slice(0, -3), date: info.birthtime.toISOString() });
      }
      return records.sort((left, right) => right.date.localeCompare(left.date));
    },
    async read(id, snapshotId) {
      const filename = typeof snapshotId === 'string' ? snapshotId + '.md' : '';
      if (!snapshotPattern.test(filename)) throw new Error('快照 ID 无效。');
      const { folder } = await locate(id, false);
      if (!folder) throw new Error('找不到快照目录。');
      const file = path.join(folder, filename);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 2_010_000) throw new Error('快照文件异常。');
      return readFile(file, 'utf8');
    },
  };
}

const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase();
const recordId = /^(?:[a-f0-9]{16}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
const inferredTypes = {
  links: 'link', notes: 'note', daily: 'daily', weekly: 'weekly', experiments: 'experiment',
  linknotes: 'link-note', linkssnapshots: 'link-snapshot', ideas: 'idea', inspirationboard: 'inspiration-board',
};

export function createLocalSearch({ documentsDirectory, cacheFile, index }) {
  const markdown = index ?? createMarkdownIndex(documentsDirectory);
  let revision = -1;
  let compiled = new Map();
  let marker;
  const search = async raw => {
    const terms = normalize(typeof raw === 'string' ? raw.slice(0, 180).trim() : '').split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const snapshot = await markdown.read();
    if (revision !== snapshot.revision) {
      const next = new Map();
      for (const entry of snapshot.entries) {
        if (compiled.get(entry.relativePath)?.entry === entry) {
          next.set(entry.relativePath, compiled.get(entry.relativePath));
          continue;
        }
        const { metadata, body } = entry.parsed;
        const relativePath = entry.relativePath;
        const category = relativePath.split(path.sep)[0].toLowerCase();
        const title = typeof metadata.title === 'string' && metadata.title ? metadata.title
          : body.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(relativePath, '.md');
        const tags = Array.isArray(metadata.tags) ? metadata.tags.join(' ') : '';
        const item = {
          id: recordId.test(metadata.id ?? '') ? metadata.id : null,
          type: metadata.type ?? metadata.kind ?? inferredTypes[category],
          title, tags, relativePath,
        };
        next.set(relativePath, {
          entry, item, body, normalizedBody: normalize(body),
          searchable: normalize([title, body, tags, metadata.url, metadata.source?.url, metadata.sourceNote,
            metadata.original, metadata.followup, metadata.special, metadata.borrow].join(' ')),
        });
      }
      compiled = next;
      revision = snapshot.revision;
    }
    if (!marker) {
      marker = (async () => {
        const previous = await readFile(cacheFile, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; });
        // Keep only a marker on disk. Searchable text and private keywords stay in memory.
        const value = '{"version":2,"mode":"memory"}';
        if (previous === value) return;
        await mkdir(path.dirname(cacheFile), { recursive: true });
        const temporary = cacheFile + '.' + randomUUID() + '.pending';
        try {
          await writeFile(temporary, value, { flag: 'wx' });
          await rename(temporary, cacheFile);
        } finally { await unlink(temporary).catch(() => {}); }
      })().catch(error => { if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error; }).finally(() => { marker = null; });
    }
    await marker;
    return [...compiled.values()].filter(value => terms.every(term => value.searchable.includes(term))).slice(0, 80).map(value => {
      const start = Math.max(0, value.normalizedBody.indexOf(terms[0]) - 50);
      return { ...value.item, snippet: value.body.slice(start, start + 240) };
    });
  };
  search.close = () => { if (!index) markdown.close(); };
  return search;
}
