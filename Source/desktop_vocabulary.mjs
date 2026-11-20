import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getWorkDate } from './dist/date-boundary.mjs';
import { parseRecordMarkdown } from './desktop_records.mjs';
import { translationDirection } from './desktop_dictionaries.mjs';

const idPattern = /^[a-f0-9]{16}$/i;
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const compact = (value, max) => text(value, max).replace(/\s+/g, ' ');
const identity = (scope, direction, value) => createHash('sha256').update(
  `${scope}\0${direction}\0${value.normalize('NFKC').toLowerCase()}`,
).digest('hex').slice(0, 16);

function sanitizeSource(value) {
  if (!value || !['pdf', 'document', 'note'].includes(value.type)) return null;
  const source = { type: value.type, title: compact(value.title, 240) };
  if (typeof value.fileId === 'string' && /^[a-f\d-]{16,64}$/i.test(value.fileId)) source.fileId = value.fileId;
  if (typeof value.noteId === 'string' && /^[a-f\d-]{16,36}$/i.test(value.noteId)) source.noteId = value.noteId;
  if (['note', 'daily', 'weekly', 'memo'].includes(value.kind)) source.kind = value.kind;
  if (Number.isInteger(value.page) && value.page > 0 && value.page < 100000) source.page = value.page;
  if (!source.title && !source.fileId && !source.noteId) return null;
  return source;
}

function serialize(metadata, body) {
  const header = Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
  return `---\n${header}\n---\n\n${body.trim()}\n`;
}

