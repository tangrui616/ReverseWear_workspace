import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { noteIdentityId } from './desktop_note_identity.mjs';

const SCHEMA = 1;
const currentIds = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const legacyIds = /^[a-f0-9]{16}$/i;
const validId = value => typeof value === 'string' && (currentIds.test(value) || legacyIds.test(value));

export function parseRecordMarkdown(source, { ordinaryNotes = false } = {}) {
  const text = source.replace(/^\uFEFF/, '');
  const match = text.match(/^(?<open>---)(?<line>\r?\n)(?<front>[\s\S]*?)(?<line2>\r?\n)---\r?\n(?<blank>\r?\n)?(?<body>[\s\S]*)$/);
  if (!match) return { metadata: Object.create(null), body: text, hasFrontMatter: false, malformedFrontMatter: /^---(?:\r?\n|$)/.test(text) };
  const fields = match.groups.front.split(/\r?\n/).filter(line => line.trim());
  if (ordinaryNotes && (!fields.length || !/^[A-Za-z_][\w.-]*:\s+/.test(fields[0]))) {
    return { metadata: Object.create(null), body: text, hasFrontMatter: false, malformedFrontMatter: false };
  }
  const metadata = Object.create(null);
  const malformedMetadata = [];
  for (const line of fields) {
    const index = line.indexOf(': ');
    if (index <= 0) { if (line.trim()) malformedMetadata.push(line); continue; }
    try { metadata[line.slice(0, index)] = JSON.parse(line.slice(index + 2)); }
    catch { metadata[line.slice(0, index)] = line.slice(index + 2); }
  }
  return { metadata, body: match.groups.body, hasFrontMatter: true, newline: match.groups.line, malformedMetadata };
}

function addMetadata(source, metadata) {
  const parsed = parseRecordMarkdown(source);
  const newline = parsed.newline ?? (source.includes('\r\n') ? '\r\n' : '\n');
  if (!parsed.hasFrontMatter) {
    const header = Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(newline);
    const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
    const body = source.replace(/^\uFEFF/, '');
    return `${bom}---${newline}${header}${newline}---${newline}${newline}${body}`;
  }
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const close = lines.findIndex((line, index) => index > 0 && line === '---');
  const present = new Set(Object.keys(parsed.metadata));
  const additions = Object.entries(metadata)
    .filter(([key]) => !present.has(key))
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  lines.splice(close, 0, ...additions);
  return (source.startsWith('\uFEFF') ? '\uFEFF' : '') + lines.join(newline);
}

async function atomicReplace(file, contents, expectedHash) {
  const pending = `${file}.${randomUUID()}.pending`;
  try {
    await writeFile(pending, contents, { encoding: 'utf8', flag: 'wx' });
    if (sha256(await readFile(file)) !== expectedHash) throw new Error('迁移期间文件又被修改，原文件已保留。');
    await rename(pending, file);
  } finally {
    await unlink(pending).catch(() => {});
  }
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function relativeInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? relative
    : relative === '' ? '' : null;
}

export function isManagedMarkdown(relativePath) {
  const parts = relativePath.split(path.sep);
  const category = parts[0]?.toLowerCase();
  if (parts.length >= 2 && ['links', 'notes', 'daily', 'weekly', 'memos'].includes(category)) return true;
  if (parts.length >= 3 && category === 'linknotes' && validId(parts[1])) return true;
  if (parts.length === 2 && ['experiments', 'files', 'inbox', 'ideas', 'inspirationboard', 'weeklyreviews',
    'lifeexperiences', 'moodjournal', 'thinkingpages', 'contentboard', 'templates', 'customareas', 'vocabulary', 'terminology'].includes(category)) return true;
  if (parts.length === 3 && category === 'linkssnapshots' && validId(parts[1])) return true;
  return parts.length === 3 && category === 'plans' && ['daily', 'weekly'].includes(parts[1].toLowerCase());
}

