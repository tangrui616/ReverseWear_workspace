import { watch } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseRecordMarkdown } from './desktop_records.mjs';

const categories = new Set(['links', 'notes', 'daily', 'weekly', 'memos', 'experiments', 'linknotes', 'linkssnapshots', 'ideas', 'inspirationboard', 'weeklyreviews',
  'lifeexperiences', 'moodjournal', 'thinkingpages', 'contentboard', 'templates', 'customareas']);
const nestedCategories = new Set(['links', 'notes', 'daily', 'weekly', 'memos', 'linknotes']);
const recordId = /^(?:[a-f\d]{16}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i;
const missing = error => error.code === 'ENOENT' || error.code === 'ENOTDIR';
const exists = file => lstat(file, { bigint: true }).catch(error => { if (!missing(error)) throw error; return null; });
const isDirectory = info => info?.isDirectory() && !info.isSymbolicLink();
const stamp = info => [info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');

function searchablePath(relative) {
  const parts = relative.split(path.sep);
  const category = parts[0].toLowerCase();
  const validDepth = category === 'linknotes' ? parts.length >= 3 && recordId.test(parts[1])
    : nestedCategories.has(category) ? parts.length >= 2
      : parts.length === (category === 'linkssnapshots' ? 3 : 2);
  return categories.has(category) && validDepth
    && /\.md$/i.test(parts.at(-1)) && !/(?:\.tmp|\.pending|\.swp|\.crdownload)(?:\.md)?$|~(?:\.md)?$/i.test(parts.at(-1))
    && parts.every(part => part && part !== '..' && !part.startsWith('.'));
}

export function createMarkdownIndex(documentsDirectory, { onChange = () => {}, reconcileEvery = 30_000, scopedCategories = [...categories] } = {}) {
  const root = path.resolve(documentsDirectory);
  const entries = new Map();
  let folders = new Set();
  const dirty = new Set();
  const scoped = new Set(scopedCategories);
  let revision = 0;
  let lastScan = -Infinity;
  let rescan = true;
  let closed = false;
  let watcher;
  let timer;
  let pending;
  let snapshot = { revision, entries: [] };

  async function directoryIsSafe(directory) {
    if (!isDirectory(await exists(directory))) return false;
    const actual = await realpath(directory).catch(error => { if (!missing(error)) throw error; return null; });
    return Boolean(actual && !path.relative(directory, actual));
  }

  async function update(relative, safeParent = false) {
    const file = path.join(root, relative);
    const prior = entries.get(relative);
    const info = (safeParent || await directoryIsSafe(path.dirname(file))) ? await exists(file) : null;
    if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1n) return entries.delete(relative);
    const currentStamp = stamp(info);
    if (prior?.stamp === currentStamp) return false;
    if (path.relative(file, await realpath(file).catch(error => { if (!missing(error)) throw error; return path.dirname(file); }))) {
      return entries.delete(relative);
    }
    const raw = await readFile(file, 'utf8').catch(error => { if (!missing(error)) throw error; return null; });
    const after = await exists(file);
    if (raw === null || !after?.isFile() || after.isSymbolicLink() || after.nlink !== 1n || stamp(after) !== currentStamp) {
      invalidate(relative);
      return entries.delete(relative);
    }
    entries.set(relative, {
      relativePath: relative, stamp: currentStamp,
      parsed: parseRecordMarkdown(raw, { ordinaryNotes: relative.split(path.sep)[0]?.toLowerCase() === 'notes' }),
      updatedAt: info.mtime.toISOString(),
    });
    return true;
  }

  async function walk(directory, depth, found, foundFolders) {
    if (!await directoryIsSafe(directory)) return;
    if (foundFolders) foundFolders.add(path.relative(root, directory));
    const children = await readdir(directory, { withFileTypes: true }).catch(error => { if (!missing(error)) throw error; return []; });
    for (const child of children) {
      const file = path.join(directory, child.name);
      if (child.isDirectory() && depth > 0 && !child.name.startsWith('.')) await walk(file, depth - 1, found, foundFolders);
      const relative = path.relative(root, file);
      if (child.isFile() && searchablePath(relative)) found.push(relative);
    }
  }

  function schedule() {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void read().catch(() => { rescan = true; });
    }, 60);
    timer.unref();
  }

  function invalidate(relative, event) {
    if (closed) return;
    if (!relative) rescan = true;
    else if (path.isAbsolute(relative)) return;
    else if (!scoped.has(relative.split(path.sep)[0].toLowerCase())) return;
    else if (searchablePath(relative)) {
      dirty.add(relative);
      if (event === 'rename' && nestedCategories.has(relative.split(path.sep)[0].toLowerCase())) rescan = true;
    }
    else {
      const parts = relative.split(path.sep);
      const category = parts[0].toLowerCase();
      if (!categories.has(category) || parts.some(part => !part || part.startsWith('.'))) return;
      if (parts.length > 1 && !nestedCategories.has(category) &&
          (category !== 'linkssnapshots' || path.extname(parts[1]))) return;
      if (parts.length > 1 && /(?:\.tmp|\.pending|\.swp|\.crdownload)(?:\.md)?$|~(?:\.md)?$/i.test(parts.at(-1))) return;
      rescan = true;
    }
    schedule();
  }

  function startWatch() {
    if (closed || watcher) return;
    try {
      watcher = watch(root, { recursive: true, persistent: false }, (event, name) => invalidate(name, event));
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
        invalidate();
      });
    } catch { /* Periodic reconciliation also covers filesystems without notifications. */ }
  }

  async function sync() {
    const changed = new Set();
    const touched = [...dirty];
    dirty.clear();
    try {
      if (rescan || Date.now() - lastScan >= reconcileEvery) {
        rescan = false;
        const found = [];
        const foundFolders = new Set();
        if (await directoryIsSafe(root)) {
          startWatch();
          const children = await readdir(root, { withFileTypes: true }).catch(error => { if (!missing(error)) throw error; return []; });
          for (const child of children) {
            const category = child.name.toLowerCase();
            if (!child.isDirectory() || !scoped.has(category)) continue;
            const nested = nestedCategories.has(category);
            await walk(path.join(root, child.name), nested ? Infinity : category === 'linkssnapshots' ? 1 : 0, found, nested ? foundFolders : null);
          }
        }
        for (const folder of folders) if (!foundFolders.has(folder)) changed.add(folder);
        for (const folder of foundFolders) if (!folders.has(folder)) changed.add(folder);
        folders = foundFolders;
        const present = new Set(found);
        for (const relative of entries.keys()) if (!present.has(relative)) {
          entries.delete(relative);
          changed.add(relative);
        }
        for (let offset = 0; offset < found.length; offset += 32) {
          const batch = found.slice(offset, offset + 32);
          const updated = await Promise.all(batch.map(relative => update(relative, true)));
          batch.forEach((relative, index) => { if (updated[index]) changed.add(relative); });
        }
        lastScan = Date.now();
      }
      for (const relative of touched) if (await update(relative)) changed.add(relative);
    } catch (error) {
      rescan = true;
      throw error;
    } finally {
      if (changed.size) {
        snapshot = { revision: ++revision, entries: [...entries.values()] };
        if (!closed) onChange([...changed]);
      }
    }
  }

  async function read() {
    if (pending || rescan || dirty.size || Date.now() - lastScan >= reconcileEvery) {
      pending ??= sync().finally(() => { pending = null; });
      await pending;
    }
    return snapshot;
  }

  const reconcile = setInterval(schedule, reconcileEvery);
  reconcile.unref();
  return {
    read, invalidate,
    close() {
      closed = true;
      watcher?.close();
      clearTimeout(timer);
      clearInterval(reconcile);
    },
  };
}
