import { app, clipboard, dialog, globalShortcut, ipcMain, nativeTheme } from 'electron';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createSuiteWindows } from '../desktop_suite/windowManager.mjs';
import { createHandlerRegistry, sendEvent } from './ipc.mjs';
import { registerArticleHandlers } from './ipc-articles.mjs';
import { registerInspirationHandlers } from './ipc-inspiration.mjs';
import { registerLanguageHandlers, translateSuiteText } from './ipc-language.mjs';
import { registerRiskHandlers } from './ipc-risk.mjs';
import { registerWallpaperHandlers } from './ipc-wallpaper.mjs';
import { registerWorkbenchHandlers } from './ipc-workbench.mjs';
import { APP, OUROBOROS, setupDesktopProtocol } from './protocol.mjs';
import { createDataServices, createWallpaperServices } from './services.mjs';
import { createWorkbenchWindow } from './windows.mjs';
import { createCaptureWindow } from './capture-window.mjs';
import { createArticleBrowser, saveCollectionLink } from './browser-view.mjs';
import { createPromptLibrary } from '../desktop_prompts.mjs';
import { probeStartup } from './startup-probe.mjs';

export async function startWorkbench({
  settings, DATA, dataLocation, directory, launch, fixtureRoot, suiteDirectory,
  portableCheck, portableLanguageCheck, portableAdjacentCheck, portableDirectory, pointerFile,
  chooseDataRoot, relaunchWorkbench,
}) {
  const checking = !app.isPackaged && process.env.STILLTIME_DEV_CHECK;
  const articleCheck = checking === 'suite-v18' ? await import('../qa/ArticleInbox_Check_CodexV18.mjs') : null;
  const portableVerification = portableCheck ? await import('../qa/portable-verification.mjs') : null;
  const articleLinksOpened = [];
  const translationOverride = fixtureRoot
    ? (portableLanguageCheck ? process.env.REVERSEWEAR_TRANSLATION_ASSETS : process.env.STILLTIME_DEV_TRANSLATION_ASSETS)
    : process.env.REVERSEWEAR_TRANSLATION_ASSETS;
  const translationDirectory = translationOverride ? path.resolve(translationOverride) : path.join(DATA, 'Translation');
  const sharedDictionaryCache = checking && process.env.STILLTIME_DEV_DICTIONARY_CACHE
    ? path.resolve(process.env.STILLTIME_DEV_DICTIONARY_CACHE)
    : null;
  const services = await createDataServices({
    settings, DATA, suiteDirectory, fixtureRoot, translationDirectory,
    sharedDictionaryCache,
    articlePages: articleCheck?.ARTICLE_FIXTURE_HTML,
    onIndexChange: categories => {
      const current = launch.window;
      if (current && !current.isDestroyed()) sendEvent(current.webContents, 'index:changed', categories);
    },
  });
  const { documentsDirectory, workbench, articles, dictionaries, translator, markdown, mirror, serialize, gitSnapshots } = services;
  const steamOverride = fixtureRoot
    ? (process.env.STILLTIME_DEV_STEAM_ROOT || path.join(fixtureRoot, 'NoSteam'))
    : process.env.REVERSEWEAR_STEAM_ROOT;
  const steamRoot = steamOverride ? path.resolve(steamOverride) : undefined;
  const wallpaper = createWallpaperServices({
    settings, steamRoot, discoverAdditionalRoots: !fixtureRoot,
  });
  const desktop = setupDesktopProtocol({ directory, DATA, workbench, articles, steamRoot, ...wallpaper });

  let suite;
  let suiteFailure;
  let capture;
  let browser;
  let windowMaterial = { material: 'solid', glassBlur: 24 };
  const testClipboard = fixtureRoot && checking === 'language-life' ? { text: '' } : null;
  const mainWindow = createWorkbenchWindow({
    directory, desktop, settings,
    isInTray: () => suite?.inTray(),
    closeServices: () => [browser?.close(), suite?.close(), services.afterWrites(() => articles?.shutdown())],
    getCaptureWindow: () => capture?.getWindow(),
  });
  const { win, quitFromTray, updateWindowColor, renderActive, sendActivity, isClosing } = mainWindow;
  browser = createArticleBrowser({ win, sendState: state => {
    if (!win.isDestroyed()) sendEvent(win.webContents, 'browser:state', state);
  } });
  const prompts = createPromptLibrary(documentsDirectory);
  capture = createCaptureWindow({ directory, desktop, settings });
  launch.window = win;
  mainWindow.attachNavigation();

  const { register, assertComplete } = createHandlerRegistry(ipcMain, { win, getCaptureWindow: capture.getWindow, serialize });
  mainWindow.registerWindowHandlers(register);
  function readySuite() {
    if (!suite) throw new Error(suiteFailure || '剪贴板尚未就绪。');
    return suite;
  }
  register('suite:open', () => readySuite().open());
  register('suite:clipboard-invoke', (operation, input) => readySuite().invokeClipboard(operation, input));
  register('suite:clipboard-read-text', async () => {
    const text = testClipboard ? testClipboard.text : await clipboard.readText();
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('剪贴板文字超过 1 MiB。');
    return text;
  });
  register('suite:clipboard-write-text', value => {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024 * 1024) throw new Error('复制内容必须是 1 MiB 以内的文字。');
    if (testClipboard) {
      testClipboard.text = value;
      return { written: true, text: value };
    }
    return readySuite().writeText(value);
  });
  register('prompts:list', () => prompts.list());
  register('prompts:save', input => prompts.save(input));
  register('browser:state', () => browser.state());
  register('browser:navigate', url => browser.navigate(url));
  register('browser:back', () => browser.back());
  register('browser:forward', () => browser.forward());
  register('browser:reload', () => browser.reload());
  register('browser:hide', () => browser.hide());
  register('browser:bounds', bounds => browser.setBounds(bounds));
  register('browser:open-external', () => browser.openExternal());
  const translateSelection = value => translateSuiteText(value, { dictionaries, translator });
  registerArticleHandlers(register, {
    win, articles, workbench, translateSuiteText: translateSelection, getSuite: () => suite, isClosing,
    trackOpenedLink: articleCheck ? url => articleLinksOpened.push(url) : null,
  });
  registerLanguageHandlers(register, services);
  registerInspirationHandlers(register, { win, capture, ...services });
  register('state:load', () => settings.getState());
  register('state:save', state => settings.saveState(state));
  register('startup:probe', () => probeStartup(DATA, documentsDirectory, mirror));
  register('appearance:load', () => settings.getAppearance());
  register('appearance:window-material', value => {
    const glassBlur = Number(value?.glassBlur);
    windowMaterial = {
      material: value?.material === 'glass' ? 'glass' : 'solid',
      glassBlur: Number.isFinite(glassBlur) ? Math.max(0, Math.min(48, Math.round(glassBlur))) : 24,
    };
    suite?.setTheme();
  });
  register('appearance:save', value => {
    const appearance = settings.saveAppearance(value);
    updateWindowColor();
    suite?.setTheme();
    return appearance;
  });
  registerRiskHandlers(register, {
    ...services, win, settings, DATA, dataLocation, fixtureRoot, chooseDataRoot, pointerFile, portableDirectory,
    relaunchWorkbench, renderActive, sendActivity,
  });
  registerWorkbenchHandlers(register, { win, ...services });
  registerWallpaperHandlers(register, { win, settings, DATA, ...wallpaper });
  assertComplete();

  const dailyBackup = () => serialize(() => gitSnapshots('daily')).catch(error => {
    if (!win.isDestroyed()) sendEvent(win.webContents, 'risk:backup-error', error.message);
    console.error('自动备份失败：', error.message);
  });
  const backupTimer = !fixtureRoot && setInterval(dailyBackup, 60 * 60 * 1000);
  let stopMirrorWatch;
  void mirror.watch(({ entries, drafts, error, busy }) => {
    if (win.isDestroyed()) return;
    sendEvent(win.webContents, 'risk:mirror-changed', error ? { error } : {
      pending: entries.filter(item => !['synced', 'unchanged', 'busy'].includes(item.status)).length + drafts.length,
      busy,
    });
  }).then(stop => {
    if (win.isDestroyed()) stop(); else stopMirrorWatch = stop;
  }).catch(error => console.error('镜像监控：', error.message));
  win.on('closed', () => {
    browser.close();
    void suite?.close().catch(() => {});
    if (!isClosing()) articles?.close();
    capture.close();
    globalShortcut.unregisterAll();
    clearInterval(backupTimer);
    stopMirrorWatch?.();
    markdown.close();
    dictionaries.close();
    translator.close();
    launch.window = null;
  });
  try {
    suite = await createSuiteWindows({
      directory, storage: suiteDirectory, mainWindow: win, verifyOnly: Boolean(fixtureRoot),
      testMode: portableCheck && process.argv.includes('--verify-shortcuts'),
      appearance: () => ({ ...settings.getAppearance(), ...windowMaterial }),
      quit: quitFromTray,
      saveNote: value => serialize(async () => {
        if (typeof value !== 'string' || !value.trim()) throw new Error('这条记录没有可追加的文字。');
        return workbench.appendClipboardNote(value);
      }),
      openWorkbench: async (command, filename) => {
        if (win.isDestroyed()) return;
        win.show();
        win.focus();
        if (command.startsWith('reader.')) {
          if (command === 'reader.open-pdf') {
            const result = await dialog.showOpenDialog(win, { title: '打开 PDF', properties: ['openFile'],
              filters: [{ name: 'PDF', extensions: ['pdf'] }] });
            if (result.canceled) return;
            filename = result.filePaths[0];
          }
          const info = await stat(filename);
          if (!info.isFile() || info.size > 32 * 1024 ** 2) throw new Error('请选择 32 MiB 以内的本地文件。');
          const result = await workbench.importFiles([filename]);
          if (!result.items.length) throw new Error(result.errors[0]?.message || '文件导入失败。');
          sendEvent(win.webContents, 'suite:workbench-action', { command, fileId: result.items[0].id });
          return;
        }
        sendEvent(win.webContents, 'suite:workbench-action', { command });
      },
      translate: translateSelection,
      collectArticle: url => serialize(async () => {
        const link = await saveCollectionLink(workbench, url);
        if (!win.isDestroyed()) sendEvent(win.webContents, 'articles:changed', { articleId: link.id });
        return { ...link, title: link.title || link.url };
      }),
      onLinkCaptured: ({ preview, id }) => {
        if (!win.isDestroyed() && win.isVisible()) sendEvent(win.webContents, 'articles:clipboard-link', { preview, id });
      },
      onArticleShortcut: result => {
        if (!win.isDestroyed() && win.isVisible()) sendEvent(win.webContents, 'articles:clipboard-result', result);
      },
    });
  } catch (error) {
    suiteFailure = '无法打开桌面效率套件的本地存储。';
    console.error('桌面效率套件初始化失败：', error.message);
    if (portableCheck || checking === 'suite-v18') throw error;
  }
  const notifySuiteTheme = () => suite?.setTheme();
  nativeTheme.on('updated', notifySuiteTheme);
  win.once('closed', () => nativeTheme.removeListener('updated', notifySuiteTheme));
  if (checking) win.webContents.on('console-message', details => {
    if (details.level === 'error') console.error('QA renderer:', details.message);
  });
  const developmentVerification = checking ? await import('../qa/development-verification.mjs') : null;
  const entry = portableCheck ? '/?verify=portable&startup=1' : developmentVerification?.verificationPath(checking) ?? '/';
  return win.loadURL(APP + entry).then(async () => {
    if (!win.isDestroyed()) { win.show(); win.focus(); sendActivity(); }
    void markdown.read().catch(error => console.error('本地索引：', error.message));
    if (!fixtureRoot) void dailyBackup();

    if (portableVerification) {
      await portableVerification.runPortableVerification({
        ...services, app, win, settings, fixtureRoot, DATA, portableLanguageCheck, portableAdjacentCheck,
        suite, browser, getCaptureWindow: capture.getWindow, sendActivity, OUROBOROS,
      });
    }
    if (developmentVerification) {
      await developmentVerification.runDevelopmentVerification({
        ...services, checking, app, win, settings, fixtureRoot, suite, browser, articleCheck, articleLinksOpened,
        openQuickCapture: capture.openQuickCapture, setCaptureShortcut: capture.setCaptureShortcut,
      });
    }
  });
}
