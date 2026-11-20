import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getWorkDate } from './dist/date-boundary.mjs';
import { noteIdentityId, noteTitleFromMarkdown } from './desktop_note_identity.mjs';
import { resolveFolderPath, safeRelativePath } from './desktop_folder_paths.mjs';

const kinds = new Set(['note', 'daily', 'weekly', 'memo']);
const safeId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const legacyRecordId = /^[a-f0-9]{16}$/i;
const hashContent = contents => createHash('sha256').update(contents).digest('hex');
const validRecordId = id => typeof id === 'string' && (safeId.test(id) || legacyRecordId.test(id));
const folderOf = relative => path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative);
const relativeFrom = (root, file) => path.relative(root, file).split(path.sep).join('/');
function findRecord(items, id, relativePath) {
  const matching = items.filter(item => item.id === id && (!relativePath || item.path === relativePath));
  if (matching.length > 1) throw new Error('发现重复的记录 ID，请在文件夹中核对对应文件。');
  return matching[0];
}
const derivedId = (scope, relative, file) => {
  if (scope === 'notes') return noteIdentityId(`Notes/${relative}`);
  const basename = path.basename(file, path.extname(file));
  if (scope === 'link-notes' && validRecordId(basename)) return basename;
  return createHash('sha1').update(file).digest('hex').slice(0, 16);
};

function addRecordId(source, id) {
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = source.slice(bom.length);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const header = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)/);
  const line = `id: ${JSON.stringify(id)}`;
  if (!header || !header[2].split(/\r?\n/).some(field => /^[A-Za-z_][\w.-]*:\s+/.test(field))) {
    return `${bom}---${newline}${line}${newline}schema: 1${newline}---${newline}${newline}${text}`;
  }
  const fields = header[2].split(/\r?\n/);
  const index = fields.findIndex(field => /^id\s*:/.test(field));
  if (index < 0) fields.push(line);
  else fields[index] = line;
  if (!fields.some(field => /^schema\s*:/.test(field))) fields.push('schema: 1');
  return bom + header[1] + fields.join(newline) + header[3] + text.slice(header[0].length);
}