export function createDesktopRecords(documentsDirectory) {
  const root = path.resolve(documentsDirectory);

  async function markdownFiles() {
    await mkdir(root, { recursive: true });
    const actualRoot = await realpath(root);
    if (process.platform === 'win32' ? actualRoot.toLowerCase() !== root.toLowerCase() : actualRoot !== root) {
      throw new Error('Documents 路径包含重解析点，迁移已停止。');
    }
    const files = [];
    const pending = [actualRoot];
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === '.stilltime' || entry.name.startsWith('.snapshot-')) continue;
        const candidate = path.join(directory, entry.name);
        const info = await lstat(candidate);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) pending.push(candidate);
        else if (info.isFile() && path.extname(entry.name).toLowerCase() === '.md') {
          const relativeCandidate = path.relative(actualRoot, candidate);
          if (relativeCandidate.split(path.sep)[0]?.toLowerCase() === 'notes' &&
              (entry.name.startsWith('.') || /(?:\.tmp|\.pending|\.swp|\.crdownload)(?:\.md)?$|~(?:\.md)?$/i.test(entry.name))) continue;
          const actual = await realpath(candidate);
          const relativePath = path.relative(actualRoot, actual);
          if (relativeInside(actualRoot, actual) !== null && isManagedMarkdown(relativePath)) files.push({ file: actual, relativePath });
        }
      }
    }
    return { actualRoot, files };
  }

  return {
    async list() {
      const { files } = await markdownFiles();
      const records = [];
      const parsedFiles = [];
      for (const { file, relativePath } of files) {
        const parsed = parseRecordMarkdown(await readFile(file, 'utf8'), {
          ordinaryNotes: relativePath.split(path.sep)[0]?.toLowerCase() === 'notes',
        });
        parsedFiles.push({ file, relativePath, parsed });
      }
      const privateLinks = new Set(parsedFiles.filter(({ relativePath, parsed }) =>
        relativePath.split(path.sep)[0] === 'Links' && parsed.metadata.type === 'link' && parsed.metadata.private === true
      ).map(({ parsed }) => parsed.metadata.id).filter(validId));
      for (const { file, relativePath, parsed } of parsedFiles) {
        const id = validId(parsed.metadata.id) ? parsed.metadata.id
          : relativePath.split(path.sep)[0]?.toLowerCase() === 'notes' ? noteIdentityId(relativePath) : null;
        const parts = relativePath.split(path.sep);
        const linkId = ['LinkNotes', 'LinksSnapshots'].includes(parts[0]) && validId(parts[1]) ? parts[1] : null;
        const inferredType = parts[0] === 'Plans' ? 'plan' : ({ Links: 'link', LinkNotes: 'link-note', LinksSnapshots: 'link-snapshot', Notes: 'note', Daily: 'daily', Weekly: 'weekly', Memos: 'memo', Experiments: 'experiment' })[parts[0]] ?? parts.at(-2) ?? 'document';
        records.push({
          id,
          type: typeof parsed.metadata.type === 'string' ? parsed.metadata.type : inferredType,
          title: typeof parsed.metadata.title === 'string' ? parsed.metadata.title : parsed.body.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(file, '.md'),
          relativePath,
          private: parsed.metadata.private === true || /^(MoodJournal|Vocabulary|Terminology)[/\\]/i.test(relativePath) || Boolean(linkId && privateLinks.has(linkId)),
          ...(linkId ? { linkId } : {}),
          body: parsed.body,
          metadata: { ...parsed.metadata },
        });
      }
      return records;
    },

    async migrate({ beforeMigrationSnapshot } = {}) {
      const { actualRoot, files } = await markdownFiles();
      const plans = [];
      const issues = [];
      const claimedIds = new Map();

      for (const entry of files) {
        const source = await readFile(entry.file, 'utf8');
        const parsed = parseRecordMarkdown(source, {
          ordinaryNotes: entry.relativePath.split(path.sep)[0]?.toLowerCase() === 'notes',
        });
        const metadata = { ...parsed.metadata };
        const filenameId = path.basename(entry.file, '.md');
        let id = metadata.id;
        if (id !== undefined && !validId(id)) {
          issues.push({ relativePath: entry.relativePath, reason: `无效的 id：${String(id)}` });
          continue;
        }
        if (parsed.malformedFrontMatter) {
          issues.push({ relativePath: entry.relativePath, reason: 'Markdown 文件头缺少有效的结束分隔符' });
          continue;
        }
        if (parsed.malformedMetadata?.length) {
          issues.push({ relativePath: entry.relativePath, reason: 'Markdown 文件头包含无法解析的字段行' });
          continue;
        }
        if (id === undefined && currentIds.test(filenameId)) id = filenameId;
        if (id === undefined) id = entry.relativePath.split(path.sep)[0]?.toLowerCase() === 'notes'
          ? noteIdentityId(entry.relativePath) : createHash('sha1').update(entry.file).digest('hex').slice(0, 16);
        if (currentIds.test(filenameId) && metadata.id && metadata.id.toLowerCase() !== filenameId.toLowerCase()) {
          issues.push({ relativePath: entry.relativePath, reason: '文件名 ID 与 Markdown 中的 ID 不一致' });
          continue;
        }
        const schema = metadata.schema;
        if (schema !== undefined && (!Number.isInteger(schema) || schema < 1)) {
          issues.push({ relativePath: entry.relativePath, reason: `schema 必须是大于 0 的整数：${String(schema)}` });
          continue;
        }
        const key = id.toLowerCase();
        const prior = claimedIds.get(key);
        if (prior) {
          issues.push({ relativePath: entry.relativePath, reason: `ID 与 ${prior} 重复` });
          continue;
        }
        claimedIds.set(key, entry.relativePath);
        if (Number.isInteger(schema) && schema > SCHEMA) {
          issues.push({ relativePath: entry.relativePath, reason: `schema ${schema} 高于本程序支持的版本 ${SCHEMA}` });
          continue;
        }
        metadata.id = id;
        metadata.schema = SCHEMA;
        const updated = addMetadata(source, { id, schema: SCHEMA });
        if (updated !== source) plans.push({ file: entry.file, contents: updated, expectedHash: sha256(source) });
      }

      if (issues.length) return { changed: 0, issues };
      if (plans.length && typeof beforeMigrationSnapshot !== 'function') throw new Error('迁移前必须先创建并校验 Markdown 快照。');
      if (plans.length) await beforeMigrationSnapshot();
      for (const plan of plans) {
        const actual = await realpath(plan.file);
        if (relativeInside(actualRoot, actual) === null) throw new Error('迁移路径已移出 Documents，操作已停止。');
        if (sha256(await readFile(actual)) !== plan.expectedHash) throw new Error(`快照完成后文件已被修改，迁移已停止：${path.relative(actualRoot, actual)}`);
        await atomicReplace(actual, plan.contents, plan.expectedHash);
      }
      return { changed: plans.length, issues: [] };
    },
  };
}
