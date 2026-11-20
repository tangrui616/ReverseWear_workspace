import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, nativeTheme, screen, session, shell } from 'electron';
import * as electron from 'electron';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { calculate, launcherResults } from './launcher.mjs';
import { openClipboardStore } from './clipboardStore.mjs';
import { createClipboardService, isSensitive } from './clipboardService.mjs';
import { createRestartingBridge } from './windowsBridge.mjs';
import { createTrayManager } from './trayManager.mjs';
import { commands, suiteOperations } from '../ipc/contract.mjs';
import { sendEvent } from '../main/ipc.mjs';
import { wireWindowChrome } from '../desktop_window_chrome.mjs';

const origin = 'https://stilltime-suite.invalid';
const pages = new Set(['clipboard', 'launcher', 'selection', 'pin']);
const assets = new Map([
  ...Array.from(pages, role => ['/' + role + '.html', 'text/html; charset=utf-8']),
  ['/suite.css', 'text/css; charset=utf-8'],
  ['/suite.mjs', 'text/javascript; charset=utf-8'],
]);
const shortcutPattern = /^(?:(?:Alt|Control|CommandOrControl|Shift)\+)+(?:[A-Z0-9]|Space|F(?:[1-9]|1[0-2]))$/;
const single = /^[a-z]+(?:['’-][a-z]+)*$/i;
const text = (value, maximum = 512) => typeof value === 'string' ? value.slice(0, maximum) : '';
const id = value => text(value, 80);

function hwnd(win) {
  const buffer = win.getNativeWindowHandle();
  return buffer.length === 8 ? Number(buffer.readBigUInt64LE()) : buffer.readUInt32LE();
}

function findItem(store, value) {
  const result = store.getItem(id(value));
  if (!result) throw new Error('剪贴板记录已不存在。');
  return result;
}

export async function createSuiteWindows(options) {
  const { directory, storage, mainWindow, verifyOnly, appearance, quit, saveNote, openWorkbench, translate, testMode,
    collectArticle, onLinkCaptured, onArticleShortcut } = options;
  const icon = verifyOnly ? null : await app.getFileIcon(process.execPath, { size: 'small' });
  const helper = app.isPackaged ? path.join(process.resourcesPath, 'desktop-suite', 'WindowsBridge.exe')
    : path.join(directory, '.suite-native', 'WindowsBridge.exe');
  const store = await openClipboardStore(storage);
  let nativeError = 'Windows 剪贴板助手尚未连接。';
  let service;
  let tray;
  const bridge = createRestartingBridge(helper, { onStateChanged: state => {
    nativeError = state.available ? '' : state.error;
    if (!state.available && service) void service.stop().catch(report);
    if (state.available && service && store.getSettings().captureEnabled) void service.start().catch(report);
    notify();
    tray?.refresh();
  } });
  const contexts = new Map();
  const mainWindows = new Map();
  const permits = new Map();
  const imageTokens = new Map();
  const icons = new Map();
  const shortcuts = new Map();
  const shortcutErrors = {};
  let selection;
  let stop;
  let queue = Promise.resolve();

  function serial(action) {
    const job = queue.then(action);
    queue = job.catch(() => {});
    return job;
  }

  function notify() {
    for (const context of contexts.values()) {
      if (context.win.isDestroyed() || !['clipboard', 'launcher'].includes(context.role)) continue;
      sendEvent(context.win.webContents, 'suite:changed');
    }
    if (!mainWindow.isDestroyed()) sendEvent(mainWindow.webContents, 'suite:clipboard-changed');
  }

  service = createClipboardService({
    store, clipboard, ClipboardItemClass: electron.ClipboardItem, bridge, onStateChanged: notify,
    onChanged(event) {
      notify();
      const item = event?.item;
      if (item?.type === 'link' && item.content?.text) onLinkCaptured?.(item);
    },
  });
  const dedicated = session.fromPartition('reversewear-desktop-suite');
  dedicated.setSpellCheckerEnabled(false);
  dedicated.setPermissionRequestHandler((_sender, _permission, answer) => answer(false));
  dedicated.setPermissionCheckHandler(() => false);
  dedicated.on('will-download', event => event.preventDefault());
  dedicated.webRequest.onBeforeRequest(({ url }, answer) => {
    answer({ cancel: !url.startsWith(origin + '/') && !url.startsWith('data:image/png;') });
  });
  const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";
  dedicated.protocol.handle('https', async request => {
    const url = new URL(request.url);
    if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 403 });
    try {
      const type = assets.get(url.pathname);
      if (type) {
        const bytes = await readFile(path.join(directory, 'dist', 'desktop-suite', url.pathname.slice(1)));
        return new Response(request.method === 'GET' ? bytes : null, { headers: {
          'content-type': type, 'cache-control': 'no-store', 'content-security-policy': csp, 'x-content-type-options': 'nosniff',
        } });
      }
      const token = url.pathname.match(/^\/image\/([a-f0-9-]{36})\.png$/)?.[1];
      const target = token && permits.get(token);
      if (!target) return new Response(null, { status: 404 });
      const imagePath = target.file || store.itemImagePath(target.itemId);
      if (!imagePath) return new Response(null, { status: 404 });
      const info = await lstat(imagePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 ** 2) return new Response(null, { status: 404 });
      return new Response(request.method === 'GET' ? await readFile(imagePath) : null, { headers: {
        'content-type': 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      } });
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  function issueImage(itemId, context) {
    if (!store.itemImagePath(itemId)) return undefined;
    const cacheKey = context ? 'pin:' + context.win.id : itemId;
    let token = imageTokens.get(cacheKey);
    if (!token) {
      if (imageTokens.size >= 2500) {
        for (const [key, value] of imageTokens) {
          if (key.startsWith('pin:')) continue;
          imageTokens.delete(key);
          permits.delete(value);
          if (imageTokens.size < 2000) break;
        }
      }
      token = randomUUID();
      imageTokens.set(cacheKey, token);
      permits.set(token, { itemId });
    }
    if (context) context.imageKey = cacheKey;
    return origin + '/image/' + token + '.png';
  }

  function dto(item, detail = false) {
    const content = item.content ?? {};
    return {
      id: item.id, type: item.type, preview: item.preview, text: detail ? content.text : undefined,
      characterCount: item.characterCount ?? [...(content.text || '')].length,
      paths: detail ? content.files : undefined, url: item.type === 'link' ? content.text : undefined,
      width: item.image?.width, height: item.image?.height, imageUrl: item.image ? issueImage(item.id) : undefined,
      sourceName: item.source?.name, sourceProcess: item.source?.process,
      sourceIcon: icons.get(item.source?.process?.toLowerCase()),
      createdAt: item.createdAt, updatedAt: item.lastUsedAt, pinned: item.pinned,
    };
  }

  const unsubscribeIcon = bridge.onEvent(({ foreground }) => {
    const key = foreground?.processName?.toLowerCase();
    const executable = foreground?.executable;
    if (!key || icons.has(key) || !/^[a-z]:[\\/]/i.test(executable ?? '') || icons.size >= 128) return;
    if (!store.getSettings().captureEnabled || store.getSettings().excludedProcesses.includes(key)) return;
    icons.set(key, null);
    void app.getFileIcon(executable, { size: 'small' }).then(value => {
      if (!value.isEmpty()) icons.set(key, value.toDataURL());
    }).catch(() => {});
  });

  function openMain() {
    if (mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  async function snapshotForeground() {
    try { return (await bridge.request('snapshot')).foreground ?? null; }
    catch { return null; }
  }

  function currentArea() {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  }

  async function makeWindow(role, bounds, extra = {}) {
    const win = new BrowserWindow({
      ...bounds, title: { clipboard: '剪贴板', launcher: '命令面板', selection: '划词工具', pin: '屏幕贴图' }[role],
      show: false, frame: false, skipTaskbar: true, alwaysOnTop: true, autoHideMenuBar: true,
      backgroundColor: '#171d2a', ...extra,
      webPreferences: { session: dedicated, preload: path.join(directory, 'suite-preload.cjs'),
        sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    const context = { role, win, foreground: null };
    if (role === 'clipboard') wireWindowChrome(win, { publish: false });
    contexts.set(win.webContents.id, context);
    const webContentsId = win.webContents.id;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.on('closed', () => {
      contexts.delete(webContentsId);
      if (mainWindows.get(role) === context) mainWindows.delete(role);
      const token = imageTokens.get(context.imageKey);
      if (token) permits.delete(token);
      if (context.imageKey) imageTokens.delete(context.imageKey);
      if (role === 'selection' && selection?.context === context) selection = undefined;
    });
    if (role !== 'pin') mainWindows.set(role, context);
    win.webContents.on('did-finish-load', () => sendAppearance(win));
    return context;
  }

  function report(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!mainWindow.isDestroyed() && !verifyOnly) dialog.showErrorBox('桌面效率套件', message.slice(0, 300));
  }

  function hide(context) {
    if (!context || context.win.isDestroyed()) return;
    if (context.role === 'pin' || context.role === 'selection') context.win.close();
    else context.win.hide();
  }

  async function showPanel(role) {
    if (stop) return;
    const other = mainWindows.get(role === 'clipboard' ? 'launcher' : 'clipboard');
    const initial = await snapshotForeground();
    const activeOther = other && !other.win.isDestroyed() && initial?.hwnd === hwnd(other.win);
    const target = activeOther ? other.foreground : initial;
    const own = mainWindows.get(role);
    if (own && !own.win.isDestroyed() && initial?.hwnd === hwnd(own.win) && own.win.isVisible() && !own.win.isMinimized()) {
      hide(own);
      return own;
    }
    if (activeOther) hide(other);
    const area = currentArea();
    const width = Math.min(role === 'clipboard' ? 610 : 600, area.width - 20);
    const height = Math.min(role === 'clipboard' ? 660 : 420, area.height - 20);
    const centered = { x: area.x + Math.floor((area.width - width) / 2), y: area.y + Math.floor((area.height - height) / 2), width, height };
    const context = own && !own.win.isDestroyed() ? own : await makeWindow(role, centered);
    context.foreground = target?.hwnd && target?.pid ? target : null;
    const previous = role === 'clipboard' && own && !own.win.isDestroyed() ? context.win.getNormalBounds() : centered;
    const windowWidth = Math.min(previous.width, area.width - 20);
    const windowHeight = Math.min(previous.height, area.height - 20);
    const bounds = {
      x: Math.min(Math.max(previous.x, area.x + 10), area.x + area.width - windowWidth - 10),
      y: Math.min(Math.max(previous.y, area.y + 10), area.y + area.height - windowHeight - 10),
      width: windowWidth, height: windowHeight,
    };
    if (context.win.isMinimized()) context.win.restore();
    if (context.win.isMaximized()) context.win.unmaximize();
    context.win.setBounds(bounds);
    if (!context.win.webContents.getURL()) await context.win.loadURL(origin + '/' + role + '.html');
    if (!context.win.isDestroyed()) {
      context.win.show();
      context.win.focus();
      sendEvent(context.win.webContents, 'suite:changed', { shown: true });
    }
    return context;
  }

  async function showSelection() {
    if (!store.getSettings().selectionEnabled) return;
    const existing = mainWindows.get('selection');
    if (existing && !existing.win.isDestroyed()) { hide(existing); return; }
    const foreground = await snapshotForeground();
    const excluded = store.getSettings().excludedProcesses;
    if (!foreground?.processName || excluded.includes(foreground.processName.toLowerCase())) return;
    const result = await service.copySelection({ foreground });
    const value = text(result?.text, 16000).trim();
    if (!value || isSensitive([value])) return;
    return openSelection(value);
  }

  async function openSelection(value) {
    const area = currentArea();
    const cursor = screen.getCursorScreenPoint();
    const width = Math.min(520, area.width - 16), height = Math.min(185, area.height - 16);
    const x = Math.min(Math.max(area.x + 8, cursor.x + 10), area.x + area.width - width - 8);
    const y = Math.min(Math.max(area.y + 8, cursor.y + 15), area.y + area.height - height - 8);
    const context = await makeWindow('selection', { x, y, width, height }, { focusable: false, resizable: false });
    selection = { context, value, token: randomUUID() };
    await context.win.loadURL(origin + '/selection.html');
    if (!context.win.isDestroyed()) context.win.showInactive();
    return context;
  }

  async function openPin(item) {
    if (!item.image || !store.itemImagePath(item.id)) throw new Error('这条记录没有可用图片。');
    if ([...contexts.values()].filter(context => context.role === 'pin').length >= 8) throw new Error('请先关闭一张现有贴图。');
    const area = currentArea(), cursor = screen.getCursorScreenPoint();
    const ratio = item.image.width / item.image.height;
    const width = Math.round(Math.min(550, item.image.width, area.width - 24, (area.height - 60) * ratio));
    const height = Math.round(width / ratio) + 45;
    const x = Math.max(area.x, Math.min(cursor.x, area.x + area.width - width - 12));
    const y = Math.max(area.y, Math.min(cursor.y, area.y + area.height - height - 12));
    const context = await makeWindow('pin', { x, y, width: Math.max(180, width), height: Math.max(100, height) },
      { transparent: true, backgroundColor: '#00000000', minWidth: 160, minHeight: 95 });
    context.itemId = item.id;
    context.imageUrl = issueImage(item.id, context);
    context.opacity = 1;
    await context.win.loadURL(origin + '/pin.html');
    if (!context.win.isDestroyed()) context.win.showInactive();
    return context;
  }

  async function clipboardPaste(context, item, plainText) {
    const result = await service.paste(item, { plainText, foreground: context.foreground,
      allowedCurrentHwnd: hwnd(context.win), beforeSend: () => hide(context) });
    if (!result.written) throw new Error('这条记录没有可粘贴的纯文本。');
    hide(context);
    return { written: result.written, pasted: result.pasted, reason: result.reason };
  }

  function stackPaste(context) {
    return serial(async () => {
      const result = await service.pasteNext(context ? { foreground: context.foreground, allowedCurrentHwnd: hwnd(context.win),
        beforeSend: () => hide(context) } : { foreground: await snapshotForeground() });
      if (context && result.written) hide(context);
      return { written: result.written, pasted: result.pasted, reason: result.reason, empty: result.empty };
    });
  }

  function settingsState() {
    return { ...store.getSettings(), shortcutErrors: { ...shortcutErrors }, nativeAvailable: !nativeError, nativeError };
  }

  async function collectFromHistory(value) {
    const item = findItem(store, value);
    if (item.type !== 'link' || !item.content?.text) throw new Error('这条剪贴板记录不是网页地址。');
    return collectArticle(item.content.text.trim());
  }

  async function collectCurrentLink() {
    try {
      const before = await bridge.request('snapshot');
      const excluded = store.getSettings().excludedProcesses;
      const names = [before.foreground?.processName, before.owner?.processName].filter(Boolean);
      if (!names.length || before.privacyExcluded || names.some(name => excluded.includes(name.toLowerCase()))) {
        throw new Error('当前剪贴板无法安全收录。');
      }
      const value = (await clipboard.readText()).trim();
      const after = await bridge.request('snapshot');
      if (before.sequence !== after.sequence || !/^https?:\/\/\S+$/i.test(value) || isSensitive([value])) {
        throw new Error('请先复制一条普通 HTTP(S) 网页地址。');
      }
      const article = await collectArticle(value);
      onArticleShortcut?.({ title: article.title });
    } catch (error) {
      onArticleShortcut?.({ error: String(error.message || error).slice(0, 200) });
    }
  }

  const shortcutActions = {
    history: () => serial(() => showPanel('clipboard')),
    launcher: () => serial(() => showPanel('launcher')),
    stack: () => { if (store.getSettings().stackEnabled) return stackPaste(); },
    selection: () => serial(showSelection),
    article: collectCurrentLink,
  };

  function bindShortcuts(requested, existing = {}) {
    const result = { ...existing };
    for (const [key, callback] of Object.entries(shortcutActions)) {
      const value = requested?.[key] ?? result[key];
      if (!value || shortcuts.get(key) === value) continue;
      if (!shortcutPattern.test(value)) { shortcutErrors[key] = '快捷键格式无效。'; continue; }
      if (verifyOnly && !testMode) { result[key] = value; continue; }
      let success = false;
      try { success = globalShortcut.register(value, () => { void Promise.resolve().then(callback).catch(report); }); } catch { /* Invalid or reserved. */ }
      if (!success) { shortcutErrors[key] = '快捷键已被占用或不可用。'; continue; }
      const previous = shortcuts.get(key);
      if (previous) globalShortcut.unregister(previous);
      shortcuts.set(key, value);
      result[key] = value;
      delete shortcutErrors[key];
    }
    return result;
  }

  async function updateSettings(input) {
    const next = {};
    for (const key of ['captureEnabled', 'autoPaste', 'trayEnabled', 'selectionEnabled', 'selectionCopyFallback']) {
      if (typeof input[key] === 'boolean') next[key] = input[key];
    }
    for (const key of ['maxItems', 'maxImageBytes']) {
      if (Number.isSafeInteger(input[key])) next[key] = input[key];
    }
    if (Array.isArray(input.excludedProcesses)) next.excludedProcesses = input.excludedProcesses.slice(0, 100).map(value => text(value, 128));
    if (input.shortcuts && typeof input.shortcuts === 'object') {
      const proposed = {};
      for (const key of Object.keys(shortcutActions)) proposed[key] = text(input.shortcuts[key], 64) || undefined;
      next.shortcuts = bindShortcuts(proposed, store.getSettings().shortcuts);
    }
    if (next.captureEnabled === true && nativeError) throw new Error(nativeError);
    await store.updateSettings(next);
    if (next.captureEnabled === true) await service.start();
    else if (next.captureEnabled === false) await service.stop();
    tray.refresh();
    notify();
    return settingsState();
  }

  async function clearHistory(parent) {
    const response = await dialog.showMessageBox(parent, {
      type: 'warning', message: '清理普通剪贴板历史？', detail: '看板钉选会保留。',
      buttons: ['取消', '清理'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response.response !== 1) return false;
    await serial(async () => { await store.clearHistory(); notify(); });
    return true;
  }

  tray = createTrayManager({
    icon, status: settingsState, openMain, openClipboard: () => serial(() => showPanel('clipboard')),
    toggleCapture: () => serial(() => updateSettings({ captureEnabled: !store.getSettings().captureEnabled })),
    toggleStack: () => serial(async () => { await service.setStackEnabled(!store.getSettings().stackEnabled); tray.refresh(); }),
    clearHistory: () => clearHistory(mainWindow), quit, onError: report,
  });

  async function historyAction(context, item, action) {
    const value = item.content?.text;
    if (action === 'collect') return collectFromHistory(item.id);
    if (action === 'copy') {
      if (!value) throw new Error('这条记录没有可复制的纯文本。');
      return service.writeText(value).then(() => ({ written: true }));
    }
    if (action === 'note') return saveNote(value);
    if (action === 'translate') return translate(value, single);
    if (action === 'pin') { await openPin(item); return true; }
    if (!['open', 'reveal'].includes(action)) throw new Error('不支持此剪贴板动作。');
    const filename = item.content?.files?.[0];
    if (!filename || !path.isAbsolute(filename)) throw new Error('这条记录没有可用文件。');
    if (action === 'reveal') { shell.showItemInFolder(filename); return true; }
    if (!/\.(pdf|md)$/i.test(filename)) throw new Error('工作台支持直接打开 PDF 和 Markdown。');
    hide(context);
    await openWorkbench('reader.open-path', filename);
    return true;
  }

  async function runLauncher(context, input) {
    const command = text(input.commandId, 96);
    if (command === 'calculator.copy') {
      const result = calculate(input.query);
      if (result === null) throw new Error('请输入有效表达式。');
      await service.writeText(result);
      hide(context);
      return { text: result };
    }
    if (command.startsWith('snippet:')) {
      const item = findItem(store, command.slice(8));
      if (!item.pinned || !item.content?.text) throw new Error('看板片段已不可用。');
      return clipboardPaste(context, item.id, true);
    }
    if (!['note.new', 'reader.open-pdf', 'translation.open'].includes(command)) throw new Error('该命令不可用。');
    hide(context);
    await openWorkbench(command);
    return true;
  }

  async function selectionAction(context, input) {
    if (!selection || selection.context !== context || input.selectionToken !== selection.token) throw new Error('选区已失效。');
    if (input.action === 'note') return saveNote(selection.value);
    if (input.action === 'translate') return translate(selection.value, single);
    if (input.action === 'search') return shell.openExternal('https://www.bing.com/search?q=' + encodeURIComponent(selection.value.slice(0, 1500)));
    if (input.action === 'count') return { length: [...selection.value].length };
    throw new Error('不支持此选区动作。');
  }

  function stackState() {
    const state = service.getState();
    return { ...state, stackItems: state.items, stackLength: state.length };
  }

  const handlers = {
    'window.hide': context => { hide(context); return true; },
    'window.control': (context, input) => {
      if (context.role !== 'clipboard' || !['minimize', 'maximize'].includes(input.command)) return false;
      if (input.command === 'minimize') context.win.minimize();
      else if (context.win.isMaximized()) context.win.unmaximize();
      else context.win.maximize();
      return true;
    },
    'history.search': (_context, input) => store.search(text(input.query), { type: text(input.type, 20),
      boardId: id(input.boardId), limit: input.limit, offset: input.offset }).map(item => dto(item)),
    'history.detail': (_context, input) => dto(findItem(store, input.id), true),
    'history.copy': (_context, input) => serial(() => service.copyToClipboard(id(input.id))),
    'history.copy-batch': (_context, input) => serial(() => service.copyBatch(input.ids)),
    'history.paste': (context, input) => serial(() => clipboardPaste(context, id(input.id), input.plainText === true)),
    'history.action': (context, input) => {
      if (context.role === 'main' && !['copy', 'note', 'translate'].includes(input.action)) {
        throw new Error('此操作仅在剪贴板浮窗中可用。');
      }
      return historyAction(context, findItem(store, input.id), input.action);
    },
    'history.delete': (_context, input) => serial(async () => { await store.deleteItem(id(input.id)); notify(); return true; }),
    'history.clear': context => clearHistory(context.win),
    'boards.list': () => store.listBoards(),
    'boards.create': (_context, input) => serial(() => { const result = store.createBoard(text(input.name, 64)); notify(); return result; }),
    'boards.rename': (_context, input) => serial(() => { const result = store.renameBoard(id(input.id), text(input.name, 64)); notify(); return result; }),
    'boards.delete': (_context, input) => serial(async () => { const result = await store.deleteBoard(id(input.id)); notify(); return result; }),
    'boards.set': (_context, input) => serial(() => { const result = store.setBoardItem(id(input.boardId), id(input.itemId), input.pinned === true); notify(); return result; }),
    'stack.state': stackState,
    'stack.set': (_context, input) => serial(async () => { await service.setStackEnabled(input.enabled === true); tray.refresh(); return stackState(); }),
    'stack.paste': context => stackPaste(context),
    'settings.get': () => settingsState(),
    'settings.update': (_context, input) => serial(() => updateSettings(input)),
    'launcher.search': (_context, input) => {
      const boards = store.listBoards();
      const rows = boards.flatMap(board => store.search(text(input.query, 160), { boardId: board.id, limit: 16 }));
      const records = [...new Map(rows.filter(item => item.content?.text).map(item => [item.id, item])).values()];
      return launcherResults(input.query, records);
    },
    'launcher.run': (context, input) => serial(() => runLauncher(context, input)),
    'selection.state': context => selection?.context === context ? { text: selection.value, selectionToken: selection.token } : {},
    'selection.action': selectionAction,
    'pin.state': context => ({ imageUrl: context.imageUrl, opacity: context.opacity }),
    'pin.opacity': (context, input) => {
      const opacity = Number(input.opacity);
      if (!Number.isFinite(opacity)) return false;
      context.opacity = Math.max(0.2, Math.min(1, opacity));
      context.win.setOpacity(context.opacity);
      return true;
    },
    'pin.resize': (context, input) => {
      if (!['grow', 'shrink'].includes(input.direction)) return false;
      const [width, height] = context.win.getSize();
      const area = screen.getDisplayMatching(context.win.getBounds()).workAreaSize;
      const scale = input.direction === 'grow' ? 1.12 : 1 / 1.12;
      context.win.setSize(Math.min(area.width, Math.max(160, Math.round(width * scale))),
        Math.min(area.height, Math.max(95, Math.round(height * scale))));
      return true;
    },
    'pin.save': async context => {
      const source = store.itemImagePath(context.itemId);
      if (!source) throw new Error('贴图的源图片已不可用。');
      const result = await dialog.showSaveDialog(context.win, { title: '保存贴图', defaultPath: 'ReverseWear.png',
        filters: [{ name: 'PNG 图片', extensions: ['png'] }] });
      if (!result.canceled && result.filePath) await copyFile(source, result.filePath);
      return !result.canceled;
    },
  };

  ipcMain.handle(commands['suite:invoke'].channel, (event, operation, input = {}) => {
    const context = contexts.get(event.sender.id);
    const frame = event.senderFrame;
    if (!context || context.win.webContents !== event.sender || !frame || frame.parent ||
        new URL(frame.url).origin !== origin || new URL(frame.url).pathname !== '/' + context.role + '.html' ||
        typeof operation !== 'string' || !Object.hasOwn(suiteOperations, operation) ||
        !suiteOperations[operation]?.roles.includes(context.role) || !input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('不允许的桌面效率套件操作。');
    }
    return handlers[operation](context, input);
  });
  function sendAppearance(win) {
    const state = appearance();
    const mode = typeof state === 'string' ? state : state?.mode;
    const dark = mode === 'dark' || (mode === 'system' && nativeTheme.shouldUseDarkColors);
    if (!win.isDestroyed()) sendEvent(win.webContents, 'suite:changed', {
      appearance: dark ? 'dark' : 'light', palette: state?.palette || 'mist',
      material: state?.material || 'solid', glassBlur: Number.isFinite(state?.glassBlur) ? state.glassBlur : 24,
    });
  }
  const starting = store.getSettings();
  bindShortcuts(starting.shortcuts, starting.shortcuts);
  await bridge.ready;
  if (starting.captureEnabled && !nativeError) await service.start();
  tray.refresh();

  return {
    open: () => serial(() => showPanel('clipboard')).then(() => true),
    invokeClipboard(operation, input = {}) {
      if (typeof operation !== 'string' || !Object.hasOwn(suiteOperations, operation) ||
        !suiteOperations[operation].roles.includes('main') || !input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('此操作不能从工作台剪贴页调用。');
      }
      if (operation === 'history.action' && !['copy', 'note', 'translate'].includes(input.action)) {
        throw new Error('此操作仅在剪贴板浮窗中可用。');
      }
      return handlers[operation]({ role: 'main', win: mainWindow }, input);
    },
    writeText: value => serial(() => service.writeText(value)),
    collectFromHistory,
    inTray: () => store.getSettings().trayEnabled,
    setTheme() {
      for (const { win } of contexts.values()) sendAppearance(win);
    },
    close() {
      if (stop) return stop;
      stop = (async () => {
        tray.close();
        for (const key of shortcuts.values()) globalShortcut.unregister(key);
        ipcMain.removeHandler('stilltime:suite:invoke');
        unsubscribeIcon();
        for (const { win } of contexts.values()) { if (!win.isDestroyed()) win.destroy(); }
        bridge.close();
        await service.stop();
        store.close();
      })();
      return stop;
    },
    ...(verifyOnly ? { testing: { store, service, bridge, openPanel: showPanel, openPin, openTestSelection: openSelection, showSelection, updateSettings, get nativeAvailable() { return !nativeError; } } } : {}),
  };
}
