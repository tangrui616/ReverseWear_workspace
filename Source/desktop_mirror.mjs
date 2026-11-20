import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { watch as watchDirectory } from 'node:fs';
import path from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const relativeInside = (root, file) => {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative) ? relative : null;
};

function sameResolvedPath(left, right) {
  const a = path.resolve(left).replace(/[\\/]+$/, '');
  const b = path.resolve(right).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function allowedDocumentPath(relative) {
  const parts = relative.split(/[\\/]+/);
  if (parts.some(part => !part || part.startsWith('.'))) return false;
  if (['Notes', 'Daily', 'Weekly', 'Memos', 'Experiments', 'Ideas', 'Inbox', 'ThinkingPages'].includes(parts[0])) return parts.length === 2;
  if (parts[0] === 'Plans') return parts.length === 3 && ['Daily', 'Weekly'].includes(parts[1]);
  if (parts[0] === 'Links') return parts.length === 2;
  if (parts[0] === 'LinkNotes') return parts.length === 3;
  return false;
}

function parseMarkdown(source) {
  const clean = source.replace(/^\uFEFF/, '');
  const match = clean.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?([\s\S]*)$/);
  const metadata = Object.create(null);
  if (!match) return { metadata, body: clean, error: /^---\r?\n/.test(clean) ? 'Front matter is not closed.' : null };
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const index = line.indexOf(':');
    if (index < 1) return { metadata, body: match[2], error: 'Front matter contains an unsupported field.' };
    const key = line.slice(0, index).trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || Object.hasOwn(metadata, key)) return { metadata, body: match[2], error: 'Front matter contains an invalid or duplicate key.' };
    const value = line.slice(index + 1).trim();
    const scalar = value.replace(/\s+#.*$/, '').trim();
    try {
      if (key === 'private') {
        if (scalar !== 'true' && scalar !== 'false') throw new Error('private must be true or false');
        metadata[key] = scalar === 'true';
      } else if (key === 'schema') {
        if (!/^\d+$/.test(scalar)) throw new Error('schema must be an integer');
        metadata[key] = Number(scalar);
      } else if (scalar.startsWith("'")) {
        if (scalar.length < 2 || !scalar.endsWith("'")) throw new Error('invalid single-quoted scalar');
        metadata[key] = scalar.slice(1, -1).replace(/''/g, "'");
      } else if (scalar.startsWith('"') || scalar.startsWith('[') || scalar.startsWith('{')) {
        metadata[key] = JSON.parse(scalar);
      } else {
        metadata[key] = scalar;
      }
    } catch { return { metadata, body: match[2], error: `Front matter field ${key} is malformed.` }; }
  }
  if (metadata.id !== undefined && typeof metadata.id !== 'string') return { metadata, body: match[2], error: 'ID must be text.' };
  return { metadata, body: match[2], error: null };
}

function serializeMarkdown(metadata, body) {
  const header = Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
  return `---\n${header}\n---\n\n${body}`;
}

