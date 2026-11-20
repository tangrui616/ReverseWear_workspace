import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseRecordMarkdown } from './desktop_records.mjs';
import { INSPIRATION_IMAGE_EXTENSIONS } from './desktop_resources.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

const yamlValue = value => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
function renderMarkdown(metadata, body) {
  const front = Object.entries(metadata).map(([key, value]) => `${key}: ${yamlValue(value)}`).join('\n');
  return `---\n${front}\n---\n\n${body}`;
}

function safeUrl(value) {
  const source = String(value ?? '').trim();
  if (!source) return '';
  let url;
  try { url = new URL(source); } catch { throw new Error('请填写有效的网址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('网址只支持 HTTP 或 HTTPS。');
  return url.toString();
}

function safeText(value, limit) { return String(value ?? '').slice(0, limit); }
const separator = '<!-- inspiration:borrow -->';
function bodyFor(item) {
  const clean = value => value.replaceAll(separator, '&lt;!-- inspiration:borrow --&gt;');
  return `# ${item.title.replace(/\s*\r?\n\s*/g, ' ')}\n\n## 它特别在哪\n${clean(item.special)}\n\n${separator}\n## 我能借鉴什么\n${clean(item.borrow)}\n`;
}

export function createDesktopInspirationBoard(dataRoot, { workbench = null, now = () => new Date(), index } = {}) {
  const documents = path.join(path.resolve(dataRoot), 'Documents');
  const directory = path.join(documents, 'InspirationBoard');
  let queue = Promise.resolve();
  const serialize = task => {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  };

  async function ensureDirectory() {
    await mkdir(documents, { recursive: true });
    const documentsInfo = await lstat(documents);
    if (!documentsInfo.isDirectory() || documentsInfo.isSymbolicLink()) throw new Error('Documents 目录路径异常。');
    const actualDocuments = await realpath(documents);
    if (actualDocuments !== documents) throw new Error('Documents 目录包含重解析点。');
    await mkdir(directory, { recursive: true });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('灵感板目录路径异常。');
    return directory;
  }

  async function normalize(input, prior = {}) {
    const id = prior.id ?? randomUUID();
    const attachmentId = input.imageAttachmentId === undefined ? (prior.imageAttachmentId ?? null) : input.imageAttachmentId;
    let imageName = input.imageName === undefined ? (prior.imageName ?? '') : safeText(input.imageName, 300);
    if (attachmentId !== null) {
      if (typeof attachmentId !== 'string' || !uuid.test(attachmentId) || !workbench?.getFilePath) throw new Error('灵感图片附件无效。');
      const attachmentPath = await workbench.getFilePath(attachmentId);
      if (!INSPIRATION_IMAGE_EXTENSIONS.includes(path.extname(attachmentPath).toLowerCase())) throw new Error('附件不是支持的图片。');
      imageName = path.basename(attachmentPath);
    }
    const createdAt = prior.createdAt ?? now().toISOString();
    return {
      id, type: 'inspiration-board', schema: 1, private: true,
      title: safeText(input.title ?? prior.title, 300).trim(), url: safeUrl(input.url ?? prior.url),
      imageAttachmentId: attachmentId, imageName,
      special: safeText(input.special ?? prior.special, 20000),
      borrow: safeText(input.borrow ?? prior.borrow, 20000),
      createdAt, updatedAt: now().toISOString(),
    };
  }

  async function readCard(id) {
    if (typeof id !== 'string' || !uuid.test(id)) throw new Error('灵感卡编号无效。');
    const root = await ensureDirectory();
    const file = path.join(root, `${id}.md`);
    const info = await lstat(file, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw new Error('灵感卡文件路径异常。');
    const content = await readFile(file, 'utf8');
    const item = asCard(id, parseRecordMarkdown(content), info.mtime.toISOString());
    if (!item) throw new Error('灵感卡编号或类型不一致。');
    return { file, content, item };
  }

  function asCard(id, { metadata, body }, updatedAt) {
    if (metadata.id !== id || metadata.type !== 'inspiration-board' || metadata.private !== true) return null;
    const match = body.match(/^# .+\r?\n\r?\n## 它特别在哪\r?\n([\s\S]*?)\r?\n\r?\n<!-- inspiration:borrow -->\r?\n## 我能借鉴什么\r?\n([\s\S]*?)(?:\r?\n)?$/);
    const fromBody = value => value.replaceAll('&lt;!-- inspiration:borrow --&gt;', separator);
    return { ...metadata, special: match ? fromBody(match[1]) : '', borrow: match ? fromBody(match[2]) : '', updatedAt };
  }

  async function write(file, content, expected) {
    const root = await ensureDirectory();
    if (path.dirname(file) !== root) throw new Error('灵感卡文件路径无效。');
    const pending = `${file}.${randomUUID()}.pending`;
    try {
      await writeFile(pending, content, { encoding: 'utf8', flag: 'wx' });
      const current = await readFile(file, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (current !== expected) throw new Error('灵感卡已在其他位置修改，请刷新后重试。');
      await rename(pending, file);
      index?.invalidate(path.relative(documents, file));
    } finally { await unlink(pending).catch(() => {}); }
  }

  return {
    async list() {
      if (index) {
        const { entries } = await index.read();
        return entries.filter(entry => path.dirname(entry.relativePath).toLowerCase() === 'inspirationboard')
          .map(entry => asCard(path.basename(entry.relativePath, '.md'), entry.parsed, entry.updatedAt))
          .filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      }
      const root = await ensureDirectory();
      const entries = await readdir(root, { withFileTypes: true });
      const result = [];
      for (const entry of entries) {
        const id = entry.name.slice(0, -3);
        if (!entry.isFile() || !entry.name.endsWith('.md') || !uuid.test(id)) continue;
        try { result.push((await readCard(id)).item); } catch { /* Damaged cards stay untouched. */ }
      }
      return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    save(input) {
      return serialize(async () => {
        const existing = input?.id ? await readCard(input.id) : null;
        if (existing && input.expectedUpdatedAt && input.expectedUpdatedAt !== existing.item.updatedAt) throw new Error('灵感卡已在其他位置修改，请刷新后重试。');
        const item = await normalize(input ?? {}, existing?.item);
        if (!item.title.trim()) throw new Error('请填写灵感标题。');
        const file = existing?.file ?? path.join(await ensureDirectory(), `${item.id}.md`);
        const expected = existing?.content ?? null;
        const { special, borrow, ...metadata } = item;
        await write(file, renderMarkdown(metadata, bodyFor({ ...metadata, special, borrow })), expected);
        return { ...item, relativePath: `InspirationBoard/${item.id}.md`, updatedAt: (await lstat(file, { bigint: true })).mtime.toISOString() };
      });
    },
  };
}
