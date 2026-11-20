import { dialog, shell } from 'electron';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isWithin, saveDataPointer } from '../desktop_data_root.mjs';
import { portablePath } from './services.mjs';

const samePath = (left, right) => path.relative(left, right) === '';

/** @param {import('./ipc.mjs').RegisterHandler} register */
export function registerRiskHandlers(register, {
  win, settings, DATA, dataLocation, fixtureRoot, chooseDataRoot, pointerFile, portableDirectory,
  relaunchWorkbench, renderActive, sendActivity, recordByPath, toolsDirectory, gitSnapshots, history,
  records, mirror, mirrorDirectory, linkSnapshots, search,
}) {
  register('risk:activity', renderActive);
  register('risk:preferences', () => settings.getRiskPreferences());
  register('risk:preferences-save', value => {
    const changes = {};
    for (const key of ['dayStartMinutes', 'lowPower', 'showOuroboros', 'warnActionLimit']) {
      if (Object.hasOwn(value ?? {}, key)) changes[key] = value[key];
    }
    const updated = settings.saveRiskPreferences(changes);
    sendActivity();
    return updated;
  });
  register('risk:root', () => ({
    root: DATA, warning: dataLocation.warning, portable: dataLocation.portable, source: dataLocation.source,
  }));
  register('risk:pick-root', async () => {
    if (fixtureRoot) throw new Error('测试进程使用隔离数据目录。');
    const selection = await chooseDataRoot(win, DATA);
    if (!selection || samePath(selection.root, DATA)) return null;
    const result = await dialog.showMessageBox(win, {
      type: selection.warning ? 'warning' : 'question', buttons: ['切换并重启', '取消'], defaultId: 1, cancelId: 1,
      message: '使用新的本地数据目录？', detail: [selection.root, selection.warning, '现有文档留在原处。'].filter(Boolean).join('\n'),
    });
    if (result.response !== 0) return null;
    if (await win.webContents.executeJavaScript('window.dispatchEvent(new Event("beforeunload", {cancelable:true}))') !== true) {
      throw new Error('请先保存当前编辑，再切换数据目录。');
    }
    await saveDataPointer(pointerFile, selection.root, { portableDirectory });
    relaunchWorkbench();
    return selection;
  });
  register('risk:pick-backup', async () => {
    const result = await dialog.showOpenDialog(win, { title: '选择额外的备份目录', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return settings.getRiskPreferences();
    const target = await realpath(result.filePaths[0]);
    if (target === path.parse(target).root || !samePath(target, result.filePaths[0])) throw new Error('请选择具体的备份文件夹。');
    if (isWithin(DATA, target) || isWithin(target, DATA)) throw new Error('请选择当前工作台数据目录之外的备份文件夹。');
    return settings.saveRiskPreferences({ backupDirectory: target });
  });
  register('risk:clear-backup', () => settings.saveRiskPreferences({ backupDirectory: null }));
  register('risk:snapshot', () => gitSnapshots('manual'));
  register('risk:snapshots', () => history.listSnapshots());
  register('risk:history', relativePath => history.listRecordHistory(portablePath(relativePath)));
  register('risk:restore-record', async (relativePath, revision) => {
    const before = await recordByPath(relativePath);
    if (before.private) throw new Error('记录目前属于私密内容。请用 ZIP 恢复到独立目录查阅历史稿。');
    if (await lstat(path.join(mirrorDirectory, '.harness-busy')).then(() => true, () => false)) {
      throw new Error('Harness 正在访问镜像，请在整理完成后恢复。');
    }
    const result = await history.restoreRecord(portablePath(relativePath), revision);
    await mirror.list();
    return result;
  });
  register('risk:restore-snapshot', async () => {
    const input = await dialog.showOpenDialog(win, { title: '选择要校验和恢复的 ZIP', properties: ['openFile'], filters: [{ name: 'ZIP', extensions: ['zip'] }] });
    if (input.canceled) return null;
    const output = await dialog.showOpenDialog(win, { title: '恢复到一个空目录', properties: ['openDirectory', 'createDirectory'] });
    if (output.canceled) return null;
    const target = await realpath(output.filePaths[0]);
    if (isWithin(DATA, target) || isWithin(target, DATA)) throw new Error('请选择工作台数据目录之外的空文件夹。');
    return history.restoreSnapshot(input.filePaths[0], target);
  });
  register('risk:migrate', () => records.migrate({ beforeMigrationSnapshot: () => gitSnapshots('pre-migration') }));
  register('risk:records', async () => (await records.list()).map(({ id, title, type, relativePath, private: privacy, metadata }) =>
    ({ id, title, type, relativePath, private: privacy, inheritedPrivacy: privacy && metadata?.private !== true, schema: metadata?.schema })));
  register('risk:search', search);
  register('risk:share', (id, relativePath) => mirror.share(id, relativePath));
  register('risk:privacy', (id, value, relativePath) => mirror.setPrivate(id, value, relativePath));
  register('risk:review', options => mirror.review(options));
  register('risk:mirror', async () => {
    const recovery = await mirror.recover();
    return recovery.status === 'busy'
      ? { recovery, entries: [], drafts: [] }
      : { recovery, entries: await mirror.list(), drafts: await mirror.scanDrafts() };
  });
  register('risk:mirror-status', async () => {
    const busy = await lstat(path.join(mirrorDirectory, '.harness-busy')).then(() => true, () => false);
    if (busy) return { busy, pending: 0 };
    const entries = await mirror.list();
    const drafts = await mirror.scanDrafts();
    return { busy, pending: entries.filter(item => !['synced', 'busy'].includes(item.status)).length + drafts.length };
  });
  register('risk:reveal-mirror', async () => {
    await mkdir(mirrorDirectory, { recursive: true });
    if (!samePath(mirrorDirectory, await realpath(mirrorDirectory))) throw new Error('镜像目录指向其他位置。');
    const error = await shell.openPath(mirrorDirectory);
    if (error) throw new Error(error);
  });
  register('risk:reveal-rejected', async () => {
    const folder = path.join(toolsDirectory, 'Mirror', 'rejected');
    await mkdir(folder, { recursive: true });
    if (!samePath(folder, await realpath(folder))) throw new Error('留档目录指向其他位置。');
    const error = await shell.openPath(folder);
    if (error) throw new Error(error);
  });
  register('risk:snapshot-save', (id, content) => linkSnapshots.save(id, content));
  register('risk:snapshot-list', id => linkSnapshots.list(id));
  register('risk:snapshot-read', (id, snapshotId) => linkSnapshots.read(id, snapshotId));
}
