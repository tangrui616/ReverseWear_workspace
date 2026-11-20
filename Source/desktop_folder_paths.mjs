import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

export function safeRelativePath(value = '') {
  if (typeof value !== 'string' || value.includes('\\') || value.includes(':')) throw new Error('文件夹路径无效。');
  if (!value) return '';
  const parts = value.split('/');
  if (parts.some(part => !part || part.startsWith('.') || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw new Error('文件夹路径无效。');
  return parts.join('/');
}

export async function resolveFolderPath(root, relativePath = '') {
  const safeRoot = path.resolve(root);
  const rootInfo = await lstat(safeRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || path.relative(safeRoot, await realpath(safeRoot))) {
    throw new Error('文档根目录不安全。');
  }
  const relative = safeRelativePath(relativePath);
  let current = safeRoot;
  for (const part of relative ? relative.split('/') : []) {
    current = path.join(current, part);
    const info = await lstat(current);
    const actual = await realpath(current);
    if (info.isSymbolicLink() || path.relative(current, actual)) throw new Error('文件或目录指向了其他位置。');
    current = actual;
  }
  return current;
}
