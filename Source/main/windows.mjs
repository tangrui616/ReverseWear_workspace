import { app, BrowserWindow, dialog, Menu, nativeTheme } from 'electron';
import path from 'node:path';
import { wireWindowChrome } from '../desktop_window_chrome.mjs';
import { sendEvent } from './ipc.mjs';
import { APP, WEB, OUROBOROS, originFor } from './protocol.mjs';

export function windowColor(mode) {
  return mode === 'dark' || (mode === 'system' && nativeTheme.shouldUseDarkColors) ? '#121620' : '#eff1f6';
}

export function createWorkbenchWindow({ directory, desktop, settings, isInTray, closeServices, getCaptureWindow }) {
  const win = new BrowserWindow({
    title: '反穿衣工作台', frame: false, width: 1320, height: 890, minWidth: 720, minHeight: 620,
    backgroundColor: windowColor(settings.getAppearance().mode), show: false,
    webPreferences: {
      session: desktop, preload: path.join(directory, 'preload.cjs'), sandbox: true,
      contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required',
    },
  });
  const chrome = wireWindowChrome(win);
  let rendererReady = false, quitRequest = 0, pendingQuit = 0, passClose = false;
  let closeRequestedWhilePending = false;
  let explicitQuit = false;
  let closingServices;
  function closeWorkbench() {
    if (closingServices) return closingServices;
    closingServices = Promise.allSettled(closeServices()).then(results => {
      for (const result of results) {
        if (result.status === 'rejected') console.error('关闭工作台资源失败：', result.reason?.message);
      }
      passClose = true;
      if (!win.isDestroyed()) win.close();
    });
    return closingServices;
  }
  const allowApplicationQuit = () => { explicitQuit = true; };
  app.on('before-quit', allowApplicationQuit);
  const quitFromTray = () => {
    explicitQuit = true;
    win.show();
    win.focus();
    win.close();
  };
  function requestRendererQuit() {
    pendingQuit = ++quitRequest;
    sendEvent(win.webContents, 'window:quit-request', pendingQuit);
  }
  win.on('close', event => {
    if (passClose) return;
    if (!explicitQuit && isInTray()) {
      event.preventDefault();
      win.hide();
      return;
    }
    event.preventDefault();
    if (!rendererReady || win.webContents.isCrashed()) {
      void closeWorkbench();
      return;
    }
    if (pendingQuit) {
      closeRequestedWhilePending = true;
      return;
    }
    requestRendererQuit();
  });

  function attachNavigation() {
    Menu.setApplicationMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-prevent-unload', event => {
      const answer = dialog.showMessageBoxSync(win, {
        type: 'question', buttons: ['继续编辑', '放弃并关闭'], defaultId: 0, cancelId: 0,
        message: '工作台中还有未保存的修改。',
      });
      if (answer === 1) event.preventDefault();
    });
    win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) {
        rendererReady = false;
        pendingQuit = 0;
        closeRequestedWhilePending = false;
      }
    });
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-frame-navigate', details => {
      const target = originFor(details.url);
      const source = originFor(details.initiator?.url);
      const current = originFor(details.frame?.url);
      const trustedTarget = [APP, WEB, OUROBOROS].includes(target) || details.url === 'about:blank';
      const forbiddenReturn = target === APP && [WEB, OUROBOROS].includes(source || current);
      const forbiddenOuroborosExit = current === OUROBOROS && target !== OUROBOROS && details.url !== 'about:blank';
      const forbiddenWebEntry = target === OUROBOROS && (source === WEB || current === WEB);
      if (details.isMainFrame || !trustedTarget || forbiddenReturn || forbiddenOuroborosExit || forbiddenWebEntry) details.preventDefault();
    });
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.webContents.on('context-menu', (_event, params) => {
      if (originFor(params.frameURL) !== APP || originFor(params.pageURL) !== APP) return;
      if (params.isEditable || params.selectionText) {
        Menu.buildFromTemplate([
          ...(params.isEditable ? [{ role: 'cut', label: '剪切', enabled: params.editFlags.canCut }] : []),
          { role: 'copy', label: '复制', enabled: params.editFlags.canCopy },
          ...(params.isEditable ? [{ role: 'paste', label: '粘贴', enabled: params.editFlags.canPaste }] : []),
        ]).popup({ window: win });
      }
    });
  }

  /** @param {import('./ipc.mjs').RegisterHandler} register */
  function registerWindowHandlers(register) {
    register('window:ready', () => { rendererReady = true; return chrome.state(); });
    register('window:control', command => {
      if (command === 'close') win.close();
      else if (command === 'minimize') win.minimize();
      else if (command === 'maximize') {
        if (win.isFullScreen()) win.setFullScreen(false);
        else if (win.isMaximized()) win.unmaximize();
        else win.maximize();
      }
    });
    register('window:quit-result', (id, close) => {
      if (!pendingQuit || id !== pendingQuit) return;
      pendingQuit = 0;
      const retry = closeRequestedWhilePending;
      closeRequestedWhilePending = false;
      if (close !== true) {
        if (retry) requestRendererQuit();
        else explicitQuit = false;
        return;
      }
      void closeWorkbench();
    });
  }

  let appVisible = true;
  let appMinimized = false;
  const renderActive = () => appVisible && !appMinimized &&
    (!settings.getRiskPreferences().lowPower || win.isFocused());
  const sendActivity = () => {
    setImmediate(() => {
      if (!win.isDestroyed()) sendEvent(win.webContents, 'risk:activity', renderActive());
    });
  };
  win.on('minimize', () => { appMinimized = true; sendActivity(); });
  win.on('restore', () => { appMinimized = false; sendActivity(); });
  win.on('hide', () => { appVisible = false; sendActivity(); });
  win.on('show', () => { appVisible = true; sendActivity(); });
  win.on('blur', sendActivity);
  win.on('focus', sendActivity);
  const updateWindowColor = () => {
    const mode = settings.getAppearance().mode;
    win.setBackgroundColor(windowColor(mode));
    const capture = getCaptureWindow();
    if (capture && !capture.isDestroyed()) {
      capture.setBackgroundColor(windowColor(mode));
      sendEvent(capture.webContents, 'capture:appearance', mode);
    }
  };
  nativeTheme.on('updated', updateWindowColor);

  win.once('closed', () => {
    app.removeListener('before-quit', allowApplicationQuit);
    nativeTheme.removeListener('updated', updateWindowColor);
  });

  return {
    win, attachNavigation, registerWindowHandlers, quitFromTray, updateWindowColor, renderActive, sendActivity,
    isClosing: () => Boolean(closingServices),
  };
}
