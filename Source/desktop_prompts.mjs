import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseRecordMarkdown } from './desktop_records.mjs';

const validId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function createPromptLibrary(documentsDirectory) {
  const directory = path.join(documentsDirectory, 'Prompts');

  async function directoryExists(create = false) {
    if (create) await mkdir(directory, { recursive: true });
    const actual = await realpath(directory).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!actual) return false;
    if (path.relative(actual, directory) !== '') throw new Error('提示词目录不能使用重解析点。');
    return true;
  }

  async function readPrompt(id) {
    const file = path.join(directory, id + '.md');
    const info = await lstat(file).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info?.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return null;
    const { metadata, body } = parseRecordMarkdown(await readFile(file, 'utf8'));
    if (metadata.id !== id || metadata.type !== 'prompt' || typeof metadata.title !== 'string') return null;
    return { id, title: metadata.title, body, updatedAt: String(metadata.updatedAt || '') };
  }

  return {
    async list() {
      if (!await directoryExists()) return [];
      const entries = await readdir(directory, { withFileTypes: true });
      const prompts = await Promise.all(entries.filter(entry => entry.isFile() && entry.name.endsWith('.md') &&
        validId.test(entry.name.slice(0, -3))).map(entry => readPrompt(entry.name.slice(0, -3))));
      return prompts.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    },
    async save(input) {
      const title = typeof input?.title === 'string' ? input.title.trim() : '';
      const body = typeof input?.body === 'string' ? input.body : '';
      if (!title || title.length > 240 || !body.trim() || body.length > 120000) throw new Error('填写提示词标题和正文，正文最多 120000 字符。');
      if (input.id != null && (typeof input.id !== 'string' || !validId.test(input.id))) throw new Error('提示词编号无效。');
      await directoryExists(true);
      const id = input.id || randomUUID();
      if (input.id && !await readPrompt(id)) throw new Error('提示词文件不存在或无法读取。');
      const updatedAt = new Date().toISOString();
      const metadata = { id, type: 'prompt', schema: 1, title, updatedAt };
      const header = Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
      const file = path.join(directory, id + '.md');
      const pending = file + '.' + randomUUID() + '.pending';
      try {
        await writeFile(pending, `---\n${header}\n---\n\n${body}`, { encoding: 'utf8', flag: 'wx' });
        await rename(pending, file);
      } finally {
        await unlink(pending).catch(() => {});
      }
      return { id, title, body, updatedAt };
    },
  };
}
