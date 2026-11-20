import { dialog } from 'electron';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/** @param {import('./ipc.mjs').RegisterHandler} register */
export function registerWallpaperHandlers(register, { win, settings, DATA, sceneDiagnostics, updateFolders, requestLibraryRefresh }) {
  register('scene:diagnostics', id => sceneDiagnostics.report(id));
  register('folders:list', async () => Promise.all(settings.getFolders().map(async folder => {
    try {
      await readdir(folder);
      return { folder, available: true };
    } catch (error) {
      return { folder, available: false, reason: error.code === 'ENOENT' ? '目录不存在' : '无读取权限或路径无效' };
    }
  })));
  register('folders:pick', async () => {
    const result = await dialog.showOpenDialog(win, { title: '添加壁纸文件夹', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths.length) return false;
    const folder = await realpath(result.filePaths[0]);
    if (!(await stat(folder)).isDirectory()) return false;
    const data = await realpath(DATA);
    const overlap = (parent, candidate) => {
      const relative = path.relative(parent, candidate);
      return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
    };
    if (overlap(data, folder) || overlap(folder, data)) {
      throw new Error(`请选择 ${DATA} 之外的具体壁纸目录。`);
    }
    const folders = settings.getFolders();
    if (!folders.some(value => value.toLowerCase() === folder.toLowerCase())) updateFolders([...folders, folder]);
    return true;
  });
  register('folders:remove', folder => {
    const folders = settings.getFolders();
    if (folders.includes(folder)) updateFolders(folders.filter(value => value !== folder));
  });
  register('library:refresh', requestLibraryRefresh);
}
