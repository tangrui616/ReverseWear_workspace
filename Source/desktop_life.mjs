import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseRecordMarkdown } from './desktop_records.mjs';
import { getWorkDate } from './dist/date-boundary.mjs';

const kinds = new Set(['experience', 'mood', 'thinking', 'content', 'template', 'custom']);
const currentIds = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const kindDirectories = {
  experience: ['LifeExperiences'], mood: ['MoodJournal'], thinking: ['ThinkingPages'],
  content: ['ContentBoard'], template: ['Templates'], custom: ['CustomAreas'],
};
const limits = { title: 240, area: 100, place: 240, event: 12000, learning: 12000, happenedAt: 30,
  trigger: 12000, feelings: 12000, thoughts: 12000, needs: 12000, nextStep: 12000,
  question: 12000, freeWrite: 30000, aiQuestions: 12000, answers: 16000, conclusion: 12000,
  topic: 12000, script: 30000, publication: 12000, stage: 40, templateBody: 30000 };

function text(value, max) { return typeof value === 'string' ? value.slice(0, max) : ''; }
function quote(value) { return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e'); }
function serialize(metadata, body) {
  return `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${quote(value)}`).join('\n')}\n---\n\n${body}`;
}
function bodyFor(kind, fields) {
  if (kind === 'experience') return `## 发生了什么\n\n${fields.event}\n\n## 学到什么\n\n${fields.learning}`;
  if (kind === 'mood') return `## 发生了什么\n\n${fields.trigger}\n\n## 感受\n\n${fields.feelings}\n\n## 当时的想法\n\n${fields.thoughts}\n\n## 我需要什么\n\n${fields.needs}\n\n## 下一步\n\n${fields.nextStep}`;
  if (kind === 'thinking') return `## 问题\n\n${fields.question}\n\n## 自由写\n\n${fields.freeWrite}\n\n<!-- ai:begin -->\n## AI 追问\n\n${fields.aiQuestions}\n<!-- ai:end -->\n\n## 我的回答\n\n${fields.answers}\n\n## 结论 / 下一步\n\n${fields.conclusion}`;
  if (kind === 'content') return `## 选题\n\n${fields.topic}\n\n## 脚本\n\n${fields.script}\n\n## 发布记录\n\n${fields.publication}`;
  return fields.templateBody;
}
function sectionText(body, heading, knownHeadings) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(line => line === `## ${heading}`);
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && lines[end] !== '<!-- ai:begin -->' && lines[end] !== '<!-- ai:end -->' && !knownHeadings.has(lines[end].replace(/^##\s+/, ''))) end++;
  const section = lines[start + 1] === '' ? lines.slice(start + 2, end) : lines.slice(start + 1, end);
  if (section.at(-1) === '') section.pop();
  return section.join('\n');
}
function fieldsFromBody(kind, body, fallback) {
  if (kind === 'template' || kind === 'custom') return { ...fallback, templateBody: body };
  const sections = {
    experience: { event: '发生了什么', learning: '学到什么' },
    mood: { trigger: '发生了什么', feelings: '感受', thoughts: '当时的想法', needs: '我需要什么', nextStep: '下一步' },
    thinking: { question: '问题', freeWrite: '自由写', aiQuestions: 'AI 追问', answers: '我的回答', conclusion: '结论 / 下一步' },
    content: { topic: '选题', script: '脚本', publication: '发布记录' },
  }[kind];
  if (!sections) return fallback;
  const parsed = { ...fallback };
  const knownHeadings = new Set(Object.values(sections));
  for (const [key, heading] of Object.entries(sections)) {
    const section = sectionText(body, heading, knownHeadings);
    if (section !== undefined) parsed[key] = section;
  }
  return parsed;
}

export function createLifeWorkbench(dataRoot, { getDayStartMinutes = () => 0 } = {}) {
  const documents = path.resolve(dataRoot, 'Documents');
  let queue = Promise.resolve();
  const serializeQueue = task => { const next = queue.then(task); queue = next.catch(() => {}); return next; };

  async function directory(kind) {
    if (!kinds.has(kind)) throw new Error('记录类型无效。');
    const parts = kindDirectories[kind];
    let current = documents;
    await mkdir(current, { recursive: true });
    const actualRoot = await realpath(current);
    if (process.platform === 'win32' ? actualRoot.toLowerCase() !== current.toLowerCase() : actualRoot !== current) throw new Error('Documents 路径包含重解析点。');
    for (const part of parts) {
      const next = path.join(current, part);
      await mkdir(next, { recursive: true });
      const info = await lstat(next);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(next) !== next) throw new Error('生活记录目录路径异常。');
      current = next;
    }
    return current;
  }

  async function recordPath(kind, id) {
    if (!currentIds.test(id ?? '')) throw new Error('记录 ID 无效。');
    const parent = await directory(kind);
    let file = path.join(parent, `${id}.md`);
    let info = await lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) {
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
        const candidate = path.join(parent, entry.name);
        const candidateInfo = await lstat(candidate);
        if (candidateInfo.isSymbolicLink() || candidateInfo.nlink !== 1) continue;
        const source = await readFile(candidate, 'utf8');
        if (parseRecordMarkdown(source).metadata.id === id) { file = candidate; info = candidateInfo; break; }
      }
    }
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error('记录文件路径异常。');
    return { file, info, content: info ? await readFile(file, 'utf8') : null };
  }

  async function write(file, before, content) {
    const pending = `${file}.${randomUUID()}.pending`;
    try {
      await writeFile(pending, content, { encoding: 'utf8', flag: 'wx' });
      const retryDelays = process.platform === 'win32' ? [0, 30, 70, 150] : [0];
      for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
        if (retryDelays[attempt]) await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        const info = await lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(file) !== file)) {
          throw new Error('记录文件路径异常，原文件已保留。');
        }
        if (before === null ? info !== null : !info || await readFile(file, 'utf8') !== before) {
          throw new Error('记录已在其他位置修改，请刷新后再保存。');
        }
        try {
          await rename(pending, file);
          return;
        } catch (error) {
          const canRetry = process.platform === 'win32' && ['EPERM', 'EBUSY'].includes(error.code) && attempt < retryDelays.length - 1;
          if (!canRetry) throw error;
        }
      }
    } finally { await unlink(pending).catch(() => {}); }
  }

  function parse(file, content, info) {
    const parsed = parseRecordMarkdown(content);
    const metadata = parsed.metadata;
    if (!kinds.has(metadata.kind) || !currentIds.test(metadata.id ?? '')) throw new Error('记录文件与内容不匹配。');
    let fields = { happenedAt: metadata.happenedAt ?? '', place: metadata.place ?? '', stage: metadata.status ?? '' };
    const body = parsed.body;
    fields = fieldsFromBody(metadata.kind, body, fields);
    return { id: metadata.id, kind: metadata.kind, title: metadata.title ?? '', area: metadata.area ?? '', private: metadata.private === true,
      status: metadata.status ?? '', happenedAt: metadata.happenedAt ?? '', createdAt: metadata.createdAt, updatedAt: info.mtime.toISOString(), fields,
      relativePath: path.relative(documents, file).split(path.sep).join('/'), body };
  }

  async function saveRecord(input = {}) {
    const kind = input.kind;
    if (!kinds.has(kind)) throw new Error('记录类型无效。');
    const id = input.id ?? randomUUID();
    const stored = await recordPath(kind, id);
    const prior = stored.content === null ? null : parse(stored.file, stored.content, stored.info);
    if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== (prior?.updatedAt ?? null)) throw new Error('记录已在其他位置修改，请刷新后再保存。');
    const isTimeline = kind === 'experience' && input.area === '时间轴';
    const fields = Object.fromEntries(Object.entries(limits).filter(([key]) => key in (input.fields ?? {})).map(([key, max]) => [key, text(input.fields[key], isTimeline && key === 'event' ? Infinity : max)]));
    const title = text(input.title ?? fields.title, limits.title).trim() || '未命名记录';
    const area = text(input.area ?? fields.area, limits.area).trim();
    const now = new Date().toISOString();
    const metadata = {
      id, schema: 1, type: 'life-record', kind, title, area,
      private: kind === 'mood' || (input.private ?? prior?.private) === true,
      status: kind === 'content' ? (['topic', 'script', 'production', 'published'].includes(fields.stage) ? fields.stage : 'topic') : '',
      happenedAt: text(fields.happenedAt, 30), place: text(fields.place, limits.place), createdAt: prior?.createdAt ?? now, updatedAt: now,
    };
    const rendered = bodyFor(kind, fields);
    await write(stored.file, stored.content, serialize(metadata, rendered));
    const info = await lstat(stored.file);
    return parse(stored.file, await readFile(stored.file, 'utf8'), info);
  }

  return {
    async list({ kind } = {}) {
      const selectedKinds = kind ? [kind] : [...kinds];
      const records = [];
      for (const selected of selectedKinds) {
        const folder = await directory(selected);
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
          const file = path.join(folder, entry.name);
          const info = await lstat(file);
          if (info.isSymbolicLink() || info.nlink !== 1) continue;
          try { records.push(parse(file, await readFile(file, 'utf8'), info)); } catch { /* Leave malformed or unrelated Markdown untouched. */ }
        }
      }
      return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async get({ id, kind } = {}) {
      const choices = kind ? [kind] : [...kinds];
      for (const selected of choices) {
        const stored = await recordPath(selected, id);
        if (stored.content !== null) return parse(stored.file, stored.content, stored.info);
      }
      return null;
    },
    save(input = {}) {
      return serializeQueue(() => saveRecord(input));
    },
    appendTimeline({ sessionId, startAt, endAt, task } = {}) {
      return serializeQueue(async () => {
        if (!currentIds.test(sessionId ?? '')) throw new Error('计时记录编号无效。');
        const start = new Date(startAt);
        const end = new Date(endAt);
        const description = String(task ?? '').replace(/\s*\r?\n\s*/g, ' ').trim().slice(0, 500);
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start || !description) throw new Error('计时记录内容无效。');
        const workDate = getWorkDate(end, getDayStartMinutes());
        const token = `<!-- focus-session:${sessionId} -->`;
        const records = (await this.list({ kind: 'experience' })).filter(record => record.area === '时间轴');
        const saved = records.find(record => record.fields.event?.includes(token));
        if (saved) return saved;
        const existing = records.find(record => record.happenedAt === workDate);
        const time = value => `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
        const startDate = getWorkDate(start, 0);
        const endDate = getWorkDate(end, 0);
        const span = startDate === endDate ? `${time(start)}–${time(end)}` : `${startDate} ${time(start)}–${endDate} ${time(end)}`;
        const line = `- ${span} ${description} ${token}`;
        const event = [existing?.fields.event.trimEnd(), line].filter(Boolean).join('\n');
        return saveRecord({
          id: existing?.id, expectedUpdatedAt: existing?.updatedAt ?? null, kind: 'experience',
          title: `时间轴 ${workDate}`, area: '时间轴', fields: { ...existing?.fields, happenedAt: workDate, event, learning: existing?.fields.learning ?? '' },
        });
      });
    },
    saveTemplate(input = {}) { return this.save({ ...input, kind: 'template', fields: { ...input.fields, templateBody: input.body ?? input.fields?.templateBody } }); },
  };
}
