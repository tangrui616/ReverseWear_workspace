import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getWorkDate } from './dist/date-boundary.mjs';
import { createMarkdownIndex } from './desktop_incremental_index.mjs';

const areas = new Set(['unclassified', 'research', 'content', 'language', 'life', 'emotion']);
const statuses = new Set(['seed', 'growing', 'action', 'done', 'fridge', 'archived']);
const reviewDecisions = new Set(['action', 'growing', 'fridge', 'archived']);
const reviewWeek = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const searchText = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase();
const aiStart = '<!-- ai:begin -->';
const aiEnd = '<!-- ai:end -->';

function parseMarkdown(text) {
  const match = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?([\s\S]*)$/);
  if (!match) return { metadata: {}, body: text };
  const metadata = Object.create(null);
  for (const line of match[1].split(/\r?\n/)) {
    const index = line.indexOf(': ');
    if (index < 1) continue;
    const key = line.slice(0, index);
    try { metadata[key] = JSON.parse(line.slice(index + 2)); }
    catch { metadata[key] = line.slice(index + 2); }
  }
  return { metadata, body: match[2] };
}

function yamlValue(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}

function renderMarkdown(metadata, body) {
  const frontmatter = Object.entries(metadata).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${yamlValue(value)}`).join('\n');
  return `---\n${frontmatter}\n---\n\n${body}`;
}

function normalizedSource(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.type === 'link') {
    let url;
    try { url = new URL(String(source.url ?? '')); } catch { throw new Error('灵感来源链接无效。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('灵感来源只支持 HTTP 或 HTTPS 链接。');
    return { type: 'link', linkId: typeof source.linkId === 'string' ? source.linkId : null, url: url.toString(), title: String(source.title ?? '').slice(0, 300) };
  }
  if (source.type === 'pdf') {
    if (typeof source.fileId !== 'string' || !uuid.test(source.fileId) || !Number.isInteger(source.page) || source.page < 1) throw new Error('PDF 灵感来源需要有效的文件编号和页码。');
    return { type: 'pdf', fileId: source.fileId, page: source.page, quote: String(source.quote ?? '').slice(0, 20000), fileName: String(source.fileName ?? '').slice(0, 300) };
  }
  return null;
}

function parseCaptureBlocks(markdown, date) {
  const result = [];
  for (const match of markdown.matchAll(/<!-- capture-data:([A-Za-z0-9_-]+) -->/g)) {
    try {
      const item = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
      if (typeof item.id === 'string' && uuid.test(item.id) && typeof item.text === 'string') result.push({ ...item, date });
    } catch { /* An incomplete entry is skipped while the rest of the inbox remains available. */ }
  }
  return result;
}

function captureBlock(item) {
  const readable = item.text.split(/\r?\n/).map(line => `> ${line.replaceAll('<!--', '&lt;!--').replaceAll('-->', '--&gt;')}`).join('\n');
  const sourceLine = item.source ? `\n\n来源：${item.source}` : '';
  const encoded = Buffer.from(JSON.stringify(item), 'utf8').toString('base64url');
  const localTime = new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour12: false });
  return `\n## ${localTime}\n\n${readable}${sourceLine}\n\n<!-- capture:${item.id} -->\n<!-- capture-data:${encoded} -->\n`;
}

function ideaBody(item, previousBody = '') {
  const previousAi = previousBody.match(/<!-- ai:begin -->[\s\S]*?<!-- ai:end -->/)?.[0];
  const ai = item.aiBlock ? `${aiStart}\n${item.aiBlock}\n${aiEnd}` : previousAi ?? `${aiStart}\n## AI 整理\n${aiEnd}`;
  const safeDisplay = value => String(value ?? '').replaceAll('<!--', '&lt;!--').replaceAll('-->', '--&gt;');
  return `# ${safeDisplay(item.title || '未命名灵感')}\n\n## 原话\n${safeDisplay(item.original)}\n\n## 我的后续想法\n${safeDisplay(item.followup)}\n\n${ai}\n`;
}

function safeDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day ? value : null;
}

function extractSection(body, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return body.match(new RegExp(`^## ${escaped}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`, 'm'))?.[1]?.replace(/^\r?\n|\r?\n$/g, '') ?? '';
}

