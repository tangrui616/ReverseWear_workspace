import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

async function countMarkdown(documents, category) {
  const folder = path.join(documents, category);
  try {
    if (path.relative(await realpath(documents), await realpath(folder)) !== category) {
      throw new Error('开屏探针发现文档文件夹指向其他位置。');
    }
    const entries = await readdir(folder, { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && /\.md$/i.test(entry.name) &&
      !entry.name.startsWith('.') && !/(?:\.tmp|\.pending|\.swp|\.crdownload|~)\.md$/i.test(entry.name)).length;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

export async function probeStartup(dataRoot, documents, mirror) {
  try {
    const [noteCount, linkCount, snapshot] = await Promise.all([
      countMarkdown(documents, 'Notes'),
      countMarkdown(documents, 'Links'),
      mirror.snapshot({ reconcile: false }),
    ]);
    const reviewStates = new Set(['pending-review', 'conflict', 'mirror-deleted']);
    const files = snapshot.busy ? [] : [
      ...snapshot.entries.filter(item => reviewStates.has(item.status)).map(item => item.path),
      ...snapshot.drafts.map(item => item.path),
    ];
    return { ok: true, dataRoot, noteCount, linkCount, mirror: { changed: files.length, files, busy: snapshot.busy } };
  } catch (error) {
    console.warn('开屏数据探针：', error.message);
    return { ok: false };
  }
}
