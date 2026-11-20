import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getWorkDate } from './dist/date-boundary.mjs';

const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const periods = new Set(['day', 'week']);

function localDate(date = new Date(), getDayStartMinutes = () => 0) {
  return getWorkDate(date, getDayStartMinutes());
}

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请输入有效日期。');
  const date = new Date(value + 'T00:00:00');
  if (Number.isNaN(date.valueOf()) || [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-') !== value) throw new Error('请输入有效日期。');
  return date;
}

function mondayDate(value) {
  const date = parseDate(value);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return localDate(date);
}

function splitMarkdown(source) {
  const text = source.replace(/^\uFEFF/, '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?([\s\S]*)$/);
  if (!match) return { metadata: Object.create(null), body: text };
  const metadata = Object.create(null);
  for (const line of match[1].split(/\r?\n/)) {
    const index = line.indexOf(': ');
    if (index <= 0) continue;
    try { metadata[line.slice(0, index)] = JSON.parse(line.slice(index + 2)); } catch {}
  }
  return { metadata, body: match[2] };
}

function frontMatter(metadata, body, preserveTrailingWhitespace = false) {
  const fields = Object.entries(metadata).map(([key, value]) => key + ': ' + JSON.stringify(value)).join('\n');
  const content = preserveTrailingWhitespace ? body + (body.endsWith('\n') ? '' : '\n') : body.trimEnd() + '\n';
  return '---\n' + fields + '\n---\n\n' + content;
}

function experimentMarkdown(item) {
  const parts = ['# ' + item.name, ''];
  for (const [key, heading, value] of [
    ['design', '实验设计', item.design],
    ['rounds', '实验轮次', item.rounds],
    ['issues', '异常/问题', item.issues],
    ['conclusion', '结论与下一步', item.conclusion],
  ]) {
    const marker = key + ':' + item.id;
    parts.push('<!-- stilltime:section:start:' + marker + ' -->');
    parts.push('## ' + heading);
    parts.push('<!-- stilltime:section:content:' + marker + ' -->');
    parts.push(value);
    parts.push('<!-- stilltime:section:end:' + marker + ' -->');
    parts.push('');
  }
  return parts.join('\n');
}

function sections(body, id) {
  const keys = [
    ['design', '实验设计'],
    ['rounds', '实验轮次'],
    ['issues', '异常/问题'],
    ['conclusion', '结论与下一步'],
  ];
  const marked = Object.create(null);
  for (const [key] of keys) {
    const marker = key + ':' + id;
    const start = '<!-- stilltime:section:start:' + marker + ' -->\\r?\\n';
    const content = '<!-- stilltime:section:content:' + marker + ' -->\\r?\\n';
    const end = '\\r?\\n<!-- stilltime:section:end:' + marker + ' -->';
    const match = new RegExp(start + '[^\\r\\n]*\\r?\\n' + content + '([\\s\\S]*?)' + end).exec(body);
    if (match) marked[key] = match[1];
  }
  if (Object.keys(marked).length) return marked;

  const recognized = new Map(keys.map(([key, heading]) => [heading, key]));
  const result = Object.create(null);
  let current = null;
  for (const line of body.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading && recognized.has(heading[1])) { current = recognized.get(heading[1]); result[current] = []; }
    else if (current) result[current].push(line);
  }
  return Object.fromEntries(Object.entries(result).map(([key, lines]) => [key, lines.join('\n').replace(/(?:\r?\n)$/, '')]));
}

function cleanExperiment(input, prior = null) {
  const name = String(input.name ?? prior?.name ?? '').trim();
  if (!name) throw new Error('请填写实验名称。');
  if (name.length > 180) throw new Error('实验名称不能超过 180 个字符。');
  const date = input.date ?? prior?.date ?? localDate();
  parseDate(date);
  const progress = Number(input.progress ?? prior?.progress ?? 0);
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) throw new Error('实验进度须为 0 到 100。');
  const id = input.id ?? prior?.id ?? randomUUID();
  if (typeof id !== 'string' || !uuidPattern.test(id)) throw new Error('实验编号无效。');
  const completed = input.completed === undefined ? prior?.completed === true : input.completed === true;
  const now = new Date().toISOString();
  return {
    id, name, date, progress: completed ? 100 : Math.round(progress),
    next: String(input.next ?? prior?.next ?? '').trim(),
    design: String(input.design ?? prior?.design ?? ''),
    rounds: String(input.rounds ?? prior?.rounds ?? ''),
    issues: String(input.issues ?? prior?.issues ?? ''),
    conclusion: String(input.conclusion ?? prior?.conclusion ?? ''),
    completed, createdAt: prior?.createdAt ?? now, updatedAt: now,
    revision: (prior?.revision ?? 0) + 1,
  };
}