function parseIgnore(text) {
  return text.split(/\r?\n/).map(line => line.trim().replace(/\\/g, '/'))
    .filter(line => line && !line.startsWith('#'))
    .map(line => new RegExp('^' + line.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i'));
}

function isIgnored(relative, expressions) {
  const normalized = relative.split(path.sep).join('/');
  return expressions.some(expression => expression.test(normalized) || normalized.split('/').some(part => expression.test(part)));
}

function aiBlock(source) {
  const begin = '<!-- ai:begin -->';
  const end = '<!-- ai:end -->';
  const start = source.indexOf(begin);
  const finish = start < 0 ? -1 : source.indexOf(end, start + begin.length);
  if (start < 0 || finish < 0 || source.indexOf(begin, start + begin.length) >= 0 || source.indexOf(end, finish + end.length) >= 0) return null;
  return { start, finish, begin, end, value: source.slice(start + begin.length, finish) };
}

function withoutAiBlock(source) {
  const block = aiBlock(source);
  if (block) return (source.slice(0, block.start) + source.slice(block.finish + block.end.length)).trimEnd();
  return source.includes('<!-- ai:begin -->') || source.includes('<!-- ai:end -->') ? null : source.trimEnd();
}

function immutableSections(source) {
  const parsed = parseMarkdown(source);
  const original = parsed.body.match(/## 原话\s*\r?\n([\s\S]*?)(?=\r?\n## |$)/);
  return { id: parsed.metadata.id ?? null, original: original?.[1] ?? null };
}

export function createDesktopMirror({ documentsDirectory, mirrorDirectory, stateDirectory, beforeAccept, onAccepted }) {
  const documentsPath = path.resolve(documentsDirectory);
  const mirrorPath = path.resolve(mirrorDirectory);
  const statePath = path.join(path.resolve(stateDirectory), 'mirror-state.json');
  const journalPath = path.join(path.resolve(stateDirectory), 'mirror-accept-journal.json');
  const rejectedPath = path.join(path.resolve(stateDirectory), 'rejected');
  let queue = Promise.resolve();
  let state = null;
  const serialize = task => { const next = queue.then(task); queue = next.catch(() => {}); return next; };
  const ensureRoots = async () => {
    await mkdir(documentsPath, { recursive: true });
    await mkdir(mirrorPath, { recursive: true });
    await mkdir(path.dirname(statePath), { recursive: true });
    const [documents, mirror] = await Promise.all([realpath(documentsPath), realpath(mirrorPath)]);
    if (documents === mirror || relativeInside(documents, mirror) || relativeInside(mirror, documents)) throw new Error('AI 镜像必须与原始文档目录分开存放。');
    return { documents, mirror };
  };
  const readState = async () => {
    if (state) return state;
    try {
      const value = JSON.parse(await readFile(statePath, 'utf8'));
      if (!value || value.version !== 1 || !value.files || typeof value.files !== 'object') throw new Error('unsupported mirror state');
      state = value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('AI 镜像状态无法读取，审核已暂停。');
      state = { version: 1, files: {} };
    }
    return state;
  };
  const saveState = async () => {
    const temp = statePath + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    try { await rename(temp, statePath); } finally { await unlink(temp).catch(() => {}); }
  };
  const safeDocumentFile = async relative => {
    const roots = await ensureRoots();
    const candidate = path.resolve(roots.documents, relative);
    const safeRelative = path.relative(roots.documents, candidate);
    if (!relativeInside(roots.documents, candidate) || !allowedDocumentPath(safeRelative) || path.extname(candidate).toLowerCase() !== '.md') throw new Error('只允许共享受管理目录中的 Markdown 文件。');
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1 || info.size > 8 * 1024 * 1024) throw new Error('原始记录不是受支持的普通 Markdown 文件。');
    const actual = await realpath(candidate);
    if (!relativeInside(roots.documents, actual) || !sameResolvedPath(actual, candidate)) throw new Error('记录路径超出文档目录或经过链接跳转。');
    return { ...roots, actual, relative: path.relative(roots.documents, actual) };
  };
  const ignorePatterns = async () => {
    const roots = await ensureRoots();
    try {
      const file = path.join(roots.documents, '.aiignore');
      const info = await lstat(file);
      if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1 || info.size > 256 * 1024 || !sameResolvedPath(await realpath(file), file)) throw new Error('.aiignore 文件必须位于 Documents 内且不能是链接。');
      return parseIgnore(await readFile(file, 'utf8'));
    }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const checkSharePolicy = async (relative, text) => {
    if (/^Inbox[/\\]/.test(relative)) throw new Error('快速记录收件箱仅存于本机。可先转为灵感卡片，再单独授权。');
    const parsed = parseMarkdown(text);
    if (parsed.error) throw new Error(`Markdown 文件头无效：${parsed.error}`);
    if (parsed.metadata.private === true || (parsed.metadata.type === 'idea' && parsed.metadata.area === 'emotion')) {
      throw new Error('私密记录和情绪灵感不能共享。');
    }
    if (isIgnored(relative, await ignorePatterns())) throw new Error('此路径列在 .aiignore 中，不能共享。');
    const linkNotes = /^LinkNotes\/([^/]+)\//.exec(relative.split(path.sep).join('/'));
    if (linkNotes && await isLinkBlocked(linkNotes[1])) throw new Error('关联链接已设为 private 或列在 .aiignore，链接笔记不能共享。');
    return parsed;
  };
  const safeMirrorFile = async (relative, create = false) => {
    const roots = await ensureRoots();
    const candidate = path.resolve(roots.mirror, relative);
    if (!relativeInside(roots.mirror, candidate) || !allowedDocumentPath(path.relative(roots.mirror, candidate)) || path.extname(candidate).toLowerCase() !== '.md') throw new Error('镜像路径无效。');
    const parent = path.dirname(candidate);
    if (create) await mkdir(parent, { recursive: true });
    const realParent = await realpath(parent);
    if (!relativeInside(roots.mirror, realParent) || !sameResolvedPath(realParent, parent)) throw new Error('镜像目录指向了根目录之外或经过链接跳转。');
    try {
      const info = await lstat(candidate);
      const actual = await realpath(candidate);
      if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1 || info.size > 8 * 1024 * 1024) throw new Error('镜像记录不是受支持的普通 Markdown 文件。');
      if (!relativeInside(roots.mirror, actual) || !sameResolvedPath(actual, candidate)) throw new Error('镜像文件指向了根目录之外或经过链接跳转。');
      return actual;
    } catch (error) { if (error.code === 'ENOENT') return candidate; throw error; }
  };
  const atomicWrite = async (file, contents, exclusive = false) => {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temp, contents, { encoding: 'utf8', flag: 'wx' });
      if (exclusive) {
        try { await writeFile(file, contents, { encoding: 'utf8', flag: 'wx' }); }
        catch (error) { if (error.code === 'EEXIST') throw new Error('目标原件已存在，草稿未写入。'); throw error; }
        await unlink(temp);
      } else await rename(temp, file);
    } finally { await unlink(temp).catch(() => {}); }
  };
  const currentStatus = async entry => {
    let original, mirror;
    try { original = await readFile((await safeDocumentFile(entry.path)).actual, 'utf8'); }
    catch (error) { return { id: entry.id, path: entry.path, status: 'source-missing', error: error.message }; }
    const mirrorFile = await safeMirrorFile(entry.path);
    try { mirror = await readFile(mirrorFile, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { id: entry.id, path: entry.path, status: 'mirror-deleted', sourceHash: digest(original) };
      throw error;
    }
    const policy = parseMarkdown(original);
    if (policy.error) return { id: entry.id, path: entry.path, status: 'blocked-private', error: policy.error };
    if (policy.metadata.id !== entry.id) return { id: entry.id, path: entry.path, status: 'identity-conflict' };
    if (policy.metadata.private === true || /^Inbox[/\\]/.test(entry.path)
      || (policy.metadata.type === 'idea' && policy.metadata.area === 'emotion')) {
      return { id: entry.id, path: entry.path, status: 'blocked-private' };
    }
    if (isIgnored(entry.path, await ignorePatterns())) return { id: entry.id, path: entry.path, status: 'blocked-ignore' };
    const linkNotes = /^LinkNotes[/\\]([^/\\]+)[/\\]/.exec(entry.path);
    if (linkNotes && await isLinkBlocked(linkNotes[1])) return { id: entry.id, path: entry.path, status: 'blocked-private' };
    const sourceHash = digest(original), mirrorHash = digest(mirror);
    const sourceChanged = sourceHash !== entry.baseHash;
    const mirrorChanged = mirrorHash !== entry.baseHash;
    if (!sourceChanged && !mirrorChanged) return { id: entry.id, path: entry.path, status: 'synced', sourceHash, mirrorHash };
    if (sourceChanged && mirrorChanged) return { id: entry.id, path: entry.path, status: 'conflict', sourceHash, mirrorHash, base: entry.baseContent, source: original, mirror };
    if (sourceChanged) return { id: entry.id, path: entry.path, status: 'source-changed', sourceHash, mirrorHash, source: original };
    return { id: entry.id, path: entry.path, status: 'pending-review', sourceHash, mirrorHash, source: original, mirror };
  };

  async function list({ reconcile = true } = {}) {
    return serialize(async () => {
      await ensureRoots();
      await readState();
      const results = [];
      if (await markerExists(path.join(mirrorPath, '.harness-busy'))) return Object.values(state.files).map(entry => ({ id: entry.id, path: entry.path, status: 'busy' }));
      if (reconcile) await recoverJournal();
      let changed = false;
      for (const entry of Object.values(state.files)) {
        if (!state.files[entry.id]) continue;
        const status = await currentStatus(entry);
        if (!reconcile) results.push(status);
        else if (status.status === 'source-changed') {
          await atomicWrite(await safeMirrorFile(entry.path), status.source);
          entry.baseHash = status.sourceHash;
          entry.baseContent = status.source;
          results.push({ id: entry.id, path: entry.path, status: 'synced', sourceHash: status.sourceHash, mirrorHash: status.sourceHash });
          changed = true;
        } else if (status.status === 'blocked-private' || status.status === 'blocked-ignore') {
          await revokeSharedEntry(entry, status.status === 'blocked-private');
          results.push(status);
          changed = true;
        } else results.push(status);
      }
      if (changed) await saveState();
      return results;
    });
  }

  async function share(id, relativePath) {
    return serialize(async () => {
      await ensureRoots();
      await readState();
      if (await markerExists(path.join(mirrorPath, '.harness-busy'))) throw new Error('Harness 正在整理镜像，完成后再共享。');
      await recoverJournal();
      if (typeof id !== 'string' || !id || id.length > 160) throw new Error('记录编号无效。');
      const safe = await safeDocumentFile(relativePath);
      const source = await readFile(safe.actual, 'utf8');
      const parsed = await checkSharePolicy(safe.relative, source);
      if (parsed.metadata.id !== id) throw new Error('记录 ID 与文件不匹配。');
      const existing = state.files[id];
      if (existing && existing.path !== safe.relative) throw new Error('此 ID 已关联到另一条记录。');
      const mirrorFile = await safeMirrorFile(safe.relative, true);
      let mirror;
      try { mirror = await readFile(mirrorFile, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing) {
        const status = await currentStatus(existing);
        if (status.status !== 'synced') throw new Error('此记录有未处理的修改，请先审核。');
        const roots = await ensureRoots();
        const draftDirectory = path.join(roots.mirror, 'LinkNotes', id);
        await mkdir(draftDirectory, { recursive: true });
        if (!relativeInside(roots.mirror, await realpath(draftDirectory))) throw new Error('链接笔记草稿目录指向镜像之外。');
        return { ...status, mirrorPath: mirrorFile, draftDirectory };
      }
      if (mirror !== undefined) throw new Error('镜像中已有未登记文件，请先将其作为新草稿审核。');
      await atomicWrite(mirrorFile, source, true);
      state.files[id] = { id, path: safe.relative, baseHash: digest(source), baseContent: source, sharedAt: new Date().toISOString() };
      await saveState();
      const roots = await ensureRoots();
      const draftDirectory = path.join(roots.mirror, 'LinkNotes', id);
      await mkdir(draftDirectory, { recursive: true });
      if (!relativeInside(roots.mirror, await realpath(draftDirectory))) throw new Error('链接笔记草稿目录指向镜像之外。');
      return { id, path: safe.relative, status: 'synced', sourceHash: digest(source), mirrorHash: digest(source), mirrorPath: path.join(roots.mirror, safe.relative), draftDirectory };
    });
  }

  async function review({ id, action, expectedSourceHash, expectedMirrorHash, relativePath } = {}) {
    return serialize(async () => {
      await ensureRoots();
      await readState();
      if (await markerExists(path.join(mirrorPath, '.harness-busy'))) throw new Error('Harness 正在整理镜像，审核已暂停。');
      await recoverJournal();
      await expireRejected();
      if (action === 'reject-draft') {
        if (typeof relativePath !== 'string') throw new Error('草稿路径无效。');
        if (Object.values(state.files).some(entry => entry.path === relativePath)) throw new Error('已登记记录不能作为新草稿拒绝。');
        const file = await safeMirrorFile(relativePath);
        const content = await readFile(file, 'utf8');
        if (!expectedMirrorHash || digest(content) !== expectedMirrorHash) throw new Error('审核期间草稿已变化，请刷新后再拒绝。');
        const folder = path.join(rejectedPath, new Date().toISOString().slice(0, 10));
        const target = path.join(folder, path.basename(relativePath) + '.' + Date.now() + '.md');
        await mkdir(folder, { recursive: true });
        await atomicWrite(target, content, true);
        await unlink(file);
        return { status: 'rejected', archived: path.relative(rejectedPath, target) };
      }
      if (action === 'restore-deleted') {
        const entry = typeof id === 'string' ? state.files[id] : null;
        if (!entry) throw new Error('找不到已共享的记录。');
        const status = await currentStatus(entry);
        if (status.status !== 'mirror-deleted' || status.sourceHash !== expectedSourceHash) throw new Error('原件已变化或镜像文件已恢复，请刷新列表。');
        const source = await readFile((await safeDocumentFile(entry.path)).actual, 'utf8');
        await checkSharePolicy(entry.path, source);
        const mirrorFile = await safeMirrorFile(entry.path);
        if (await markerExists(mirrorFile)) throw new Error('镜像文件在恢复前重新出现，请刷新后审核。');
        await atomicWrite(mirrorFile, source, true);
        entry.baseHash = digest(source);
        entry.baseContent = source;
        await saveState();
        return { status: 'restored', id, path: entry.path };
      }
      if (!['accept', 'reject'].includes(action) || (id !== undefined && typeof id !== 'string')) throw new Error('审核操作无效。');
      const entry = id ? state.files[id] : null;
      if (!entry) {
        if (action !== 'accept' || typeof relativePath !== 'string') throw new Error('只有明确接受的新 Markdown 草稿才能写入原文档目录。');
        const mirrorFile = await safeMirrorFile(relativePath);
        const draft = await readFile(mirrorFile, 'utf8');
        if (!expectedMirrorHash || digest(draft) !== expectedMirrorHash) throw new Error('审核期间草稿已变化，请刷新差异后再接受。');
        const draftParsed = await checkSharePolicy(relativePath, draft);
        if (draftParsed.metadata.id && draftParsed.metadata.id !== id) throw new Error('草稿 ID 不匹配。');
        const roots = await ensureRoots();
        const safeRelative = path.normalize(relativePath);
        const destinationRelative = await safeDraftDestination(safeRelative, draftParsed.metadata);
        const destination = path.resolve(roots.documents, destinationRelative);
        if (!relativeInside(roots.documents, destination) || path.extname(destination).toLowerCase() !== '.md') throw new Error('新草稿目标路径无效。');
        await mkdir(path.dirname(destination), { recursive: true });
        if (!relativeInside(roots.documents, await realpath(path.dirname(destination)))) throw new Error('新草稿目录指向文档目录之外。');
        if (await markerExists(destination)) throw new Error('原始文档中已存在此路径，草稿未覆盖原件。');
        const newId = draftParsed.metadata.id ?? randomUUID();
        const metadata = { ...draftParsed.metadata, id: newId, schema: 1, createdAt: draftParsed.metadata.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
        const content = addFrontMatter(draftParsed.body, metadata);
        if (await hasDocumentId(newId)) throw new Error('已有文档使用此 ID，草稿未写入。');
        await beforeAccept?.({ relativePath: destinationRelative, bytes: null });
        if (digest(await readFile(mirrorFile, 'utf8')) !== expectedMirrorHash) throw new Error('审核期间草稿已变化，请刷新差异后再接受。');
        await atomicWrite(journalPath, JSON.stringify({ newFile: true, id: newId, path: destinationRelative, content, hash: digest(content) }, null, 2) + '\n');
        await atomicWrite(destination, content, true);
        await onAccepted?.({ relativePath: destinationRelative });
        await unlink(journalPath).catch(() => {});
        state.files[newId] = { id: newId, path: destinationRelative, baseHash: digest(content), baseContent: content, sharedAt: new Date().toISOString() };
        await saveState();
        return { status: 'accepted-new', id: newId, path: destinationRelative };
      }
      const current = await currentStatus(entry);
      if (!['pending-review', 'conflict'].includes(current.status) || current.sourceHash !== expectedSourceHash || current.mirrorHash !== expectedMirrorHash) throw new Error('审核期间文件已变化，请刷新差异后再审核。');
      if (action === 'reject') {
        const mirrorFile = await safeMirrorFile(entry.path);
        const folder = path.join(rejectedPath, new Date().toISOString().slice(0, 10));
        const target = path.join(folder, path.basename(entry.path) + '.' + Date.now() + '.md');
        await mkdir(folder, { recursive: true });
        await atomicWrite(target, current.mirror, true);
        await atomicWrite(mirrorFile, current.source);
        entry.baseHash = current.sourceHash;
        entry.baseContent = current.source;
        await saveState();
        return { status: 'rejected', archived: path.relative(rejectedPath, target) };
      }
      const sourceBase = immutableSections(entry.baseContent);
      const identity = immutableSections(current.source);
      const proposed = immutableSections(current.mirror);
      if (identity.id !== proposed.id || identity.original !== proposed.original) throw new Error('AI 修改了记录 ID 或「原话」，这份内容不能接受。');
      const baseBlock = aiBlock(entry.baseContent);
      const sourceBlock = aiBlock(current.source), proposedBlock = aiBlock(current.mirror);
      if (!proposedBlock || (withoutAiBlock(current.source) === null) || withoutAiBlock(current.mirror) === null || withoutAiBlock(entry.baseContent) === null) throw new Error('现有记录必须包含且只包含一个完整的 ai:begin / ai:end 区块。');
      if (baseBlock && !sourceBlock) throw new Error('原文中的 AI 区块已损坏，请先手动修复。');
      if (!baseBlock && sourceBlock) throw new Error('原文添加了新的 AI 区块，请先手动解决冲突。');
      if (withoutAiBlock(current.mirror) !== withoutAiBlock(entry.baseContent)) throw new Error('AI 修改了 AI 区块之外的正文或元数据，这份内容不能接受。');
      if (current.status === 'conflict') {
        if ((baseBlock && sourceBlock.value !== baseBlock.value) || !proposedBlock.value) throw new Error('原文和镜像同时修改了 AI 区块，请先手动解决冲突。');
        if (withoutAiBlock(current.mirror) !== withoutAiBlock(entry.baseContent)) throw new Error('镜像改动了 AI 区块以外的原文，请先手动解决冲突。');
        if (sourceBase.id !== identity.id || sourceBase.original !== identity.original) throw new Error('原文的固定身份或「原话」已改变，请先手动解决冲突。');
      }
      const merged = sourceBlock
        ? current.source.slice(0, sourceBlock.start + sourceBlock.begin.length) + proposedBlock.value + current.source.slice(sourceBlock.finish)
        : current.source.trimEnd() + '\n\n' + proposedBlock.begin + proposedBlock.value + proposedBlock.end + '\n';
      const latest = await currentStatus(entry);
      if (latest.sourceHash !== expectedSourceHash || latest.mirrorHash !== expectedMirrorHash) throw new Error('审核期间文件已变化，请刷新差异后再审核。');
      const sourceFile = (await safeDocumentFile(entry.path)).actual;
      const mirrorFile = await safeMirrorFile(entry.path);
      await beforeAccept?.({ relativePath: entry.path, bytes: Buffer.from(current.source, 'utf8') });
      const [sourceBeforeWrite, mirrorBeforeWrite] = await Promise.all([readFile(sourceFile, 'utf8'), readFile(mirrorFile, 'utf8')]);
      if (digest(sourceBeforeWrite) !== expectedSourceHash || digest(mirrorBeforeWrite) !== expectedMirrorHash) throw new Error('审核期间文件已变化，请刷新差异后再审核。');
      await atomicWrite(journalPath, JSON.stringify({ id, path: entry.path, sourceBefore: current.source, mirrorBefore: current.mirror, merged, hash: digest(merged) }, null, 2) + '\n');
      await atomicWrite(sourceFile, merged);
      await atomicWrite(mirrorFile, merged);
      await onAccepted?.({ relativePath: entry.path });
      entry.baseHash = digest(merged);
      entry.baseContent = merged;
      await saveState();
      await unlink(journalPath).catch(() => {});
      return { status: 'accepted', id, path: entry.path, hash: entry.baseHash };
    });
  }

  async function setPrivate(id, isPrivate, relativePath) {
    return serialize(async () => {
      await ensureRoots();
      await readState();
      if (await markerExists(path.join(mirrorPath, '.harness-busy'))) throw new Error('Harness 正在整理镜像，隐私设置已暂停。');
      await recoverJournal();
      if (typeof isPrivate !== 'boolean') throw new Error('隐私设置无效。');
      const entry = state.files[id];
      const file = await safeDocumentFile(relativePath ?? entry?.path);
      const source = await readFile(file.actual, 'utf8');
      const parsed = parseMarkdown(source);
      if (parsed.error) throw new Error(`Markdown 文件头无效：${parsed.error}`);
      if (parsed.metadata.id !== id) throw new Error('记录 ID 与文件不匹配。');
      let activeEntry = entry;
      if (!isPrivate && /^Inbox[/\\]/.test(file.relative)) throw new Error('快速记录收件箱仅存于本机。');
      if (!isPrivate && parsed.metadata.type === 'idea' && parsed.metadata.area === 'emotion') throw new Error('情绪灵感须保持私密。');
      if (!isPrivate && activeEntry) {
        const status = await currentStatus(activeEntry);
        if (status.status === 'blocked-private' || status.status === 'blocked-ignore') {
          await revokeSharedEntry(activeEntry);
          await saveState();
          activeEntry = null;
        } else if (status.status !== 'synced') throw new Error('此记录有待审核或冲突，先处理后再修改隐私设置。');
      }
      if (!isPrivate) {
        const linkNotes = /^LinkNotes[/\\]([^/\\]+)[/\\]/.exec(file.relative);
        if (linkNotes && await isLinkBlocked(linkNotes[1])) throw new Error('关联链接已设为 private 或列在 .aiignore，不能将此链接笔记设为公开。');
      }
      const updated = { ...parsed.metadata, private: isPrivate, schema: parsed.metadata.schema ?? 1, updatedAt: new Date().toISOString() };
      const nextSource = serializeMarkdown(updated, parsed.body);
      if (nextSource !== source) {
        await beforeAccept?.({ relativePath: file.relative, bytes: Buffer.from(source, 'utf8') });
        await atomicWrite(file.actual, nextSource);
        await onAccepted?.({ relativePath: file.relative });
      }
      if (isPrivate) {
        await archiveAndRemoveMirror(activeEntry?.path ?? file.relative);
        delete state.files[id];
        await archiveAndRemoveLinkNotes(id);
        removeLinkNoteEntries(id);
        await saveState();
        return { status: 'private', revoked: Boolean(activeEntry) };
      }
      if (activeEntry) {
        const checked = await checkSharePolicy(file.relative, nextSource);
        const mirrorFile = await safeMirrorFile(activeEntry.path);
        await atomicWrite(mirrorFile, nextSource);
        activeEntry.baseHash = digest(nextSource);
        activeEntry.baseContent = nextSource;
        await saveState();
        return { status: 'public-and-shared', metadata: checked.metadata };
      }
      return { status: 'public-not-shared', metadata: updated };
    });
  }

  async function scanDrafts() {
    return serialize(async () => {
      const roots = await ensureRoots();
      const items = [];
      if (await markerExists(path.join(mirrorPath, '.harness-busy'))) return items;
      const walk = async (directory, relative = '') => {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const item of entries) {
          if (item.name.startsWith('.') || (!relative && item.name.toLowerCase() === 'weekly-review')) continue;
          const nextRelative = path.join(relative, item.name);
          if (item.isSymbolicLink()) continue;
          if (item.isDirectory()) await walk(path.join(directory, item.name), nextRelative);
          else if (item.isFile() && path.extname(item.name).toLowerCase() === '.md') {
            let file;
            try { file = await safeMirrorFile(nextRelative); } catch { continue; }
            const text = await readFile(file, 'utf8');
            const metadata = parseMarkdown(text).metadata;
            if (!Object.values(state?.files ?? {}).some(entry => entry.path === nextRelative)) {
              try {
                await safeDraftDestination(nextRelative, metadata);
                await checkSharePolicy(nextRelative, text);
                items.push({ path: nextRelative, mirrorPath: path.join(roots.mirror, nextRelative), id: metadata.id ?? null, title: metadata.title ?? path.basename(item.name, '.md'), status: 'draft', hash: digest(text), content: text });
              } catch { /* Drafts outside approved Markdown areas stay out of the review list. */ }
            }
          }
        }
      };
      await readState();
      try { await walk(roots.mirror); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return items;
    });
  }

  async function expireRejected() {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    async function walk(directory) {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && (await stat(file)).mtimeMs < cutoff) await unlink(file);
      }
    }
    await walk(rejectedPath);
  }

  async function recover() {
    return serialize(async () => {
      await ensureRoots();
      await readState();
      await expireRejected();
      const busy = path.join(mirrorPath, '.harness-busy');
      try { await stat(busy); return { status: 'busy', items: [] }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await recoverJournal();
      const items = [];
      for (const entry of Object.values(state.files)) items.push(await currentStatus(entry));
      return { status: 'ready', items };
    });
  }

  async function snapshot(options) {
    const roots = await ensureRoots();
    const entries = await list(options);
    const drafts = await scanDrafts();
    return { entries, drafts, busy: await markerExists(path.join(roots.mirror, '.harness-busy')) };
  }

  async function watch(onChange) {
    await ensureRoots();
    const roots = await ensureRoots();
    let timer;
    let closed = false;
    const notifyChange = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (closed) return;
        try { onChange?.(await snapshot()); }
        catch (error) { onChange?.({ error: error.message }); }
      }, 180);
    };
    const watchers = [];
    for (const directory of [roots.documents, roots.mirror]) {
      try { watchers.push(watchDirectory(directory, { recursive: true }, notifyChange)); }
      catch (error) { for (const watcher of watchers) watcher.close(); throw new Error('无法监视本地文档变化。', { cause: error }); }
    }
    return () => {
      closed = true;
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    };
  }

  async function recoverJournal() {
    let journal;
    try { journal = JSON.parse(await readFile(journalPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw new Error('AI 审核写入日志损坏，写回已暂停。'); }
    if (journal.newFile === true) {
      if (typeof journal.content !== 'string' || digest(journal.content) !== journal.hash) throw new Error('新记录审核日志校验失败，写回已暂停。');
      const roots = await ensureRoots();
      const destinationRelative = await safeDraftDestination(journal.path, parseMarkdown(journal.content).metadata);
      const destination = path.resolve(roots.documents, destinationRelative);
      let content;
      try { content = await readFile(destination, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (content === undefined) await atomicWrite(destination, journal.content, true);
      else if (content !== journal.content) throw new Error('新记录写入期间目标文件又发生变化，已保留日志并暂停自动恢复。');
      await onAccepted?.({ relativePath: destinationRelative });
      state.files[journal.id] = { id: journal.id, path: destinationRelative, baseHash: journal.hash, baseContent: journal.content, sharedAt: new Date().toISOString() };
      await saveState();
      await unlink(journalPath);
      return;
    }
    const entry = state.files[journal.id];
    if (!entry || entry.path !== journal.path || typeof journal.merged !== 'string' || digest(journal.merged) !== journal.hash) throw new Error('AI 审核写入日志与记录不匹配，写回已暂停。');
    const sourceFile = (await safeDocumentFile(entry.path)).actual;
    const mirrorFile = await safeMirrorFile(entry.path);
    let source, mirror;
    try { [source, mirror] = await Promise.all([readFile(sourceFile, 'utf8'), readFile(mirrorFile, 'utf8')]); }
    catch { throw new Error('AI 审核写回中断，文件状态不完整，请从备份检查后恢复。'); }
    if (source === journal.sourceBefore && mirror === journal.mirrorBefore) {
      await unlink(journalPath);
      return;
    }
    if (source === journal.merged && mirror === journal.mirrorBefore) await atomicWrite(mirrorFile, journal.merged);
    else if (source === journal.sourceBefore && mirror === journal.merged) await atomicWrite(sourceFile, journal.merged);
    else if (source !== journal.merged || mirror !== journal.merged) throw new Error('AI 审核期间文件又发生变化，已保留日志并暂停自动恢复。');
    await onAccepted?.({ relativePath: entry.path });
    entry.baseHash = journal.hash;
    entry.baseContent = journal.merged;
    await saveState();
    await unlink(journalPath);
  }

  return { list, share, review, setPrivate, scanDrafts, recover, snapshot, watch };

  async function safeDraftDestination(relative, metadata) {
    const normalized = relative.split(path.sep).join('/');
    const parts = normalized.split('/');
    const allowedFolders = new Set(['Notes', 'Daily', 'Weekly', 'Memos', 'Experiments', 'Ideas', 'Inbox']);
    if (allowedFolders.has(parts[0]) && parts.length === 2 && parts[1].toLowerCase().endsWith('.md')) return path.join(parts[0], parts[1]);
    if (parts[0] === 'Plans' && parts.length === 3 && ['Daily', 'Weekly'].includes(parts[1]) && parts[2].toLowerCase().endsWith('.md')) return path.join(parts[0], parts[1], parts[2]);
    if (parts[0] === 'LinkNotes' && parts.length === 3 && parts[1] && parts[2].toLowerCase().endsWith('.md')) {
      if (metadata.relatedId !== parts[1]) throw new Error('链接笔记草稿必须携带对应的 relatedId。');
      const linkDirectory = path.join(documentsPath, 'Links');
      let entries = [];
      try { entries = await readdir(linkDirectory, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      let found = false;
      for (const entry of entries) {
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
        try {
          const safeLink = await safeDocumentFile(path.join('Links', entry.name));
          const link = parseMarkdown(await readFile(safeLink.actual, 'utf8'));
          if (link.metadata.id === parts[1] && !link.metadata.private) { found = true; break; }
        } catch {}
      }
      if (!found) throw new Error('找不到此链接的公开原始记录。');
      return path.join('LinkNotes', parts[1], parts[2]);
    }
    throw new Error('新草稿必须位于支持的 Markdown 目录中。');
  }

  async function isLinkBlocked(id) {
    const linkDirectory = path.join(documentsPath, 'Links');
    let entries = [];
    try { entries = await readdir(linkDirectory, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
      try {
        const file = await safeDocumentFile(path.join('Links', entry.name));
        const link = parseMarkdown(await readFile(file.actual, 'utf8'));
        if (link.metadata.id === id) return link.metadata.private === true || isIgnored(path.join('Links', entry.name), await ignorePatterns());
      } catch {}
    }
    return true;
  }

  async function archiveAndRemoveMirror(relative) {
    const file = await safeMirrorFile(relative);
    let contents;
    try { contents = await readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const folder = path.join(rejectedPath, new Date().toISOString().slice(0, 10), 'privacy');
    const target = path.join(folder, path.basename(relative) + '.' + randomUUID() + '.md');
    await mkdir(folder, { recursive: true });
    await atomicWrite(target, contents, true);
    await unlink(file);
    return path.relative(rejectedPath, target);
  }

  async function archiveAndRemoveLinkNotes(id) {
    const directory = path.join(mirrorPath, 'LinkNotes', id);
    let actual;
    try { actual = await realpath(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!relativeInside(mirrorPath, actual)) throw new Error('链接笔记镜像目录指向根目录之外。');
    const walk = async current => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const child = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') {
          await archiveAndRemoveMirror(path.relative(mirrorPath, child));
        }
      }
      await rmdir(current).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
    };
    await walk(actual);
  }

  function removeLinkNoteEntries(id) {
    const prefix = path.join('LinkNotes', id) + path.sep;
    for (const [sharedId, shared] of Object.entries(state.files)) if (shared.path.startsWith(prefix)) delete state.files[sharedId];
  }

  async function revokeSharedEntry(entry, privacyBlocked = false) {
    const linkNotes = /^LinkNotes[/\\]([^/\\]+)[/\\]/.exec(entry.path);
    if (linkNotes && privacyBlocked) {
      await archiveAndRemoveLinkNotes(linkNotes[1]);
      removeLinkNoteEntries(linkNotes[1]);
    } else {
      await archiveAndRemoveMirror(entry.path);
      if (entry.path.startsWith('Links' + path.sep) && (privacyBlocked || isIgnored(entry.path, await ignorePatterns()))) {
        await archiveAndRemoveLinkNotes(entry.id);
        removeLinkNoteEntries(entry.id);
      }
    }
    delete state.files[entry.id];
  }

  async function prepareNewDestination(root, relative) {
    const destination = path.resolve(root, relative);
    if (!relativeInside(root, destination) || path.extname(destination).toLowerCase() !== '.md') throw new Error('新草稿目标路径无效。');
    await mkdir(path.dirname(destination), { recursive: true });
    if (!relativeInside(root, await realpath(path.dirname(destination)))) throw new Error('新草稿目录指向文档目录之外。');
    try {
      const info = await lstat(destination);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('新草稿目标不是普通文件，无法写入。');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return destination;
  }

  async function hasDocumentId(id) {
    const roots = await ensureRoots();
    const walk = async directory => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name === 'Files') continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { if (await walk(file)) return true; }
        else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') {
          if (parseMarkdown(await readFile(file, 'utf8')).metadata.id === id) return true;
        }
      }
      return false;
    };
    return walk(roots.documents);
  }
}

async function markerExists(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function addFrontMatter(source, metadata) {
  const json = Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
  return `---\n${json}\n---\n\n${source.replace(/^\uFEFF/, '')}`;
}
