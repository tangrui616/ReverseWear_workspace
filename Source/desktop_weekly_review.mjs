import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getWorkDate } from './dist/date-boundary.mjs';
import { parseRecordMarkdown } from './desktop_records.mjs';

const decisionStatuses = new Map([
  ['action', 'action'], ['growing', 'growing'], ['fridge', 'fridge'], ['archived', 'archived'],
]);
const dayPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const weekPattern = /^(\d{4})-W(\d{2})$/;
const maxDraftBytes = 2 * 1024 * 1024;

function validDay(value) {
  const match = typeof value === 'string' && value.match(dayPattern);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function isoWeekForDay(day) {
  if (!validDay(day)) throw new Error('周复盘日期无效。');
  const [year, month, date] = day.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, date));
  const weekday = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - weekday);
  const isoYear = utc.getUTCFullYear();
  const first = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((utc - first) / 86400000) + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

function weekDays(week) {
  if (typeof week !== 'string' || !weekPattern.test(week)) throw new Error('周复盘周次无效。');
  const [year, number] = week.split('-W').map(Number);
  const jan4 = new Date(year, 0, 4);
  const monday = new Date(year, 0, 4 - ((jan4.getDay() + 6) % 7) + (number - 1) * 7);
  if (isoWeekForDay(`${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`) !== week) throw new Error('周复盘周次无效。');
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday);
    day.setDate(day.getDate() + index);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  });
}

function yamlValue(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}

function renderReview(metadata, body) {
  const fields = Object.entries(metadata).map(([key, value]) => `${key}: ${yamlValue(value)}`).join('\n');
  return `---\n${fields}\n---\n\n${body}`;
}

function safeText(value, max = 10000) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function recapSections(recap) {
  return [
    ['本周最大的收获', recap.biggestWin], ['最卡的地方', recap.stuckPoint],
    ['下周只做哪三件事', recap.nextThree.map(value => '- ' + value.replace(/\r?\n/g, '\n  ')).join('\n')],
    ['本周心情', recap.mood],
  ];
}