function taskMarkdown(tasks) {
  return tasks.map(task => {
    const text = task.text.replace(/\r?\n/g, ' ').trim();
    const link = task.experimentId ? ' experiment:' + task.experimentId : '';
    return '- [' + (task.done ? 'x' : ' ') + '] ' + text + ' <!-- task:' + task.id + link + ' -->';
  }).join('\n');
}

function parseTasks(body) {
  const tasks = [];
  const lines = body.split(/\r?\n/);
  const seenText = new Map();
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const match = /^\s*-\s+\[([ xX])\]\s+(.+?)(?:\s+<!-- task:([a-f0-9-]{36}|[a-f0-9]{16})(?: experiment:([a-f0-9-]{36}))? -->)?\s*$/i.exec(line);
    if (!match) continue;
    const [, marker, rawText, storedId, experimentId] = match;
    const text = rawText.trim();
    if (!text) continue;
    const normalized = text.normalize('NFKC').trim().toLocaleLowerCase();
    const occurrence = seenText.get(normalized) ?? 0;
    seenText.set(normalized, occurrence + 1);
    const hash = createHash('sha1').update(normalized + ':' + occurrence).digest('hex').slice(0, 16);
    tasks.push({
      id: uuidPattern.test(storedId ?? '') || /^[a-f0-9]{16}$/i.test(storedId ?? '') ? storedId : hash,
      text, done: marker.toLowerCase() === 'x',
      ...(uuidPattern.test(experimentId ?? '') ? { experimentId } : {}),
      lineIndex, hasId: Boolean(storedId),
    });
  }
  return tasks;
}

function changedPlanBody(plan) {
  const newline = plan.body.includes('\r\n') ? '\r\n' : '\n';
  const lines = plan.body.split(/\r?\n/);
  for (const task of plan.tasks) {
    if (task.lineIndex === undefined || !task.changed) continue;
    const original = lines[task.lineIndex];
    if (original === undefined) continue;
    const updated = original.replace(/^(\s*-\s+\[)[ xX](\])/, '$1' + (task.done ? 'x' : ' ') + '$2');
    lines[task.lineIndex] = task.hasId
      ? updated
      : updated + ' <!-- task:' + task.id + (task.experimentId ? ' experiment:' + task.experimentId : '') + ' -->';
  }
  const additions = plan.tasks.filter(task => task.lineIndex === undefined);
  if (additions.length) {
    const previous = lines.join(newline);
    return previous + (previous && !previous.endsWith('\n') && !previous.endsWith('\r') ? newline : '') + taskMarkdown(additions).replace(/\n/g, newline);
  }
  return lines.join(newline);
}

