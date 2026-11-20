import { app, dialog } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDesktopSettings } from './desktop_settings.mjs';
import { isWithin, resolveDataRoot, saveDataPointer, verifyDataRoot } from './desktop_data_root.mjs';
import { startWorkbench } from './main/start.mjs';

const samePath = (left, right) => path.relative(left, right) === '';
const directory = path.dirname(fileURLToPath(import.meta.url));
const launch = { window: null };
const portableCheck = app.isPackaged && process.argv.includes('--verify-portable');
const portableLanguageCheck = portableCheck && process.argv.includes('--verify-language-models');
const portableAdjacentCheck = portableCheck && process.argv.includes('--verify-portable-adjacent');
const portableLauncher = app.isPackaged && process.env.PORTABLE_EXECUTABLE_FILE;
const portableDirectory = portableLauncher && path.isAbsolute(portableLauncher)
  ? path.dirname(portableLauncher) : app.isPackaged ? path.dirname(process.execPath) : undefined;
const isolatedDev = !app.isPackaged && Boolean(process.env.STILLTIME_DEV_DATA_ROOT);
const fixtureRoot = isolatedDev ? path.resolve(process.env.STILLTIME_DEV_DATA_ROOT)
    : portableCheck ? path.join(app.getPath('temp'), 'ReverseWear-Portable-QA-' + process.pid) : null;
if (fixtureRoot) {
  let failed = false;
  process.on('uncaughtException', error => {
    console.error('隔离验收异常：', error);
    if (failed) return;
    failed = true;
    app.exit(1);
  });
}
const pointerFile = path.join(app.getPath('appData'), 'ReverseWear', 'public-data-root.json');
app.setName(fixtureRoot ? 'ReverseWear QA ' + createHash('sha256').update(fixtureRoot).digest('hex').slice(0, 12) : '反穿衣工作台');
const suiteDirectory = path.join(fixtureRoot || app.getPath('userData'), 'DesktopSuite');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = launch.window;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.on('window-all-closed', () => {
    if (!(isolatedDev && process.env.STILLTIME_DEV_CHECK === 'quit-v17')) app.quit();
  });
  app.whenReady().then(startFromDataRoot).catch(showStartupError);
}

function relaunchWorkbench() {
  app.relaunch(portableDirectory
    ? { execPath: portableLauncher || process.execPath, args: process.argv.slice(1) }
    : undefined);
  app.quit();
}

async function chooseDataRoot(win, defaultPath) {
  const options = { title: '选择反穿衣工作台的数据目录', properties: ['openDirectory'], defaultPath };
  const choice = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return choice.canceled ? null : verifyDataRoot(choice.filePaths[0]);
}

async function startFromDataRoot() {
  let dataLocation;
  try {
    if (fixtureRoot) {
      await mkdir(fixtureRoot, { recursive: isolatedDev });
      if (portableAdjacentCheck) {
        const temporary = await realpath(app.getPath('temp'));
        const launcherRoot = portableDirectory && await realpath(portableDirectory);
        if (!launcherRoot || samePath(temporary, launcherRoot) || !isWithin(temporary, launcherRoot)) {
          throw new Error('便携同级验收需要从临时目录启动。');
        }
        dataLocation = await resolveDataRoot({
          pointerFile: path.join(fixtureRoot, 'data-root.json'), portableDirectory: launcherRoot, defaultDataRoot: fixtureRoot,
        });
        if (dataLocation.source !== 'portable' || !samePath(dataLocation.root, launcherRoot)) {
          throw new Error('便携同级验收需要准备 Documents/Notes 和更新说明夹具。');
        }
      } else {
        dataLocation = await verifyDataRoot(fixtureRoot);
      }
    } else {
      dataLocation = await resolveDataRoot({ pointerFile, portableDirectory });
    }
  } catch (error) {
    if (fixtureRoot) throw error;
    for (;;) {
      const result = await dialog.showMessageBox({
        type: 'error', buttons: ['选择其他数据目录', '退出'], cancelId: 1,
        message: '无法打开工作台数据目录', detail: error.message,
      });
      if (result.response !== 0) { app.quit(); return; }
      try {
        const choice = await chooseDataRoot(null, portableDirectory);
        if (!choice) { app.quit(); return; }
        if (choice.warning) {
          const confirm = await dialog.showMessageBox({ type: 'warning', message: choice.warning, detail: choice.root, buttons: ['继续', '返回'], cancelId: 1 });
          if (confirm.response !== 0) continue;
        }
        await saveDataPointer(pointerFile, choice.root, { portableDirectory });
        relaunchWorkbench();
        return;
      } catch (selectionError) { error = selectionError; }
    }
  }
  const { root } = dataLocation;
  const settings = openDesktopSettings(root);
  if (isolatedDev && process.env.STILLTIME_DEV_CHECK === 'focus') {
    const { prepareFocusFixture } = await import('./qa/Focus_Check_CodexV15.mjs');
    const folder = await prepareFocusFixture(root);
    settings.saveFolders([...new Set([...settings.getFolders(), folder])]);
  }
  app.setPath('userData', settings.profileDirectory);
  app.setPath('sessionData', settings.profileDirectory);
  app.setAppLogsPath(path.join(settings.runtimeDirectory, 'Logs'));
  return startWorkbench({
    settings, DATA: root, dataLocation, directory, launch, fixtureRoot, suiteDirectory,
    portableCheck, portableLanguageCheck, portableAdjacentCheck, portableDirectory, pointerFile,
    chooseDataRoot, relaunchWorkbench,
  });
}

function showStartupError(error) {
  console.error(error);
  if (portableCheck || (!app.isPackaged && process.env.STILLTIME_DEV_CHECK)) { app.exit(1); return; }
  dialog.showErrorBox('反穿衣工作台无法启动', error.message);
  app.exit(1);
}
