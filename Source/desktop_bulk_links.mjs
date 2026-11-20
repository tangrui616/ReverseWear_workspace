import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { safeRelativePath, resolveFolderPath } from './desktop_folder_paths.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const LEGACY_ID = /^[a-f0-9]{16}$/i;
const hash = value => createHash('sha256').update(value).digest('hex');

async function replaceLinkFile(temp, target, expectedHash, conflictMessage) {
  const retries = process.platform === 'win32' ? [0, 30, 70, 150] : [0];
  for (let attempt = 0; attempt < retries.length; attempt += 1) {
    if (retries[attempt]) await new Promise(resolve => setTimeout(resolve, retries[attempt]));
    const info = await lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(target).catch(() => '') !== target) {
      throw new Error(`链接文件路径已变化或不安全，未覆盖：${path.basename(target)}`);
    }
    const current = await readFile(target, 'utf8');
    if (hash(current) !== expectedHash) throw new Error(conflictMessage(path.basename(target)));
    try {
      await rename(temp, target);
      return;
    } catch (error) {
      const canRetry = process.platform === 'win32' && ['EPERM', 'EBUSY'].includes(error.code) && attempt < retries.length - 1;
      if (!canRetry) throw error;
    }
  }
}

function parseFrontMatter(source) {
  const text = source.replace(/^\uFEFF/, '');
  const match = text.match(/^(---)(\r?\n)([\s\S]*?)(\r?\n)---\r?\n(?:\r?\n)?([\s\S]*)$/);
  if (!match) return null;
  const fields = new Map();
  for (const line of match[3].split(/\r?\n/)) {
    const index = line.indexOf(': ');
    if (index <= 0) continue;
    const key = line.slice(0, index);
    let value;
    try { value = JSON.parse(line.slice(index + 2)); } catch { value = line.slice(index + 2); }
    fields.set(key, value);
  }
  return { fields, body: match[5], newline: match[2], bom: source.startsWith('\uFEFF'), frontMatter: match[3] };
}

function updateFrontMatter(source, updates) {
  const parsed = parseFrontMatter(source);
  if (!parsed) throw new Error('链接 Markdown 缺少有效的元数据区块。');
  const lines = parsed.frontMatter.split(/\r?\n/);
  const remaining = new Map(Object.entries(updates));
  for (let index = 0; index < lines.length; index += 1) {
    const separator = lines[index].indexOf(': ');
    if (separator < 0) continue;
    const key = lines[index].slice(0, separator);
    if (!remaining.has(key)) continue;
    lines[index] = `${key}: ${JSON.stringify(remaining.get(key))}`;
    remaining.delete(key);
  }
  const block = `${lines.join(parsed.newline)}${remaining.size ? `${parsed.newline}${[...remaining].map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(parsed.newline)}` : ''}`;
  const bomOffset = parsed.bom ? 1 : 0;
  const start = source.indexOf('---', bomOffset) + 3 + parsed.newline.length;
  const close = source.indexOf(`${parsed.newline}---`, start);
  return `${source.slice(0, start)}${block}${source.slice(close)}`;
}