export function createResearchStore(dataRoot, { getDayStartMinutes = () => 0 } = {}) {
  const documents = path.join(path.resolve(dataRoot), 'Documents');
  const experimentsDir = path.join(documents, 'Experiments');
  const plansDir = path.join(documents, 'Plans');
  const planDirs = { day: path.join(plansDir, 'Daily'), week: path.join(plansDir, 'Weekly') };
  let queue = Promise.resolve();
  const serialize = task => {
    const pending = queue.then(task);
    queue = pending.catch(() => {});
    return pending;
  };

  async function ensureDocuments() {
    const base = await realpath(path.dirname(documents));
    await mkdir(path.join(base, 'Documents'), { recursive: true });
    const actual = await realpath(documents);
    if (path.relative(base, actual) !== 'Documents') throw new Error('文档目录必须位于工作台 Documents 文件夹。');
    return actual;
  }

  async function ensureChild(target, parent, name) {
    const parentActual = await realpath(parent);
    if (path.relative(await ensureDocuments(), parentActual) !== path.relative(await ensureDocuments(), path.resolve(parent))) {
      throw new Error('文档目录指向工作台 Documents 文件夹之外。');
    }
    await mkdir(path.join(parentActual, name), { recursive: true });
    const actual = await realpath(target);
    if (path.relative(parentActual, actual) !== name) throw new Error('文档分类目录指向了其他位置。');
    return actual;
  }

  const ensureExperiments = async () => {
    const parent = await ensureDocuments();
    return ensureChild(experimentsDir, parent, 'Experiments');
  };
  const ensurePlans = async () => {
    const parent = await ensureDocuments();
    return ensureChild(plansDir, parent, 'Plans');
  };
  async function ensurePlan(period) {
    if (!periods.has(period)) throw new Error('计划类型须为 day 或 week。');
    const parent = await ensurePlans();
    const category = period === 'day' ? 'Daily' : 'Weekly';
    await mkdir(path.join(parent, category), { recursive: true });
    const actual = await realpath(planDirs[period]);
    if (path.relative(parent, actual) !== category) throw new Error('计划目录指向了其他位置。');
    return actual;
  }

  async function atomicWrite(directory, filename, contents) {
    if (path.basename(filename) !== filename || filename === '.' || filename === '..') throw new Error('记录文件名无效。');
    const root = await realpath(directory);
    const file = path.join(root, filename);
    if (path.relative(root, file) !== filename) throw new Error('记录路径无效。');
    const temp = path.join(root, filename + '.' + randomUUID() + '.pending');
    try {
      await writeFile(temp, contents, { encoding: 'utf8', flag: 'wx' });
      await rename(temp, file);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  async function readExperimentFile(file, expectedId = null) {
    try {
      const actual = await realpath(file);
      const root = await ensureExperiments();
      const relative = path.relative(root, actual);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep) || path.extname(actual).toLowerCase() !== '.md') return null;
      const source = await readFile(actual, 'utf8');
      const { metadata, body } = splitMarkdown(source);
      const id = metadata.id;
      if (typeof id !== 'string' || !uuidPattern.test(id) || (expectedId && id.toLowerCase() !== expectedId.toLowerCase())) return null;
      const content = sections(body, id);
      const info = await stat(actual);
      const item = {
        id,
        name: typeof metadata.name === 'string' ? metadata.name : body.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(file, '.md'),
        date: typeof metadata.date === 'string' ? metadata.date : localDate(info.mtime, getDayStartMinutes),
        progress: Number.isFinite(metadata.progress) ? Math.max(0, Math.min(100, Math.round(metadata.progress))) : 0,
        next: typeof metadata.next === 'string' ? metadata.next : '',
        design: content.design ?? '',
        rounds: content.rounds ?? '',
        issues: content.issues ?? '',
        conclusion: content.conclusion ?? '',
        completed: metadata.completed === true,
        createdAt: typeof metadata.createdAt === 'string' ? metadata.createdAt : info.birthtime.toISOString(),
        updatedAt: info.mtime.toISOString(),
        revision: Number.isInteger(metadata.revision) && metadata.revision > 0 ? metadata.revision : 1,
        contentHash: createHash('sha256').update(source).digest('hex'),
        metadata,
        sourcePath: actual,
      };
      parseDate(item.date);
      return item;
    } catch {
      return null;
    }
  }

  async function findExperiment(id) {
    if (typeof id !== 'string' || !uuidPattern.test(id)) return null;
    const root = await ensureExperiments();
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
      const item = await readExperimentFile(path.join(root, entry.name), id);
      if (item) return item;
    }
    return null;
  }

  async function loadPlan(period, date) {
    const normalizedDate = period === 'week' ? mondayDate(date) : localDate(parseDate(date));
    const root = await ensurePlan(period);
    const filename = normalizedDate + '.md';
    const file = path.join(root, filename);
    let tasks = [];
    let metadata = Object.create(null);
    let body = '';
    let exists = false;
    try {
      const actual = await realpath(file);
      if (path.relative(root, actual) !== filename) throw new Error('计划文档路径无效。');
      const loaded = splitMarkdown(await readFile(actual, 'utf8'));
      metadata = loaded.metadata;
      body = loaded.body;
      exists = true;
      if ((metadata.date !== undefined && metadata.date !== normalizedDate) ||
          (metadata.period !== undefined && metadata.period !== period)) {
        throw new Error('计划文档的日期或类型与文件名不符，已保留原文件内容。');
      }
      tasks = parseTasks(body);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return { period, date: normalizedDate, tasks, file, root, body, metadata, exists };
  }

  return {
    async listExperiments() {
      const root = await ensureExperiments();
      const entries = await readdir(root, { withFileTypes: true });
      const items = [];
      for (const entry of entries) {
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
        const item = await readExperimentFile(path.join(root, entry.name));
        if (item) items.push(item);
      }
      return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    saveExperiment(input) {
      return serialize(async () => {
        if (!input || typeof input !== 'object') throw new Error('实验信息无效。');
        let prior = null;
        if (input.id !== undefined) {
          prior = await findExperiment(input.id);
          if (!prior) throw new Error('找不到要修改的实验。');
          if (input.revision !== undefined && input.revision !== prior.revision) throw new Error('实验内容已在其他位置修改，请重新载入后保存。');
          if (input.contentHash !== undefined && input.contentHash !== prior.contentHash) throw new Error('实验 Markdown 已在其他位置修改，请重新载入后保存。');
        }
        const item = cleanExperiment(input, prior);
        const root = await ensureExperiments();
        const filename = prior ? path.basename(prior.sourcePath) : item.id + '.md';
        if (!prior) {
          try {
            await readFile(path.join(root, filename));
            throw new Error('实验编号已存在。');
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        const metadata = {
          ...prior?.metadata, id: item.id, schema: prior?.metadata?.schema ?? 1, name: item.name, date: item.date, progress: item.progress,
          next: item.next, completed: item.completed, createdAt: item.createdAt, revision: item.revision,
        };
        await atomicWrite(root, filename, frontMatter(metadata, experimentMarkdown(item)));
        return item;
      });
    },

    async getPlan({ period, date = localDate(new Date(), getDayStartMinutes) } = {}) {
      const result = await loadPlan(period, date);
      return { period: result.period, date: result.date, tasks: result.tasks };
    },

    mutatePlan({ period, date = localDate(new Date(), getDayStartMinutes), action, text = '', id, done, experimentId } = {}) {
      return serialize(async () => {
        if (!['add', 'toggle'].includes(action)) throw new Error('计划操作无效。');
        const plan = await loadPlan(period, date);
        if (action === 'add') {
          const experiment = experimentId ? await findExperiment(experimentId) : null;
          if (experimentId && !experiment) throw new Error('关联的实验不存在。');
          const taskText = String(text || experiment?.next || '').trim().replace(/\r?\n/g, ' ');
          if (!taskText) throw new Error('待办内容不能为空。');
          if (taskText.length > 500) throw new Error('待办内容不能超过 500 个字符。');
          const duplicate = plan.tasks.some(task =>
            (experimentId && task.experimentId === experimentId &&
              task.text.normalize('NFKC').trim().toLocaleLowerCase() === taskText.normalize('NFKC').trim().toLocaleLowerCase()) ||
            (!experimentId && !task.experimentId && task.text.normalize('NFKC').trim().toLocaleLowerCase() === taskText.normalize('NFKC').trim().toLocaleLowerCase())
          );
          if (!duplicate) plan.tasks.push({ id: randomUUID(), text: taskText, done: false, ...(experimentId ? { experimentId } : {}) });
        } else {
          if (typeof id !== 'string' || !(uuidPattern.test(id) || /^[a-f0-9]{16}$/i.test(id))) throw new Error('待办编号无效。');
          const task = plan.tasks.find(item => item.id === id);
          if (!task) throw new Error('找不到这条待办。');
          task.done = typeof done === 'boolean' ? done : !task.done;
          task.changed = true;
        }
        const metadata = { ...plan.metadata, id: plan.metadata.id ?? createHash('sha256').update(path.relative(documents, plan.file)).digest('hex').slice(0, 32), schema: plan.metadata.schema ?? 1, period: plan.period, date: plan.date, updatedAt: new Date().toISOString() };
        await atomicWrite(plan.root, path.basename(plan.file), frontMatter(metadata, changedPlanBody(plan), true));
        return { period: plan.period, date: plan.date, tasks: plan.tasks };
      });
    },
  };
}