function readRecap(stored) {
  const metadata = stored.parsed?.metadata ?? {};
  const fallback = { biggestWin: metadata.biggestWin ?? '', stuckPoint: metadata.stuckPoint ?? '',
    nextThree: Array.isArray(metadata.nextThree) ? metadata.nextThree : ['', '', ''], mood: metadata.mood ?? '' };
  const entries = [...(stored.parsed?.body ?? '').matchAll(/^<!-- weekly-review:(\d):begin -->\r?\n## [^\r\n]+\r?\n\r?\n([\s\S]*?)\r?\n<!-- weekly-review:\1:end -->/gm)];
  if (!entries.length) return fallback;
  const parts = new Map(entries.map(([, key, text]) => [key, text]));
  if (parts.size !== 4) throw new Error('周复盘小节标记不完整，请用编辑器修正原文件。');
  return { biggestWin: parts.get('0'), stuckPoint: parts.get('1'),
    nextThree: parts.get('2').replace(/^- /, '').split(/\r?\n- /, 3).map(value => value.replace(/\r?\n  /g, '\n')),
    mood: parts.get('3') };
}

export function createWeeklyReview(dataRoot, { ideas, getDayStartMinutes = () => 0, getPreferences = () => ({}), now = () => new Date() } = {}) {
  if (!ideas || typeof ideas.listIdeas !== 'function' || typeof ideas.saveIdea !== 'function') throw new Error('周复盘需要灵感卡片服务。');
  const root = path.resolve(dataRoot);
  const documents = path.join(root, 'Documents');
  const reviews = path.join(documents, 'WeeklyReviews');
  const draftDirectoryPath = path.join(root, 'AI-Mirror', 'Weekly-Review');
  let queue = Promise.resolve();
  const serialize = task => {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  };

  async function ensureUnder(parent, directory, label) {
    await mkdir(parent, { recursive: true });
    const parentInfo = await lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error(`${label}上级目录路径异常。`);
    const actualParent = await realpath(parent);
    if (actualParent !== parent) throw new Error(`${label}上级目录指向了其他位置。`);
    await mkdir(directory, { recursive: true });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label}目录路径异常。`);
    const actual = await realpath(directory);
    if (path.dirname(actual) !== actualParent) throw new Error(`${label}目录指向了允许范围外。`);
    return actual;
  }

  async function reviewFile(week, create = false) {
    const directory = await ensureUnder(documents, reviews, '周复盘');
    const file = path.join(directory, `${week}.md`);
    const info = await lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info && !create) return { file, info: null, content: null, parsed: null };
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error('周复盘文件路径异常。');
    const content = info ? await readFile(file, 'utf8') : null;
    const parsed = content === null ? null : parseRecordMarkdown(content);
    if (parsed && (parsed.metadata.type !== 'weekly-review' || parsed.metadata.week !== week)) throw new Error('周复盘文件内容与文件名不一致。');
    return { file, info, content, parsed };
  }

  async function atomicReviewWrite(file, before, metadata, body) {
    const pending = `${file}.${randomUUID()}.pending`;
    try {
      await writeFile(pending, renderReview(metadata, body), { encoding: 'utf8', flag: 'wx' });
      const info = await lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error('周复盘文件路径异常，原文件已保留。');
      const current = info ? await readFile(file, 'utf8') : null;
      if (current !== before) throw new Error('周复盘已在其他位置修改，请刷新后再保存。');
      await rename(pending, file);
    } finally {
      await unlink(pending).catch(() => {});
    }
  }

  async function currentWeek() {
    return isoWeekForDay(getWorkDate(now(), getDayStartMinutes()));
  }

  async function ensureDraftDirectory() {
    const parent = path.join(root, 'AI-Mirror');
    await ensureUnder(root, parent, 'Harness 周复盘草稿');
    return ensureUnder(parent, draftDirectoryPath, 'Harness 周复盘草稿');
  }

  async function listWeekIdeas({ week } = {}) {
    const selected = week ?? await currentWeek();
    const [start, end] = weekDays(selected).filter((_, index) => index === 0 || index === 6);
    const items = await ideas.listIdeas();
    return { week: selected, start, end, items: items.filter(item => {
      const createdDay = getWorkDate(new Date(item.createdAt), getDayStartMinutes());
      return createdDay >= start && createdDay <= end;
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) };
  }

  return {
    weekForDate: isoWeekForDay,
    async currentWeek() { return currentWeek(); },
    async listWeekIdeas(options) { return listWeekIdeas(options); },
    async getReview({ week } = {}) {
      const selected = week ?? await currentWeek();
      const days = weekDays(selected);
      const stored = await reviewFile(selected);
      const body = stored.parsed?.body ?? '';
      return {
        week: selected, start: days[0], end: days[6], updatedAt: stored.info?.mtime.toISOString() ?? null,
        recap: readRecap(stored),
        body,
      };
    },
    saveReview({ week, recap, expectedUpdatedAt } = {}) {
      return serialize(async () => {
        const selected = week ?? await currentWeek();
        weekDays(selected);
        const stored = await reviewFile(selected, true);
        if (expectedUpdatedAt !== undefined && (expectedUpdatedAt === null ? stored.info !== null : stored.info?.mtime.toISOString() !== expectedUpdatedAt)) throw new Error('周复盘已在其他位置修改，请刷新后再保存。');
        const { biggestWin: _win, stuckPoint: _stuck, nextThree: _next, mood: _mood, ...previous } = stored.parsed?.metadata ?? {};
        const recapValue = {
          biggestWin: safeText(recap?.biggestWin), stuckPoint: safeText(recap?.stuckPoint),
          nextThree: [0, 1, 2].map(index => safeText(recap?.nextThree?.[index], 2000)),
          mood: safeText(recap?.mood, 2000),
        };
        const metadata = { ...previous, id: previous.id ?? randomUUID(), type: 'weekly-review', schema: 1,
          title: '周复盘 ' + selected, date: weekDays(selected)[0], week: selected, private: true, updatedAt: now().toISOString() };
        const sections = recapSections(recapValue).map(([heading, text], index) =>
          `<!-- weekly-review:${index}:begin -->\n## ${heading}\n\n${text}\n<!-- weekly-review:${index}:end -->`);
        let body = stored.parsed?.body ?? '';
        if (/^<!-- weekly-review:\d:begin -->/m.test(body)) {
          readRecap(stored);
          body = body.replace(/^<!-- weekly-review:(\d):begin -->[\s\S]*?^<!-- weekly-review:\1:end -->/gm, (_match, index) => sections[Number(index)]);
        } else {
          body = [body.trimEnd() || '# ' + metadata.title, ...sections].join('\n\n') + '\n';
        }
        await atomicReviewWrite(stored.file, stored.content, metadata, body);
        return { week: selected, updatedAt: (await stat(stored.file)).mtime.toISOString(), recap: { ...recapValue, private: true } };
      });
    },
    decideIdeas({ week, decisions: selections } = {}) {
      return serialize(async () => {
        const selected = week ?? await currentWeek();
        weekDays(selected);
        if (!Array.isArray(selections) || selections.length > 500) throw new Error('周复盘决定列表无效。');
        const eligible = new Set((await listWeekIdeas({ week: selected })).items.map(item => item.id));
        const requests = new Map();
        for (const selection of selections) {
          const status = decisionStatuses.get(selection?.decision);
          if (!status || !eligible.has(selection.id) || requests.has(selection.id) || typeof selection.expectedUpdatedAt !== 'string') throw new Error('周复盘决定信息无效。');
          requests.set(selection.id, { ...selection, status });
        }
        const saved = [];
        const conflicts = [];
        for (const selection of requests.values()) {
          let item;
          try {
            item = await ideas.getIdea(selection.id);
            if (item.updatedAt !== selection.expectedUpdatedAt) throw new Error('卡片已更新，请重新决定。');
            saved.push(await ideas.saveIdea({ id: item.id, status: selection.status,
              weeklyDecision: { week: selected, decision: selection.decision }, expectedUpdatedAt: selection.expectedUpdatedAt }));
          } catch (error) {
            conflicts.push({ id: selection.id, title: item ? item.title || item.original.slice(0, 30) : '', error: error.message });
          }
        }
        const actionCount = (await ideas.listIdeas({ status: 'action' })).length;
        const warning = getPreferences()?.warnActionLimit !== false && actionCount > 3
          ? `当前有 ${actionCount} 个行动中的想法。` : '';
        return { items: saved, conflicts, warning };
      });
    },
    async draftDirectory() {
      return ensureDraftDirectory();
    },
    async readDraft({ week } = {}) {
      const selected = week ?? await currentWeek();
      weekDays(selected);
      const directory = await ensureDraftDirectory();
      const file = path.join(directory, `${selected}.md`);
      const info = await lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!info) return { week: selected, exists: false, content: '', updatedAt: null };
      const busy = await lstat(path.join(path.dirname(directory), '.harness-busy')).then(() => true, error => {
        if (error.code !== 'ENOENT') throw error;
        return false;
      });
      if (busy) return { week: selected, exists: true, busy: true, content: '', updatedAt: null };
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxDraftBytes) throw new Error('Harness 周复盘草稿文件异常或超过大小限制。');
      const content = await readFile(file, 'utf8');
      return { week: selected, exists: true, content, updatedAt: info.mtime.toISOString() };
    },
    writeDraftTemplate({ week } = {}) {
      return serialize(async () => {
        const selected = week ?? await currentWeek();
        weekDays(selected);
        const directory = await ensureDraftDirectory();
        const file = path.join(directory, `${selected}.md`);
        const content = `# 本周整理草稿 · ${selected}\n\n> 请 Harness 在本地 AI 镜像工作区内整理本周可供审核的想法。此模板不包含灵感正文。\n\n## 本周新想法\n\n## 建议合并的重复想法\n\n## 与旧想法的关联\n\n## 进行中项目的进度\n\n## 从冰箱重现的想法\n\n`;
        try { await writeFile(file, content, { encoding: 'utf8', flag: 'wx' }); }
        catch (error) { if (error.code === 'EEXIST') throw new Error('本周草稿已存在，未覆盖。'); throw error; }
        return { week: selected, path: file, created: true };
      });
    },
  };
}