function normalizeUrl(value) {
  const url = new URL(String(value ?? '').trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('链接格式无效。');
  url.hash = '';
  return url.href;
}

function normalizeTag(value) {
  const tag = String(value ?? '').normalize('NFKC').trim().replace(/\\/g, '/').replace(/\s*\/\s*/g, '/').replace(/\/{2,}/g, '/').replace(/^\/|\/$/g, '');
  if (!tag || tag.length > 120 || tag.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('标签名称无效。');
  return tag;
}

function normalizeTags(values) {
  if (!Array.isArray(values)) throw new Error('标签列表无效。');
  return [...new Set(values.map(normalizeTag))];
}

export function createBulkLinkTools({ documentsDirectory, settingsDirectory }) {
  const linksDirectory = path.join(path.resolve(documentsDirectory), 'Links');
  const settingsRoot = path.resolve(settingsDirectory);
  const registryFile = path.join(settingsRoot, 'link-organization.json');
  const journalFile = path.join(settingsRoot, 'link-organization.pending.json');
  let queue = Promise.resolve();
  const serialize = task => { const next = queue.then(task); queue = next.catch(() => {}); return next; };

  async function readRegistry() {
    await mkdir(settingsRoot, { recursive: true });
    try {
      const value = JSON.parse(await readFile(registryFile, 'utf8'));
      if (!value || value.schema !== 1 || !value.aliases || Array.isArray(value.aliases) || typeof value.aliases !== 'object' ||
          Object.values(value.aliases).some(aliases => !Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string')) ||
          !value.primary || Array.isArray(value.primary) || typeof value.primary !== 'object' ||
          (value.undo !== null && value.undo !== undefined && (!value.undo || !Array.isArray(value.undo.files)))) {
        throw new Error('版本或结构不受支持。');
      }
      return { ...value, aliases: Object.assign(Object.create(null), value.aliases), primary: Object.assign(Object.create(null), value.primary), undo: value.undo ?? null };
    } catch (error) {
      if (error.code === 'ENOENT') return { schema: 1, aliases: {}, primary: {}, undo: null };
      throw new Error(`链接整理设置无法读取：${error.message}`);
    }
  }

  async function saveRegistry(value) {
    await mkdir(settingsRoot, { recursive: true });
    const pending = `${registryFile}.${randomUUID()}.pending`;
    try {
      await writeFile(pending, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(pending, registryFile);
    } finally { await unlink(pending).catch(() => {}); }
  }

  async function saveJournal(txId, files) {
    const pending = `${journalFile}.${randomUUID()}.pending`;
    try {
      await writeFile(pending, `${JSON.stringify({ schema: 1, txId, files })}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(pending, journalFile);
    } finally { await unlink(pending).catch(() => {}); }
  }

  async function recoverJournal() {
    const journal = await readFile(journalFile, 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw new Error(`链接整理中断记录无法读取：${error.message}`);
    });
    if (!journal) return;
    if (journal.schema !== 1 || !Array.isArray(journal.files)) throw new Error('链接整理中断记录格式无效，请保留文件并联系支持。');
    const registry = await readRegistry();
    if (journal.txId && registry.lastTxId === journal.txId) {
      await unlink(journalFile);
      return;
    }
    const root = await realpath(linksDirectory);
    const restore = [];
    const conflicts = [];
    for (const entry of journal.files) {
      const relative = safeRelativePath(entry.path ?? entry.file);
      if (!relative || !relative.toLowerCase().endsWith('.md')) {
        conflicts.push(String(entry.file));
        continue;
      }
      const file = await resolveFolderPath(root, relative).catch(() => null);
      if (!file) { conflicts.push(relative); continue; }
      const info = await lstat(file).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(file).catch(() => '') !== file) {
        conflicts.push(entry.file);
        continue;
      }
      const current = await readFile(file, 'utf8').catch(() => null);
      if (current === null || (hash(current) !== entry.beforeHash && hash(current) !== entry.afterHash)) conflicts.push(entry.file);
      else if (hash(current) === entry.afterHash) restore.push({ file, before: entry.before, beforeHash: entry.afterHash });
    }
    if (conflicts.length) throw new Error(`链接整理上次中断且文件已有新修改，未自动恢复：${conflicts.join(', ')}`);
    for (const item of restore) {
      const pending = `${item.file}.${randomUUID()}.recovery`;
      try {
        await writeFile(pending, item.before, { encoding: 'utf8', flag: 'wx' });
        await replaceLinkFile(pending, item.file, item.beforeHash, name => `恢复期间链接被修改，未覆盖：${name}`);
      } finally { await unlink(pending).catch(() => {}); }
    }
    await unlink(journalFile);
  }

  async function loadLinks() {
    await mkdir(linksDirectory, { recursive: true });
    await recoverJournal();
    const root = await realpath(linksDirectory);
    if (path.resolve(root) !== linksDirectory) throw new Error('Links 目录包含重解析路径。');
    const links = [];
    async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) { await scan(await resolveFolderPath(root, path.relative(root, path.join(directory, entry.name)).split(path.sep).join('/'))); continue; }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const info = await lstat(file);
      const actual = await realpath(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || actual !== file) continue;
      const source = await readFile(file, 'utf8');
      const parsed = parseFrontMatter(source);
      if (!parsed) continue;
      const metadata = Object.fromEntries(parsed.fields);
      if (metadata.type !== 'link' || !(UUID.test(metadata.id ?? '') || LEGACY_ID.test(metadata.id ?? ''))) continue;
      try {
        const info = await stat(file);
        links.push({ id: metadata.id, title: typeof metadata.title === 'string' ? metadata.title : '', url: normalizeUrl(metadata.url), tags: Array.isArray(metadata.tags) ? normalizeTags(metadata.tags.filter(tag => typeof tag === 'string')) : [], status: typeof metadata.status === 'string' ? metadata.status : 'organized', readLater: metadata.readLater === true, updatedAt: info.mtime.toISOString(), file, relativePath: path.relative(root, file).split(path.sep).join('/'), source, parsed, metadata });
      } catch { /* Keep malformed links out of bulk operations. */ }
    }
    }
    await scan(root);
    return links;
  }

  async function commitFiles(changes, registry, previousAliases, previousPrimary) {
    const staged = [];
    const applied = [];
    let journalWritten = false;
    let txId;
    try {
      for (const change of changes) {
        const info = await lstat(change.file);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(change.file) !== change.file) throw new Error(`链接文件路径不安全：${path.basename(change.file)}`);
        const current = await readFile(change.file, 'utf8');
        if (hash(current) !== change.beforeHash) throw new Error(`链接在整理期间已被外部修改：${path.basename(change.file)}`);
        const temp = `${change.file}.${randomUUID()}.pending`;
        await writeFile(temp, change.after, { encoding: 'utf8', flag: 'wx' });
        staged.push({ ...change, temp });
      }
      if (staged.length) {
        txId = randomUUID();
        await saveJournal(txId, staged.map(item => ({ file: path.basename(item.file), path: path.relative(linksDirectory, item.file).split(path.sep).join('/'), before: item.before, beforeHash: item.beforeHash, afterHash: hash(item.after) })));
        journalWritten = true;
      }
      for (const change of staged) {
        await replaceLinkFile(change.temp, change.file, change.beforeHash, name => `链接在整理期间已被外部修改：${name}`);
        change.temp = null;
        applied.push(change);
      }
      const registryChanged = JSON.stringify(previousAliases) !== JSON.stringify(registry.aliases ?? {});
      if (changes.length || registryChanged) registry.undo = {
        kind: changes.length ? 'bulk' : 'registry', createdAt: new Date().toISOString(),
        files: changes.map(item => ({ file: path.basename(item.file), path: path.relative(linksDirectory, item.file).split(path.sep).join('/'),
          before: item.before, beforeHash: item.beforeHash, afterHash: hash(item.after) })),
        previousAliases,
        afterAliases: structuredClone(registry.aliases ?? {}),
        previousPrimary: structuredClone(previousPrimary ?? {}),
        afterPrimary: structuredClone(registry.primary ?? {}),
      };
      if (txId) registry.lastTxId = txId;
      await saveRegistry(registry);
      if (journalWritten) await unlink(journalFile);
      return changes.length;
    } catch (error) {
      if (txId) {
        const currentRegistry = await readRegistry().catch(() => null);
        if (currentRegistry?.lastTxId === txId) {
          await unlink(journalFile).catch(() => {});
          return changes.length;
        }
      }
      for (const change of applied.reverse()) {
        const current = await readFile(change.file, 'utf8').catch(() => null);
        if (current === null || hash(current) !== hash(change.after)) continue;
        const rollback = `${change.file}.${randomUUID()}.rollback`;
        try {
          await writeFile(rollback, change.before, { encoding: 'utf8', flag: 'wx' });
          await replaceLinkFile(rollback, change.file, hash(change.after), name => `回滚期间链接已被外部修改，未覆盖：${name}`);
        } finally { await unlink(rollback).catch(() => {}); }
      }
      if (journalWritten) {
        const remainsApplied = await Promise.all(staged.map(async change => {
          const current = await readFile(change.file, 'utf8').catch(() => null);
          return current !== null && hash(current) !== change.beforeHash;
        }));
        if (!remainsApplied.some(Boolean)) await unlink(journalFile).catch(() => {});
      }
      throw error;
    } finally {
      for (const change of staged) if (change.temp) await unlink(change.temp).catch(() => {});
    }
  }

  function duplicateKey(url) {
    const parsed = new URL(url);
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.href;
  }

  return {
    listLinks() {
      return serialize(async () => {
        const [links, registry] = await Promise.all([loadLinks(), readRegistry()]);
        const groups = new Map();
        for (const link of links) {
          const key = duplicateKey(link.url);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(link);
        }
        const summaries = links.map(({ file, source, parsed, metadata, ...link }) => link);
        const tagNames = [...new Set([...links.flatMap(link => link.tags), ...Object.keys(registry.aliases ?? {})])].sort((a, b) => a.localeCompare(b, 'zh-CN'));
        return {
          items: summaries,
          canUndo: Boolean(registry.undo),
          tags: tagNames.map(name => ({ name, aliases: Object.hasOwn(registry.aliases, name) ? registry.aliases[name] : [] })),
          duplicateGroups: [...groups].filter(([, items]) => items.length > 1).map(([canonicalUrl, items]) => {
            const primaryId = items.some(item => item.id === registry.primary?.[canonicalUrl]) ? registry.primary[canonicalUrl] : items[0].id;
            return { canonicalUrl, primaryId, items: items.map(({ file, source, parsed, metadata, ...item }) => item) };
          }),
        };
      });
    },

    bulkTag({ ids, add = [], remove = [] } = {}) {
      return serialize(async () => {
        if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw new Error('请选择要整理的链接。');
        const selectedIds = new Set(ids);
        const additions = normalizeTags(add);
        const removals = new Set(normalizeTags(remove));
        const links = await loadLinks();
        const selected = links.filter(link => selectedIds.has(link.id));
        if (selected.length !== selectedIds.size) throw new Error('部分链接已不存在，请刷新列表后重试。');
        const changes = selected.map(link => {
          const tags = [...new Set([...link.tags.filter(tag => !removals.has(tag)), ...additions])];
          if (JSON.stringify(tags) === JSON.stringify(link.tags)) return null;
          const after = updateFrontMatter(link.source, { tags, updatedAt: new Date().toISOString() });
          return { file: link.file, before: link.source, beforeHash: hash(link.source), after };
        }).filter(Boolean);
        const registry = await readRegistry();
        const changed = await commitFiles(changes, registry, structuredClone(registry.aliases ?? {}), structuredClone(registry.primary ?? {}));
        return { changed };
      });
    },

    renameTag({ from, to } = {}) {
      return serialize(async () => {
        const sourceTag = normalizeTag(from);
        const targetTag = normalizeTag(to);
        if (sourceTag === targetTag) return { changed: 0 };
        const links = await loadLinks();
        const registry = await readRegistry();
        const previousAliases = structuredClone(registry.aliases ?? {});
        const previousPrimary = structuredClone(registry.primary ?? {});
        const belongsToTag = tag => tag === sourceTag || tag.startsWith(`${sourceTag}/`);
        const changes = links.filter(link => link.tags.some(belongsToTag)).map(link => {
          const tags = [...new Set(link.tags.map(tag => belongsToTag(tag) ? `${targetTag}${tag.slice(sourceTag.length)}` : tag))];
          const after = updateFrontMatter(link.source, { tags, updatedAt: new Date().toISOString() });
          return { file: link.file, before: link.source, beforeHash: hash(link.source), after };
        }).filter(change => change.before !== change.after);
        for (const name of Object.keys(registry.aliases ?? {})) {
          if (!Object.hasOwn(registry.aliases, name)) continue;
          if (!belongsToTag(name)) continue;
          const renamed = `${targetTag}${name.slice(sourceTag.length)}`;
          const oldAliases = registry.aliases[name];
          delete registry.aliases[name];
          registry.aliases[renamed] = [...new Set([...(registry.aliases[renamed] ?? []), ...oldAliases])];
        }
        const changed = await commitFiles(changes, registry, previousAliases, previousPrimary);
        return { changed };
      });
    },

    saveTagAliases({ tag, aliases = [] } = {}) {
      return serialize(async () => {
        const name = normalizeTag(tag);
        const normalized = normalizeTags(aliases).filter(value => value.toLocaleLowerCase() !== name.toLocaleLowerCase());
        const registry = await readRegistry();
        const previousAliases = structuredClone(registry.aliases ?? {});
        if (JSON.stringify(previousAliases[name] ?? []) === JSON.stringify(normalized)) return { name, aliases: normalized };
        Object.defineProperty(registry.aliases, name, { value: normalized, writable: true, enumerable: true, configurable: true });
        registry.undo = { kind: 'registry', createdAt: new Date().toISOString(), files: [], previousAliases, afterAliases: structuredClone(registry.aliases), previousPrimary: structuredClone(registry.primary ?? {}), afterPrimary: structuredClone(registry.primary ?? {}) };
        await saveRegistry(registry);
        return { name, aliases: normalized };
      });
    },

    setPrimary({ canonicalUrl, primaryId } = {}) {
      return serialize(async () => {
        const key = duplicateKey(normalizeUrl(canonicalUrl));
        const links = await loadLinks();
        const group = links.filter(link => duplicateKey(link.url) === key);
        if (group.length < 2 || !group.some(link => link.id === primaryId)) throw new Error('所选主链接不属于这组重复链接。');
        const registry = await readRegistry();
        if (registry.primary[key] === primaryId) return { canonicalUrl: key, primaryId };
        const previousPrimary = structuredClone(registry.primary ?? {});
        registry.primary[key] = primaryId;
        registry.undo = { kind: 'registry', createdAt: new Date().toISOString(), files: [], previousAliases: structuredClone(registry.aliases ?? {}), afterAliases: structuredClone(registry.aliases ?? {}), previousPrimary, afterPrimary: structuredClone(registry.primary) };
        await saveRegistry(registry);
        return { canonicalUrl: key, primaryId };
      });
    },

    undo() {
      return serialize(async () => {
        await recoverJournal();
        const registry = await readRegistry();
        const previous = registry.undo;
        if (!previous) return { undone: false, conflicts: [] };
        const conflicts = [];
        if (JSON.stringify(registry.aliases ?? {}) !== JSON.stringify(previous.afterAliases ?? {})) conflicts.push('link-organization.json');
        if (JSON.stringify(registry.primary ?? {}) !== JSON.stringify(previous.afterPrimary ?? {})) conflicts.push('link-organization.json');
        const restore = [];
        for (const entry of previous.files) {
          const requestedPath = safeRelativePath(entry.path ?? path.basename(entry.file));
          let file = await resolveFolderPath(linksDirectory, requestedPath).catch(() => null);
          let current = file ? await readFile(file, 'utf8').catch(() => null) : null;
          if (!current || hash(current) !== entry.afterHash) {
            const before = parseFrontMatter(entry.before ?? '');
            const id = before?.fields.get('id');
            const candidates = await loadLinks();
            const matches = candidates.filter(link => (id && link.id === id) || hash(link.source) === entry.afterHash);
            if (matches.length === 1) { file = matches[0].file; current = matches[0].source; }
          }
          if (!file || !current || hash(current) !== entry.afterHash) { conflicts.push(entry.file); continue; }
          const info = await lstat(file).catch(() => null);
          if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(file).catch(() => '') !== file) {
            conflicts.push(entry.file);
            continue;
          }
          const latest = await readFile(file, 'utf8').catch(() => null);
          if (latest === null || hash(latest) !== entry.afterHash) conflicts.push(entry.file);
          else restore.push({ file, current: latest, before: entry.before, beforeHash: entry.afterHash });
        }
        if (conflicts.length) return { undone: false, conflicts };
        const staged = [];
        let journalWritten = false;
        const txId = restore.length ? randomUUID() : null;
        try {
          for (const item of restore) {
            const info = await lstat(item.file);
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(item.file) !== item.file) throw new Error(`链接文件路径不安全：${path.basename(item.file)}`);
            const temp = `${item.file}.${randomUUID()}.pending`;
            await writeFile(temp, item.before, { encoding: 'utf8', flag: 'wx' });
            staged.push({ ...item, temp });
          }
          if (staged.length) {
            await saveJournal(txId, staged.map(item => ({ file: path.basename(item.file), path: path.relative(linksDirectory, item.file).split(path.sep).join('/'), before: item.current, beforeHash: hash(item.current), afterHash: hash(item.before) })));
            journalWritten = true;
          }
          for (const item of staged) {
            await replaceLinkFile(item.temp, item.file, item.beforeHash, name => `撤销期间链接已被外部修改：${name}`);
            item.temp = null;
          }
          registry.undo = null;
          registry.aliases = previous.previousAliases ?? {};
          registry.primary = previous.previousPrimary ?? {};
          if (txId) registry.lastTxId = txId;
          await saveRegistry(registry);
          if (journalWritten) await unlink(journalFile);
          return { undone: true, conflicts: [] };
        } catch (error) {
          if (journalWritten) {
            const currentRegistry = await readRegistry().catch(() => null);
            if (currentRegistry?.lastTxId === txId) {
              await unlink(journalFile).catch(() => {});
              return { undone: true, conflicts: [] };
            }
            await recoverJournal().catch(() => {});
          }
          throw error;
        } finally {
          for (const item of staged) if (item.temp) await unlink(item.temp).catch(() => {});
        }
      });
    },
  };
}