function addDays(date, days) {
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function createDesktopVocabulary(documentsDirectory, { getDayStartMinutes = () => 0, now = () => new Date() } = {}) {
  const root = path.resolve(documentsDirectory);
  const vocabulary = path.join(root, 'Vocabulary');
  const terminology = path.join(root, 'Terminology');
  const workingDate = () => getWorkDate(now(), getDayStartMinutes());
  let pending = Promise.resolve();

  function serializeWrite(operation) {
    const job = pending.then(operation);
    pending = job.catch(() => {});
    return job;
  }

  async function info(file) {
    return lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  }

  async function ensureDirectory(folder, create) {
    if (create) await mkdir(folder, { recursive: true });
    const folderInfo = await info(folder);
    if (!folderInfo) return false;
    if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink() || path.relative(folder, await realpath(folder))) {
      throw new Error('语言学习目录存在链接跳转或无法安全读取。');
    }
    return true;
  }

  async function read(folder, id) {
    if (!idPattern.test(id ?? '')) throw new Error('无效的语言学习条目标识。');
    if (!await ensureDirectory(folder, false)) return null;
    const file = path.join(folder, id.toLowerCase() + '.md');
    const fileInfo = await info(file);
    if (!fileInfo) return null;
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.nlink !== 1 || fileInfo.size > 192 * 1024 ||
        path.relative(file, await realpath(file))) throw new Error('条目需要是语言目录中的普通 Markdown 文件。');
    const raw = await readFile(file, 'utf8');
    const { metadata, hasFrontMatter } = parseRecordMarkdown(raw);
    if (!hasFrontMatter || metadata.id !== id.toLowerCase() || metadata.schema !== 1) {
      throw new Error('语言学习条目文件头不匹配，请检查 Markdown。');
    }
    return { file, raw, metadata };
  }

  async function write(folder, record, body, before) {
    await ensureDirectory(folder, true);
    const file = path.join(folder, record.id + '.md');
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, serialize(record, body), { encoding: 'utf8', flag: 'wx' });
      if ((await read(folder, record.id))?.raw !== before?.raw) throw new Error('条目在其他位置已修改，请刷新。');
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(() => {}); }
    return record;
  }

  async function list(folder, type) {
    if (!await ensureDirectory(folder, false)) return [];
    const result = [];
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || !idPattern.test(entry.name.slice(0, -3))) continue;
      const stored = await read(folder, entry.name.slice(0, -3));
      if (stored?.metadata.type === type) result.push(stored.metadata);
    }
    return result;
  }

  function vocabularyBody(record) {
    const sourceLines = record.sources.map(source => {
      const origin = source.title || (source.type === 'pdf' ? 'PDF' : '笔记');
      return `- ${origin}${source.page ? `（第 ${source.page} 页）` : ''}${source.original ? `\n\n${source.original}` : ''}`;
    });
    return [`# ${record.word}`, `## 释义\n\n${record.gloss}`,
      record.original ? `## 原句\n\n${record.original}` : '', sourceLines.length ? `## 出处\n\n${sourceLines.join('\n')}` : ''].filter(Boolean).join('\n\n');
  }

  return {
    async listVocabulary() {
      const date = workingDate();
      const entries = await list(vocabulary, 'vocabulary');
      entries.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.word.localeCompare(b.word));
      return { entries, date, dueCount: entries.filter(entry => entry.dueDate <= date).length };
    },
    saveVocabulary(input = {}) {
      return serializeWrite(async () => {
        const word = compact(input.word, 512);
        const gloss = text(input.gloss, 4000);
        if (!word || !gloss) throw new Error('生词和释义均不能为空。');
        const direction = translationDirection(word, input.direction);
        const id = identity('vocabulary', direction, word);
        const before = await read(vocabulary, id);
        const prior = before?.metadata;
        const original = text(input.original ?? input.sentence, 2400);
        const source = sanitizeSource(input.source ?? input.sources?.[0]);
        const sources = Array.isArray(prior?.sources) ? prior.sources.map(item => ({
          ...sanitizeSource(item), original: text(item?.original, 2400),
        })).filter(item => item.type) : [];
        if (source && !sources.some(item => item.type === source.type && item.fileId === source.fileId &&
            item.noteId === source.noteId && item.page === source.page && item.title === source.title && item.original === original)) {
          sources.unshift({ ...source, original });
        }
        const updatedAt = now().toISOString();
        const record = { id, schema: 1, type: 'vocabulary', title: word, private: true, word, gloss, direction,
          original: original || prior?.original || '', sources: sources.slice(0, 16), dueDate: prior?.dueDate ?? workingDate(),
          repetitions: prior?.repetitions ?? 0, intervalDays: prior?.intervalDays ?? 0, createdAt: prior?.createdAt ?? updatedAt, updatedAt };
        if (prior && serialize({ ...record, updatedAt: prior.updatedAt }, vocabularyBody(record)) === before.raw) return prior;
        return write(vocabulary, record, vocabularyBody(record), before);
      });
    },
    reviewVocabulary({ id, rating } = {}) {
      return serializeWrite(async () => {
        if (!['again', 'hard', 'good', 'easy'].includes(rating)) throw new Error('选择有效的复习评分。');
        const before = await read(vocabulary, id);
        if (!before) throw new Error('找不到这条生词。');
        const record = before.metadata;
        const previous = Math.min(365, Math.max(0, Number(record.intervalDays) || 0));
        const next = { again: 0, hard: Math.max(1, Math.ceil(previous * 1.2)), good: previous < 2 ? previous * 2 + 1 : Math.ceil(previous * 2),
          easy: Math.max(4, Math.ceil(previous * 2.7)) };
        record.intervalDays = Math.min(365, next[rating]);
        record.dueDate = addDays(workingDate(), record.intervalDays);
        record.repetitions = rating === 'again' ? 0 : (Number(record.repetitions) || 0) + 1;
        record.updatedAt = now().toISOString();
        return write(vocabulary, record, vocabularyBody(record), before);
      });
    },
    async listTerms() {
      return (await list(terminology, 'term')).sort((a, b) => a.source.localeCompare(b.source));
    },
    saveTerm(input = {}) {
      return serializeWrite(async () => {
        const source = compact(input.source, 160);
        const target = compact(input.target, 240);
        if (!source || !target) throw new Error('原术语和首选译法均不能为空。');
        const direction = translationDirection(source, input.direction);
        const id = input.id ?? identity('term', direction, source);
        const before = await read(terminology, id);
        if (input.id && !before) throw new Error('找不到要编辑的术语。');
        const note = text(input.note, 2000);
        const updatedAt = now().toISOString();
        const record = { id, schema: 1, type: 'term', title: source, private: true, source, target, direction, note,
          createdAt: before?.metadata.createdAt ?? updatedAt, updatedAt };
        return write(terminology, record, `# ${source}\n\n${target}${note ? `\n\n## 说明\n\n${note}` : ''}`, before);
      });
    },
    removeTerm(id) {
      return serializeWrite(async () => {
        const before = await read(terminology, id);
        if (!before) return false;
        await unlink(before.file);
        return true;
      });
    },
    async matchedTerms(value, direction) {
      const normalized = typeof value === 'string' ? value.normalize('NFKC').toLowerCase() : '';
      return (await this.listTerms()).filter(term => term.direction === direction && typeof term.source === 'string' &&
        normalized.includes(term.source.normalize('NFKC').toLowerCase())).slice(0, 30);
    },
  };
}