function normalizeUrl(value, forCompare = false) {
  const url = new URL(String(value ?? '').trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入有效的 HTTP 或 HTTPS 链接');
  if (forCompare) url.hash = '';
  return url.toString();
}

function frontMatter(item, source = '') {
  const { body = '', note = '', metadata = {}, ...fields } = item;
  const allFields = { ...metadata, ...fields };
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const values = Object.entries(allFields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(newline);
  return `${bom}---${newline}${values}${newline}---${newline}${newline}${body || note}`;
}

function parseMarkdown(text, { ordinaryNotes = false } = {}) {
  text = text.replace(/^\uFEFF/, '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?([\s\S]*)$/);
  if (!match) return { body: text };
  const fields = match[1].split(/\r?\n/).filter(line => line.trim());
  if (ordinaryNotes && !fields.some(line => /^id:\s+/.test(line))
      && (!fields.length || fields.some(line => !/^[A-Za-z_][\w.-]*:\s+/.test(line)))) return { body: text };
  const metadata = Object.create(null);
  for (const line of fields) {
    const index = line.indexOf(': ');
    if (index < 0) continue;
    const key = line.slice(0, index);
    try { metadata[key] = JSON.parse(line.slice(index + 2)); } catch { metadata[key] = line.slice(index + 2); }
  }
  metadata.body = match[2];
  return metadata;
}

function localDate(value = new Date(), getDayStartMinutes = () => 0) {
  return getWorkDate(value, getDayStartMinutes());
}

export function createWorkbenchStore(dataRoot, { getDayStartMinutes = () => 0 } = {}) {
  const documents = path.join(path.resolve(dataRoot), 'Documents');
  const dirs = { link: path.join(documents, 'Links'), linkNotes: path.join(documents, 'LinkNotes'), note: path.join(documents, 'Notes'), daily: path.join(documents, 'Daily'), weekly: path.join(documents, 'Weekly'), memo: path.join(documents, 'Memos'), file: path.join(documents, 'Files') };
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /**
   * @template T
   * @param {() => T | PromiseLike<T>} task
   */
  const serialize = task => { const next = queue.then(task); queue = next.catch(() => {}); return next; };
  const ensure = async dir => {
    const base = await realpath(path.dirname(documents));
    await mkdir(path.join(base, 'Documents'), { recursive: true });
    const root = await realpath(documents);
    if (path.relative(base, root) !== 'Documents') throw new Error('文档目录必须位于工作台的 Documents 文件夹。');
    const category = path.basename(dir);
    await mkdir(path.join(root, category), { recursive: true });
    const actual = await realpath(dir);
    if (path.relative(root, actual) !== category) throw new Error('文档分类目录指向了其他位置。');
    return actual;
  };
  const listMarkdown = async (dir, defaults = {}) => {
    const safeDir = await ensure(dir);
    const result = [];
    const files = [];
    async function scan(directory) {
      const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) return [];
        throw error;
      });
      for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const actual = await resolveFolderPath(safeDir, relativeFrom(safeDir, candidate)).catch(() => null);
          if (actual) await scan(actual);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(candidate);
      }
    }
    await scan(safeDir);
    for (const file of files) {
      const entry = { name: path.basename(file) };
       if (path.basename(dir) === 'Notes' && (entry.name.startsWith('.') || /(?:\.tmp|\.pending|\.swp|\.crdownload)(?:\.md)?$|~(?:\.md)?$/i.test(entry.name))) continue;
      try {
         const entryInfo = await lstat(file);
         if (entryInfo.isSymbolicLink() || entryInfo.nlink > 1) continue;
         const actualFile = await realpath(file);
        if (path.relative(file, actualFile)) continue;
        const relativeFile = relativeFrom(safeDir, actualFile);
        const bytes = await readFile(file);
          const isNotes = path.basename(dir) === 'Notes';
          const parsed = parseMarkdown(bytes.toString('utf8'), { ordinaryNotes: isNotes });
         const info = await stat(actualFile);
        const rawBody = parsed.body ?? '';
        const { body: _parsedBody, ...metadata } = parsed;
         const id = typeof parsed.id === 'string' && (safeId.test(parsed.id) || legacyRecordId.test(parsed.id))
           ? parsed.id : isNotes
             ? noteIdentityId(`Notes/${relativeFile}`) : createHash('sha1').update(file).digest('hex').slice(0, 16);
        const isLink = defaults.type === 'link';
        const url = isLink ? normalizeUrl(parsed.url) : undefined;
         const title = typeof parsed.title === 'string' ? parsed.title : isLink ? '' : noteTitleFromMarkdown(rawBody, path.basename(file, path.extname(file)));
        const tags = Array.isArray(parsed.tags) ? parsed.tags.filter(tag => typeof tag === 'string') : [];
        const record = {
           ...defaults, id, title, tags, sourcePath: actualFile, contentHash: hashContent(bytes), updatedAt: info.mtime.toISOString(),
          createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : info.birthtime.toISOString(),
          metadata,
        };
        if (isLink) Object.assign(record, { url, note: rawBody, path: relativeFile, folderPath: path.posix.dirname(relativeFile) === '.' ? '' : path.posix.dirname(relativeFile), readLater: parsed.readLater === true, archived: parsed.archived === true, status: title || tags.length || rawBody.trim() ? 'organized' : 'inbox' });
        else Object.assign(record, {
           body: rawBody, date: typeof parsed.date === 'string' ? parsed.date : localDate(info.mtime, getDayStartMinutes),
          fileId: typeof parsed.fileId === 'string' && safeId.test(parsed.fileId) ? parsed.fileId : null,
          page: Number.isInteger(parsed.page) && parsed.page > 0 ? parsed.page : null,
           path: relativeFile,
           folderPath: folderOf(relativeFile),
           ...(isNotes ? {
             name: entry.name,
             fileName: entry.name,
             relativePath: `Notes/${relativeFile}`,
             externalMarkdown: !(typeof parsed.id === 'string' && (safeId.test(parsed.id) || legacyRecordId.test(parsed.id))),
           } : {}),
        });
        result.push(record);
      } catch { /* A damaged record does not hide other records. */ }
    }
    return result;
  };
  const atomicSave = async (dir, filename, value, expectedContentHash, { retryWindowsLock = false } = {}) => {
    const safeDir = await resolveFolderPath(dir);
    if (path.basename(filename) !== filename || filename === '.' || filename === '..') throw new Error('记录文件名无效');
    const target = path.join(safeDir, filename);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const existing = await lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) throw new Error('记录文件路径不安全。');
      const initial = existing ? await readFile(target) : null;
      const contents = frontMatter(value, initial?.toString('utf8') ?? '');
      await writeFile(temp, contents, { encoding: 'utf8', flag: 'wx' });
      if (!existing) {
        await copyFile(temp, target, constants.COPYFILE_EXCL);
        return contents;
      }
      if (expectedContentHash) {
        const current = await readFile(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (!current || hashContent(current) !== expectedContentHash) throw new Error('笔记已在其他位置修改，原文件已保留。请重新载入后再编辑。');
      }
      try {
        await rename(temp, target);
      } catch (error) {
        if (!retryWindowsLock || process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code)) throw error;
        const originalHash = initial ? hashContent(initial) : null;
        for (const waitMs of [30, 70, 150]) {
          await new Promise(resolve => setTimeout(resolve, waitMs));
          const currentInfo = await lstat(target).catch(currentError => currentError.code === 'ENOENT' ? null : Promise.reject(currentError));
          if (originalHash === null) {
            if (currentInfo) throw new Error('链接文件已由其他进程创建，未覆盖该文件。', { cause: error });
          } else {
            if (!currentInfo || !currentInfo.isFile() || currentInfo.isSymbolicLink() || currentInfo.nlink > 1) {
              throw new Error('链接文件路径已变化或不安全，未覆盖该文件。', { cause: error });
            }
            const actual = await realpath(target);
            if (path.dirname(actual) !== safeDir || path.basename(actual) !== filename) {
              throw new Error('链接文件路径已变化，未覆盖该文件。', { cause: error });
            }
            const current = await readFile(actual);
            if (hashContent(current) !== originalHash) {
              throw new Error('链接文件已在其他位置修改，未覆盖外部更新。', { cause: error });
            }
          }
          try { await rename(temp, target); return contents; }
          catch (retryError) {
            if (!['EPERM', 'EBUSY'].includes(retryError.code) || waitMs === 150) throw retryError;
          }
        }
      }
      return contents;
    } finally { await unlink(temp).catch(() => {}); }
  };
  const matches = (item, query, fields) => {
    if (!query) return true;
    const norm = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
    return fields.some(field => norm(Array.isArray(item[field]) ? item[field].join(' ') : item[field]).includes(norm(query)));
  };
  async function resolveFile(root, id) {
    if (typeof id !== 'string' || !safeId.test(id)) throw new Error('文件编号无效');
    const sidecar = path.join(root, `${id}.md`);
    if (path.relative(root, await realpath(sidecar)) !== `${id}.md`) throw new Error('导入文件记录指向了其他位置。');
    const record = parseMarkdown(await readFile(sidecar, 'utf8'));
    if (record.id !== id || record.type !== 'file' || typeof record.name !== 'string' || path.basename(record.name) !== record.name || !record.name || record.name === '.' || record.name === '..') throw new Error('导入文件记录无效');
    const relative = path.join(id, record.name);
    const file = await realpath(path.join(root, relative));
    if (path.relative(root, file) !== relative) throw new Error('文件路径越界');
    const info = await stat(file);
    if (!info.isFile()) throw new Error('导入文件已不可用。');
    const extension = path.extname(record.name).toLowerCase();
    return {
      file, id, name: record.name, size: info.size, importedAt: record.importedAt,
      isPdf: extension === '.pdf',
      isMarkdown: extension === '.md' || extension === '.markdown',
      isDocx: extension === '.docx',
    };
  }

  async function linkWorkspace(id) {
    if (typeof id !== 'string' || (!safeId.test(id) && !legacyRecordId.test(id))) throw new Error('无效的链接编号。');
    const link = findRecord(await listMarkdown(dirs.link, { type: 'link' }), id);
    if (!link) throw new Error('找不到这条链接。');
    const parent = await ensure(dirs.linkNotes);
    const folder = path.join(parent, id);
    await mkdir(folder, { recursive: true });
    if (path.relative(parent, await realpath(folder)) !== id) throw new Error('链接笔记目录指向了其他位置。');
    return { id, linkFile: link.sourcePath, folder, url: link.url };
  }

  async function scopedDirectory(scope, linkId) {
    if (scope === 'link-notes') return (await linkWorkspace(linkId)).folder;
    const mapping = { notes: 'note', memos: 'memo', daily: 'daily', weekly: 'weekly', links: 'link' };
    if (!Object.hasOwn(mapping, scope)) throw new Error('文件夹类别无效。');
    return ensure(dirs[mapping[scope]]);
  }

  async function listFolders({ scope, linkId } = {}) {
    const root = await scopedDirectory(scope, linkId);
    const folders = [];
    async function visit(directory, prefix = '') {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const actual = await resolveFolderPath(root, relative).catch(() => null);
        if (!actual) continue;
        folders.push(relative);
        await visit(actual, relative);
      }
    }
    await visit(root);
    return folders.sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  return {
    async listFolders(options) { return listFolders(options); },
    async createFolder({ scope, linkId, parentPath = '', name } = {}) {
      const root = await scopedDirectory(scope, linkId);
      const parent = await resolveFolderPath(root, parentPath);
      const folderName = safeRelativePath(name);
      if (!folderName || folderName.includes('/')) throw new Error('文件夹名称无效。');
      const target = path.join(parent, folderName);
      await mkdir(target).catch(error => {
        if (error.code === 'EEXIST') throw new Error('同名文件夹或文件已存在。');
        throw error;
      });
      const actual = await realpath(target);
      const relative = path.relative(root, actual);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('文件夹路径越界。');
      return { path: relative.split(path.sep).join('/') };
    },
    moveRecord({ scope, linkId, relativePath, destination = '', expectedContentHash } = {}) {
      return serialize(async () => {
        const root = await scopedDirectory(scope, linkId);
        const relative = safeRelativePath(relativePath);
        if (!/\.md$/i.test(relative)) throw new Error('只能移动 Markdown 记录。');
        const source = await resolveFolderPath(root, relative);
        const info = await lstat(source);
        if (!info.isFile() || info.nlink !== 1) throw new Error('记录文件路径不安全。');
        const bytes = await readFile(source);
        const sourceHash = hashContent(bytes);
        const sourceText = bytes.toString('utf8');
        const comparisonHash = scope === 'link-notes' ? hashContent(sourceText.replace(/^\uFEFF/, '')) : sourceHash;
        if (expectedContentHash && comparisonHash !== expectedContentHash) throw new Error('文件已在外部修改，请刷新后再移动。');
        const parsed = parseMarkdown(sourceText, { ordinaryNotes: scope === 'notes' });
        const hasId = validRecordId(parsed.id);
        if (!hasId && !Buffer.from(sourceText, 'utf8').equals(bytes)) throw new Error('笔记须为有效的 UTF-8 才能写入记录编号。');
        const id = hasId ? parsed.id : derivedId(scope, relative, source);
        const targetDirectory = await resolveFolderPath(root, destination);
        if (!(await lstat(targetDirectory)).isDirectory()) throw new Error('目标不是文件夹。');
        const target = path.join(targetDirectory, path.basename(source));
        if (!path.relative(source, target)) return { relativePath: relative, id, contentHash: comparisonHash };
        const relocated = hasId ? bytes : Buffer.from(addRecordId(sourceText, id), 'utf8');
        const targetHash = hashContent(relocated);
        if (!hasId) {
          const data = await realpath(path.dirname(documents));
          const backupRoot = path.join(data, 'FolderMoveBackups');
          await mkdir(backupRoot, { recursive: true });
          await resolveFolderPath(backupRoot);
          await writeFile(path.join(backupRoot, `${Date.now()}-${randomUUID()}.md`), bytes, { flag: 'wx' });
        }
        const staged = path.join(targetDirectory, `.${randomUUID()}.pending`);
        let published = false;
        const verifySource = async () => {
          await resolveFolderPath(root, relative);
          const current = await lstat(source);
          if (!current.isFile() || current.nlink !== 1 || hashContent(await readFile(source)) !== sourceHash) {
            throw new Error('文件已在外部修改，源文件已保留。');
          }
        };
        try {
          await writeFile(staged, relocated, { flag: 'wx' });
          await verifySource();
          await copyFile(staged, target, constants.COPYFILE_EXCL);
          published = true;
          await verifySource();
          await unlink(source);
        } catch (error) {
          if (published) {
            const sourcePreserved = await verifySource().then(() => true, () => false);
            const targetPath = relativeFrom(root, target);
            const current = sourcePreserved
              ? await resolveFolderPath(root, targetPath).then(file => readFile(file)).catch(() => null)
              : null;
            if (current && hashContent(current) === targetHash) await unlink(target).catch(() => {});
            else throw new Error(`移动期间文件发生变化，已保留目标目录中的可恢复副本：${targetPath}`, { cause: error });
          }
          if (error.code === 'EEXIST') throw new Error('目标文件夹中已存在同名文件。');
          throw error;
        } finally {
          await unlink(staged).catch(() => {});
        }
        const contentHash = scope === 'link-notes' ? hashContent(relocated.toString('utf8').replace(/^\uFEFF/, '')) : targetHash;
        return { relativePath: relativeFrom(root, target), id, contentHash };
      });
    },
    listLinks(query = '') {
      return Promise.all([
        listMarkdown(dirs.link, { type: 'link' }),
        readFile(path.join(path.dirname(documents), 'Settings', 'Stilltime', 'link-organization.json'), 'utf8')
          .then(text => Object.assign(Object.create(null), JSON.parse(text).aliases ?? {})).catch(() => Object.create(null)),
      ]).then(([items, aliases]) => items.filter(item => {
        if (matches(item, query, ['url', 'title', 'tags', 'note'])) return true;
        const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
        const term = normalize(query);
        return item.tags.some(tag => Object.hasOwn(aliases, tag) && aliases[tag].some(alias => normalize(alias).includes(term)));
      }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ sourcePath, ...item }) => item));
    },
    saveLink(input) {
      return serialize(async () => {
        const url = normalizeUrl(input.url);
        const links = await listMarkdown(dirs.link, { type: 'link' });
        const canonical = normalizeUrl(url, true);
        const prior = input.id ? findRecord(links, input.id, input.path ? safeRelativePath(input.path) : undefined) : null;
        if (input.id && !prior) throw new Error('要编辑的链接已经不存在，请刷新列表后重试。');
        const existing = links.find(link => { try { return normalizeUrl(link.url, true) === canonical; } catch { return false; } });
        if (existing && existing.id !== input.id && (!prior || normalizeUrl(prior.url, true) !== canonical)) {
          const { sourcePath, ...item } = existing;
          return { item, duplicate: true };
        }
        const id = prior?.id ?? randomUUID();
        const now = new Date().toISOString();
        const item = { ...prior?.metadata, id, schema: prior?.metadata?.schema ?? 1, type: 'link', url, title: String(input.title ?? '').trim(), tags: Array.isArray(input.tags) ? input.tags.map(String) : [], note: String(input.note ?? ''), readLater: Boolean(input.readLater), archived: typeof input.archived === 'boolean' ? input.archived : prior?.archived === true, status: input.title || input.tags?.length || input.note ? 'organized' : 'inbox', createdAt: prior?.createdAt ?? now, updatedAt: now };
        const priorPath = prior?.sourcePath;
        const relativePath = priorPath ? path.relative(dirs.link, priorPath).split(path.sep).join('/') : `${safeRelativePath(input.folderPath ?? '')}/${id}.md`.replace(/^\//, '');
        const targetDirectoryPath = path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath);
        const targetDirectory = await resolveFolderPath(await ensure(dirs.link), targetDirectoryPath);
        await atomicSave(targetDirectory, path.basename(relativePath), item, undefined, { retryWindowsLock: true });
        return { item: { ...item, path: relativePath, folderPath: targetDirectoryPath }, duplicate: false };
      });
    },
    linkWorkspace,
    async listLinkNotes(id) {
      const workspace = await linkWorkspace(id);
      const files = [];
      const folders = await listFolders({ scope: 'link-notes', linkId: id });
      for (const relativeFolder of ['', ...folders]) {
        const directory = await resolveFolderPath(workspace.folder, relativeFolder).catch(() => null);
        if (!directory) continue;
        const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });
        for (const entry of entries) {
          if (!entry.isFile() || entry.name.startsWith('.') || !/\.md$/i.test(entry.name)) continue;
          const relative = path.posix.join(relativeFolder, entry.name);
          const file = await resolveFolderPath(workspace.folder, relative).catch(() => null);
          const info = file && await lstat(file).catch(() => null);
          if (!info?.isFile() || info.nlink !== 1) continue;
          files.push({ name: entry.name, path: relative, folderPath: relativeFolder, size: info.size, updatedAt: info.mtime.toISOString() });
        }
      }
      return { ...workspace, folders, files: files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name, 'zh-CN')) };
    },
    async readLinkNote(id, name) {
      name = safeRelativePath(name);
      if (!name || !/\.md$/i.test(name)) throw new Error('无效的笔记文件名。');
      const { folder } = await linkWorkspace(id);
      const file = await resolveFolderPath(folder, name).catch(error => {
        if (error.code === 'ENOENT') throw new Error('找不到笔记。');
        throw error;
      });
      const info = await lstat(file);
      if (!info.isFile() || info.nlink !== 1) throw new Error('找不到笔记。');
      if (info.size > 2 * 1024 * 1024) throw new Error('此笔记超过 2 MiB，请在笔记目录中用编辑器打开。');
      return (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
    },
    async getLinkNote(id, name) {
      const source = await this.readLinkNote(id, name);
      const parsed = parseMarkdown(source);
      const body = parsed.body ?? source;
      return {
        id: parsed.id ?? path.basename(name).replace(/\.md$/i, ''), name: path.basename(name), path: name, folderPath: folderOf(name),
        type: parsed.type ?? 'link-note', relatedId: parsed.relatedId ?? id,
        title: parsed.title ?? body.match(/^#\s+(.+)$/m)?.[1] ?? '', tags: Array.isArray(parsed.tags) ? parsed.tags.filter(tag => typeof tag === 'string') : [],
        date: typeof parsed.date === 'string' ? parsed.date : '', body,
        expectedContentHash: hashContent(source),
      };
    },
    saveLinkNote(input) {
      return serialize(async () => {
        const { folder } = await this.linkWorkspace(input.linkId);
        const suppliedPath = safeRelativePath(input.path ?? input.name ?? '');
        const folderPath = suppliedPath ? folderOf(suppliedPath) : safeRelativePath(input.folderPath ?? '');
        const directory = await resolveFolderPath(folder, folderPath);
        const name = suppliedPath ? path.posix.basename(suppliedPath) : `${randomUUID()}.md`;
        if (!/\.md$/i.test(name)) throw new Error('无效的链接笔记文件名。');
        const relative = path.posix.join(folderPath, name);
        let existing = null;
        if (suppliedPath) {
          const actual = await resolveFolderPath(folder, relative).catch(error => {
            if (error.code === 'ENOENT') throw new Error('链接笔记已经移走或删除，请刷新后重试。');
            throw error;
          });
          const info = await lstat(actual);
          if (!info.isFile() || info.nlink !== 1) throw new Error('链接笔记路径无效。');
          if (info.size > 2 * 1024 * 1024) throw new Error('此笔记超过 2 MiB，请在笔记目录中用编辑器打开。');
          const raw = await readFile(actual, 'utf8');
          const source = raw.replace(/^\uFEFF/, '');
          existing = { source, hash: hashContent(raw), parsed: parseMarkdown(raw) };
        }
        if (existing) {
          const currentHash = hashContent(existing.source);
          if (!input.expectedContentHash || input.expectedContentHash !== currentHash) throw new Error('链接笔记已在其他位置修改，原文件已保留。请重新载入后再编辑。');
          if ((existing.parsed.relatedId && existing.parsed.relatedId !== input.linkId) || (existing.parsed.type && existing.parsed.type !== 'link-note')) throw new Error('链接笔记与当前链接不匹配。');
        }
        const now = new Date().toISOString();
        const basename = name.replace(/\.md$/i, '');
        const id = validRecordId(existing?.parsed.id) ? existing.parsed.id
          : existing ? derivedId('link-notes', relative, path.join(directory, name)) : basename;
        const item = {
          ...existing?.parsed, id, schema: existing?.parsed.schema ?? 1, type: 'link-note', relatedId: input.linkId,
          title: String(input.title ?? '').trim(), tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
          date: /^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '') ? input.date : localDate(new Date(), getDayStartMinutes),
          createdAt: existing?.parsed.createdAt ?? now, updatedAt: now, body: String(input.body ?? ''),
        };
        const savedSource = await atomicSave(directory, name, item, existing?.hash);
        return { ...item, name, path: relative, folderPath, expectedContentHash: hashContent(savedSource.replace(/^\uFEFF/, '')) };
      });
    },
    listNotes({ kind, query = '', fileId } = {}) {
      const selected = kind && kinds.has(kind) ? [kind] : ['note', 'daily', 'weekly'];
      return Promise.all(selected.map(async value => (await listMarkdown(dirs[value], { kind: value })).filter(item => matches(item, query, ['title', 'body', 'tags']) && (!fileId || item.fileId === fileId)).map(({ sourcePath, ...item }) => ({ ...item, page: Number.isInteger(item.page) ? item.page : null })))).then(groups => groups.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    },
    appendClipboardNote(value, source = 'clipboard') {
      return serialize(async () => {
        const date = localDate(new Date(), getDayStartMinutes);
        const isArticle = source === 'articles';
        const marker = isArticle ? 'articleCollectionDate' : 'clipboardCollectionDate';
        const title = isArticle ? '文章摘录' : '剪贴板收集';
        const tag = isArticle ? '文章摘录' : '剪贴板';
        const prior = (await listMarkdown(dirs.note, { kind: 'note' })).find(item => item.metadata[marker] === date);
        const now = new Date().toISOString();
        const id = prior?.id ?? randomUUID();
        const clock = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        const quoted = value.trim().split(/\r?\n/).map(line => '> ' + line).join('\n');
        const body = (prior?.body?.trimEnd() || '# ' + title) + '\n\n## ' + clock + '\n\n' + quoted + '\n';
        const item = { ...prior?.metadata, id, schema: 1, kind: 'note', date, title: prior?.title || title,
          tags: prior?.tags ?? [tag], body, [marker]: date,
          createdAt: prior?.createdAt ?? now, updatedAt: now };
        await atomicSave(prior ? path.dirname(prior.sourcePath) : await ensure(dirs.note), prior ? path.basename(prior.sourcePath) : date + '-' + id + '.md', item, prior?.contentHash);
        return { id, date, title: item.title };
      });
    },
    saveNote(input) {
      return serialize(async () => {
        if (!kinds.has(input.kind)) throw new Error('笔记类型无效');
        const dir = dirs[input.kind];
        const items = await listMarkdown(dir, { kind: input.kind });
        const prior = input.id ? findRecord(items, input.id, input.path ? safeRelativePath(input.path) : undefined) : null;
        if (input.id && !prior) throw new Error('要编辑的笔记已经不存在，请刷新归档后重试。');
        if (prior && input.expectedContentHash && prior.contentHash !== input.expectedContentHash) throw new Error('笔记已在其他位置修改，原文件已保留。请重新载入后再编辑。');
        const id = prior?.id ?? randomUUID();
        const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '') ? input.date : localDate(new Date(), getDayStartMinutes);
        const fileId = (input.fileId === undefined ? prior?.fileId : input.fileId) || null;
        const rawPage = input.page === undefined ? prior?.page : input.page;
        const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : null;
        if (fileId) {
          const source = (await this.listFiles()).find(item => item.id === fileId);
          if (!source) throw new Error('阅读来源文件已不可用。');
          if (source.isPdf && !page) throw new Error('PDF 笔记需要有效页码');
          if (!source.isPdf && page) throw new Error('此阅读来源不支持页码');
        }
        const folderPath = safeRelativePath(prior ? path.relative(dir, path.dirname(prior.sourcePath)).split(path.sep).join('/') : input.folderPath ?? '');
        const targetDirectory = await resolveFolderPath(await ensure(dir), folderPath);
        const targetName = prior ? path.basename(prior.sourcePath) : `${date}-${id}.md`;
        const body = String(input.body ?? '');
        const title = prior?.externalMarkdown
          ? noteTitleFromMarkdown(body, path.parse(targetName).name)
          : String(input.title ?? '').trim();
        const item = { ...prior?.metadata, id, schema: prior?.metadata?.schema ?? 1, kind: input.kind, date, title, tags: Array.isArray(input.tags) ? input.tags.map(String) : [], body, fileId, page, createdAt: prior?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
        const savedContents = await atomicSave(targetDirectory, targetName, item, prior ? input.expectedContentHash : undefined);
        return {
          ...item,
          contentHash: hashContent(savedContents),
          path: path.posix.join(folderPath, targetName), folderPath,
          ...(input.kind === 'note' ? { name: targetName, fileName: targetName, relativePath: `Notes/${path.posix.join(folderPath, targetName)}`, externalMarkdown: false } : {}),
        };
      });
    },
    async listFiles() {
      const root = await ensure(dirs.file);
      const entries = await readdir(root, { withFileTypes: true });
      const result = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const id = entry.name.slice(0, -3);
        if (!safeId.test(id)) continue;
        try {
          const { file, ...item } = await resolveFile(root, id);
          result.push(item);
        } catch {}
      }
      return result.sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)));
    },
    async getDocument(id) {
      const root = await ensure(dirs.file);
      const item = await resolveFile(root, id);
      if (!item.isMarkdown && !item.isDocx) throw new Error('只支持在工作台阅读 Markdown 和 DOCX 文件。');
      if (item.size > 32 * 1024 * 1024) throw new Error('文件超过 32 MiB，无法在工作台中阅读。');
      return { id: item.id, name: item.name, contents: await readFile(item.file) };
    },
    importFiles(absolutePaths) {
      return serialize(async () => {
        const safeFiles = await ensure(dirs.file);
        const items = [], errors = [];
        for (const candidate of absolutePaths ?? []) {
          try {
            const source = await realpath(candidate);
            const info = await stat(source);
            if (!info.isFile()) throw new Error('只支持导入文件');
            const id = randomUUID();
            const name = path.basename(source);
            const fileFolder = path.join(safeFiles, id);
            await mkdir(fileFolder);
            const managedFile = path.join(fileFolder, name);
            try {
              await copyFile(source, managedFile, constants.COPYFILE_EXCL);
              const size = (await stat(managedFile)).size;
              const importedAt = new Date().toISOString();
              await atomicSave(safeFiles, `${id}.md`, { id, type: 'file', name, importedAt });
            const extension = path.extname(name).toLowerCase();
            items.push({ id, name, size, importedAt, isPdf: extension === '.pdf', isMarkdown: extension === '.md' || extension === '.markdown', isDocx: extension === '.docx' });
            } catch (error) {
              await unlink(managedFile).catch(() => {});
              await rmdir(fileFolder).catch(() => {});
              throw error;
            }
          } catch (error) { errors.push({ path: String(candidate), error: error.message }); }
        }
        return { items, errors };
      });
    },
    async getFilePath(id) {
      return (await resolveFile(await ensure(dirs.file), id)).file;
    },
    async getPdfPath(id) {
      const item = await resolveFile(await ensure(dirs.file), id);
      if (!item.isPdf) throw new Error('仅支持 PDF 文件');
      return item.file;
    }
  };
}
