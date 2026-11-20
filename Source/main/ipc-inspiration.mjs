import { dialog } from 'electron';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { INSPIRATION_IMAGE_EXTENSIONS } from '../desktop_resources.mjs';
import { checkExternalLink } from './external-link.mjs';
import { sendEvent } from './ipc.mjs';

/** @param {import('./ipc.mjs').RegisterHandler} register */
export function registerInspirationHandlers(register, { win, capture, ideas, rotation, mirror, board, workbench, saveWithTags }) {
  register('capture:open', () => { capture.openQuickCapture(); return true; });
  register('capture:shortcut', capture.shortcutState);
  register('capture:shortcut-save', capture.setCaptureShortcut);
  register('capture:save', async entry => {
    const text = String(entry?.text ?? '');
    if (!text.trim()) throw new Error('请先写下一句话。');
    const source = entry?.source ? checkExternalLink(String(entry.source)) : undefined;
    const result = await ideas.appendCapture({ text, source });
    if (!win.isDestroyed()) sendEvent(win.webContents, 'capture:saved', result.item);
    const captureWindow = capture.getWindow();
    if (captureWindow && !captureWindow.isDestroyed()) sendEvent(captureWindow.webContents, 'capture:saved', result.item);
    return result;
  });
  register('capture:list', options => ideas.listCaptures(options));
  register('capture:idea-create', item => saveWithTags(ideas.createIdea(item), item?.tags));
  register('capture:ideas', options => ideas.listIdeas(options));
  register('capture:today', () => rotation.getTodayResurfacing());
  register('capture:idea-save', async item => {
    const existing = item?.id ? await ideas.getIdea(item.id) : null;
    if (existing && item.expectedUpdatedAt && item.expectedUpdatedAt !== existing.updatedAt) {
      throw new Error('灵感已在其他位置更新，请刷新后再保存。');
    }
    const saved = await saveWithTags(ideas.saveIdea(item), item?.tags);
    if (existing && saved.private !== existing.private) {
      try {
        const statuses = await mirror.list();
        if (saved.private && statuses.some(status => status.id === saved.id && status.status === 'busy')) {
          return { ...saved, mirrorPrivacyStatus: 'pending' };
        }
      } catch (error) {
        console.error('灵感镜像同步：', error.message);
        if (saved.private) return { ...saved, mirrorPrivacyStatus: 'pending' };
      }
      return { ...saved, mirrorPrivacyStatus: saved.private ? 'revoked' : 'updated' };
    }
    return saved;
  });
  register('capture:close', () => {
    capture.close();
    return true;
  });
  register('inspiration:list', () => board.list());
  register('inspiration:save', item => board.save(item));
  register('inspiration:pick-image', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择灵感截图', properties: ['openFile'],
      filters: [{ name: '图片', extensions: INSPIRATION_IMAGE_EXTENSIONS.map(extension => extension.slice(1)) }],
    });
    if (result.canceled) return null;
    const filename = await realpath(result.filePaths[0]);
    if (!INSPIRATION_IMAGE_EXTENSIONS.includes(path.extname(filename).toLowerCase()) || !(await stat(filename)).isFile()) {
      throw new Error('请选择 PNG、JPEG、WebP、GIF 或 AVIF 图片。');
    }
    const { items, errors } = await workbench.importFiles([filename]);
    if (!items.length) throw new Error(errors[0]?.error ?? '图片导入失败。');
    return items[0];
  });
}