export function createDesktopIdeas(dataRoot, { getDayStartMinutes = () => 0, now = () => new Date(), index } = {}) {
  const documents = path.join(path.resolve(dataRoot), 'Documents');
  const inbox = path.join(documents, 'Inbox');
  const ideas = path.join(documents, 'Ideas');
  const markdown = index ?? createMarkdownIndex(documents, { scopedCategories: ['ideas'] });
  let indexedIdeas = new Map();
  let indexRevision = -1;
  let queue = Promise.resolve();
  const serialize = task => {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  };

  async function ensureDirectory(directory) {
    await mkdir(documents, { recursive: true });
    const documentsInfo = await lstat(documents);
    if (!documentsInfo.isDirectory() || documentsInfo.isSymbolicLink()) throw new Error('Documents 目录路径异常。');
    const actualDocuments = await realpath(documents);
    if (actualDocuments !== documents) throw new Error('Documents 目录指向了其他位置。');
    await mkdir(directory, { recursive: true });
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('灵感目录路径异常。');
    const actual = await realpath(directory);
    if (path.dirname(actual) !== actualDocuments) throw new Error('灵感目录指向了 Documents 外部位置。');
    return actual;
  }

  async function readIdea(id) {
    if (typeof id !== 'string' || !uuid.test(id)) throw new Error('灵感编号无效。');
    const directory = await ensureDirectory(ideas);
    const file = path.join(directory, `${id}.md`);
    const info = await lstat(file, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw new Error('灵感文件路径异常。');
    const content = await readFile(file, 'utf8');
    const parsed = parseMarkdown(content);
    if (parsed.metadata.id !== id || parsed.metadata.type !== 'idea') throw new Error('灵感文件编号与内容不一致。');
    return { file, content, parsed, updatedAt: info.mtime.toISOString() };
  }

  async function readInboxFile(file, date) {
    const info = await lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error(`收件箱文件路径异常：${file}`);
    const content = info ? await readFile(file, 'utf8') : '';
    const parsed = parseMarkdown(content);
    const metadata = {
      ...parsed.metadata,
      id: uuid.test(parsed.metadata.id ?? '') ? parsed.metadata.id : randomUUID(),
      type: 'daily', schema: 1, date, private: true,
      createdAt: typeof parsed.metadata.createdAt === 'string' ? parsed.metadata.createdAt : now().toISOString(),
      updatedAt: info?.mtime.toISOString() ?? now().toISOString(),
    };
    return { info, content, metadata, body: parsed.body };
  }

  async function replaceInbox(file, before, metadata, body) {
    const directory = await ensureDirectory(inbox);
    if (path.dirname(file) !== directory) throw new Error('收件箱文件路径无效。');
    const pending = `${file}.${randomUUID()}.pending`;
    try {
      await writeFile(pending, renderMarkdown(metadata, body), { encoding: 'utf8', flag: 'wx' });
      const info = await lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error('收件箱文件路径异常，原文件已保留。');
      const current = info ? await readFile(file, 'utf8') : null;
      if (current !== before) throw new Error('收件箱文件已由其他程序修改，原文件已保留。');
      await rename(pending, file);
    } finally {
      await unlink(pending).catch(() => {});
    }
  }

  async function writeIdea(file, metadata, body, expectedContent = null) {
    const directory = await ensureDirectory(ideas);
    if (path.dirname(file) !== directory) throw new Error('灵感文件路径无效。');
    const pending = `${file}.${randomUUID()}.pending`;
    try {
      await writeFile(pending, renderMarkdown(metadata, body), { encoding: 'utf8', flag: 'wx' });
      const current = await readFile(file, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (expectedContent !== null && current !== expectedContent) throw new Error('灵感文件已被其他程序修改，请刷新后重试。');
      if (expectedContent === null && current !== null) throw new Error('灵感文件已存在，未覆盖。');
      await rename(pending, file);
      markdown.invalidate(path.relative(documents, file));
    } finally {
      await unlink(pending).catch(() => {});
    }
  }

  function asIdea(parsed, updatedAt) {
    const { metadata, body } = parsed;
    const aiMatch = body.match(/<!-- ai:begin -->\s*([\s\S]*?)\s*<!-- ai:end -->/);
    return {
      id: metadata.id,
      relativePath: `Ideas/${metadata.id}.md`,
      title: typeof metadata.title === 'string' ? metadata.title : body.match(/^#\s+(.+)$/m)?.[1] ?? '',
      area: areas.has(metadata.area) ? metadata.area : 'unclassified',
      status: statuses.has(metadata.status) ? metadata.status : 'seed',
      source: normalizedSource(metadata.source),
      sourceNote: typeof metadata.sourceNote === 'string' ? metadata.sourceNote : '',
      captureId: uuid.test(metadata.captureId ?? '') ? metadata.captureId : null,
      original: typeof metadata.original === 'string' ? metadata.original : extractSection(body, '原话'),
      followup: typeof metadata.followup === 'string' ? metadata.followup : extractSection(body, '我的后续想法'),
      aiBlock: aiMatch?.[1] ?? '',
      tags: Array.isArray(metadata.tags) ? metadata.tags.filter(tag => typeof tag === 'string') : [],
      related: Array.isArray(metadata.related) ? metadata.related.filter(id => typeof id === 'string' && uuid.test(id)) : [],
      weeklyDecisions: Object.fromEntries(Object.entries(metadata.weeklyDecisions ?? {}).filter(([week, decision]) => reviewWeek.test(week) && reviewDecisions.has(decision))),
      private: metadata.private === true,
      schema: Number.isInteger(metadata.schema) ? metadata.schema : 1,
      createdAt: metadata.createdAt,
      updatedAt,
    };
  }

  return {
    close() { if (!index) markdown.close(); },
    appendCapture(input) {
      return serialize(async () => {
        const text = typeof input?.text === 'string' ? input.text : '';
        if (!text.trim()) throw new Error('捕捉内容不能为空。');
        if (text.length > 10000) throw new Error('单条快速捕捉不能超过 10,000 个字符。');
        if (input.captureId && !uuid.test(input.captureId)) throw new Error('捕捉编号无效。');
        const source = typeof input.source === 'string' && input.source.trim() ? normalizedSource({ type: 'link', url: input.source }).url : null;
        const date = getWorkDate(now(), getDayStartMinutes());
        const directory = await ensureDirectory(inbox);
        const file = path.join(directory, `${date}.md`);
        const inboxFile = await readInboxFile(file, date);
        const entries = parseCaptureBlocks(inboxFile.body, date);
        if (input.captureId && entries.some(item => item.id === input.captureId)) return { item: entries.find(item => item.id === input.captureId), duplicate: true };
        const item = { id: uuid.test(input.captureId ?? '') ? input.captureId : randomUUID(), text, source, createdAt: now().toISOString(), date };
        const body = `${inboxFile.body.replace(/\s*$/, '')}\n${captureBlock(item)}`;
        await replaceInbox(file, inboxFile.info ? inboxFile.content : null, { ...inboxFile.metadata, updatedAt: item.createdAt }, body);
        return { item, duplicate: false };
      });
    },
    async listCaptures({ date } = {}) {
      const directory = await ensureDirectory(inbox);
      if (date !== undefined && !safeDate(date)) throw new Error('收件箱日期无效。');
      const selected = safeDate(date);
      const files = selected ? [`${selected}.md`] : await readdir(directory);
      const result = [];
      for (const name of files) {
        if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
        const file = path.join(directory, name);
        const info = await lstat(file).catch(() => null);
        if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) continue;
        const parsed = parseMarkdown(await readFile(file, 'utf8'));
        if (parsed.metadata.private !== true) continue;
        result.push(...parseCaptureBlocks(parsed.body, name.slice(0, 10)));
      }
      return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    createIdea(input) {
      return serialize(async () => {
        const captureId = uuid.test(input?.captureId ?? '') ? input.captureId : null;
        const existing = captureId ? (await this.listIdeas()).find(item => item.captureId === captureId) : null;
        if (existing) return { item: existing, duplicate: true };
        let original = typeof input?.original === 'string' ? input.original : '';
        let sourceInput = input?.source;
        if (input?.captureId || input?.captureDate) {
          if (!captureId || !safeDate(input.captureDate)) throw new Error('收件箱转换需要有效的捕捉编号和日期。');
          const entry = (await this.listCaptures({ date: input.captureDate })).find(item => item.id === captureId);
          if (!entry) throw new Error('指定的收件箱捕捉不存在，未创建灵感卡片。');
          original = entry.text;
          sourceInput = entry.source ? { type: 'link', linkId: null, url: entry.source } : null;
        }
        if (!original.trim()) throw new Error('灵感原话不能为空。');
        const area = areas.has(input.area) ? input.area : 'unclassified';
        const id = randomUUID();
        const createdAt = now().toISOString();
        const item = {
          id, type: 'idea', schema: 1, area, status: statuses.has(input.status) ? input.status : 'seed',
          title: String(input.title ?? '').trim().slice(0, 300), source: normalizedSource(sourceInput),
          sourceNote: String(input.sourceNote ?? '').slice(0, 2000), captureId, original,
          followup: String(input.followup ?? ''), tags: [...new Set((Array.isArray(input.tags) ? input.tags : []).map(tag => String(tag).trim()).filter(Boolean))].slice(0, 100),
          related: [], private: input.private === true || area === 'emotion', createdAt, updatedAt: createdAt,
        };
        const directory = await ensureDirectory(ideas);
        const file = path.join(directory, `${id}.md`);
        await writeIdea(file, item, ideaBody(item));
        return { item: { ...item, relativePath: `Ideas/${id}.md`, updatedAt: (await stat(file, { bigint: true })).mtime.toISOString(), aiBlock: '' }, duplicate: false };
      });
    },
    async listIdeas({ query = '', area = '', status = '', tag = '', offset, limit } = {}) {
      const snapshot = await markdown.read();
      if (indexRevision !== snapshot.revision) {
        const next = new Map();
        for (const entry of snapshot.entries) {
          const folder = path.dirname(entry.relativePath);
          const id = path.basename(entry.relativePath).slice(0, -3);
          if (folder.toLowerCase() !== 'ideas' || !uuid.test(id) || entry.parsed.metadata.id !== id || entry.parsed.metadata.type !== 'idea') continue;
          const prior = indexedIdeas.get(entry.relativePath);
          if (prior?.entry === entry) {
            next.set(entry.relativePath, prior);
            continue;
          }
          const item = asIdea(entry.parsed, entry.updatedAt);
          next.set(entry.relativePath, { item, entry,
            tags: item.tags.map(searchText),
            searchable: searchText([item.title, item.original, item.followup, item.aiBlock, item.tags.join(' '),
              item.source?.url, item.source?.title, item.source?.quote, item.sourceNote].join(' ')),
          });
        }
        indexedIdeas = new Map([...next].sort((a, b) => b[1].item.updatedAt.localeCompare(a[1].item.updatedAt)));
        indexRevision = snapshot.revision;
      }
      const terms = searchText(query).split(/\s+/).filter(Boolean);
      const label = searchText(tag).trim();
      const items = [...indexedIdeas.values()].filter(({ item, tags, searchable }) =>
        (!area || item.area === area) && (!status || item.status === status) &&
        (!label || tags.some(value => value.includes(label))) && terms.every(term => searchable.includes(term))
      ).map(({ item }) => item);
      if (!Number.isInteger(limit)) return items;
      const start = Math.max(0, Number.isInteger(offset) ? offset : 0);
      return { total: items.length, items: items.slice(start, start + Math.min(100, Math.max(1, limit))) };
    },
    async getIdea(id) {
      const { parsed, updatedAt } = await readIdea(id);
      return asIdea(parsed, updatedAt);
    },
    saveIdea(input) {
      return serialize(async () => {
        const { file, content, parsed, updatedAt } = await readIdea(input?.id);
        if (input.expectedUpdatedAt && input.expectedUpdatedAt !== updatedAt) throw new Error('灵感已在其他位置更新，请刷新后再保存。');
        const prior = asIdea(parsed, updatedAt);
        const decision = input.weeklyDecision;
        if (decision !== undefined && (!reviewWeek.test(decision?.week ?? '') || !reviewDecisions.has(decision?.decision) || decision.decision !== input.status)) {
          throw new Error('周复盘决定无效。');
        }
        const area = areas.has(input.area) ? input.area : prior.area;
        const metadata = {
          ...parsed.metadata,
          id: prior.id, type: 'idea', schema: prior.schema, area,
          status: statuses.has(input.status) ? input.status : prior.status,
          title: String(input.title ?? prior.title).trim().slice(0, 300),
          tags: [...new Set((Array.isArray(input.tags) ? input.tags : prior.tags).map(tag => String(tag).trim()).filter(Boolean))].slice(0, 100),
          source: input.source === undefined ? parsed.metadata.source : normalizedSource(input.source),
          sourceNote: input.sourceNote === undefined ? prior.sourceNote : String(input.sourceNote).slice(0, 2000),
          captureId: prior.captureId, original: prior.original,
          followup: input.followup === undefined ? prior.followup : String(input.followup),
          private: input.private === undefined ? prior.private || area === 'emotion' : input.private === true || area === 'emotion',
          createdAt: prior.createdAt, updatedAt: now().toISOString(),
        };
        if (decision) metadata.weeklyDecisions = { ...prior.weeklyDecisions, [decision.week]: decision.decision };
        const body = ideaBody({ ...prior, ...metadata }, parsed.body);
        await writeIdea(file, metadata, body, content);
        return asIdea(parseMarkdown(renderMarkdown(metadata, body)), (await stat(file, { bigint: true })).mtime.toISOString());
      });
    },
  };
}
