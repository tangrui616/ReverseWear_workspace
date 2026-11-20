import { BrowserWindow, clipboard, globalShortcut } from 'electron';
import path from 'node:path';
import { wireWindowChrome } from '../desktop_window_chrome.mjs';
import { checkExternalLink } from './external-link.mjs';
import { sendEvent } from './ipc.mjs';
import { APP, originFor } from './protocol.mjs';
import { windowColor } from './windows.mjs';

export function createCaptureWindow({ directory, desktop, settings }) {
  let captureWindow = null;
  const openQuickCapture = () => {
    if (captureWindow && !captureWindow.isDestroyed()) {
      captureWindow.show();
      captureWindow.focus();
      return captureWindow;
    }
    const capture = new BrowserWindow({
      title: '快速捕捉', frame: false, width: 460, height: 240, minWidth: 380, minHeight: 210,
      resizable: true, movable: true, minimizable: false, maximizable: false,
      alwaysOnTop: true, backgroundColor: windowColor(settings.getAppearance().mode), show: false,
      webPreferences: {
        session: desktop, preload: path.join(directory, 'capture-preload.cjs'),
        sandbox: true, contextIsolation: true, nodeIntegration: false,
      },
    });
    captureWindow = capture;
    wireWindowChrome(capture, { publish: false });
    capture.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    capture.webContents.on('will-navigate', event => event.preventDefault());
    capture.webContents.on('will-frame-navigate', details => {
      if (details.isMainFrame || originFor(details.url) !== APP) details.preventDefault();
    });
    capture.once('ready-to-show', () => capture.show());
    capture.on('closed', () => { if (captureWindow === capture) captureWindow = null; });
    void capture.loadURL(APP + '/capture.html').then(async () => {
      let source = '';
      try {
        const candidate = String(await clipboard.readText()).trim();
        if (/^https?:\/\/\S+$/i.test(candidate)) source = checkExternalLink(candidate);
      } catch (error) {
        console.warn('快速捕捉无法读取剪贴板链接：', error.message);
      }
      if (!capture.isDestroyed()) {
        sendEvent(capture.webContents, 'capture:appearance', settings.getAppearance().mode);
        sendEvent(capture.webContents, 'capture:source', source);
      }
    }).catch(error => {
      console.error('快速捕捉窗口无法打开：', error.message);
      if (!capture.isDestroyed()) capture.close();
    });
    return capture;
  };
  const setCaptureShortcut = value => {
    const match = /^(?:Control|Ctrl)\+Alt(\+Shift)?\+([A-Z0-9])$/i.exec(String(value ?? '').trim());
    if (!match) {
      throw new Error('快捷键格式无效。请使用 Control+Alt+字母，例如 Control+Alt+I。');
    }
    const shortcut = 'Control+Alt' + (match[1] ? '+Shift' : '') + '+' + match[2].toUpperCase();
    const previous = settings.getRiskPreferences().captureShortcut;
    if (shortcut === previous && captureShortcutRegistered) return { accelerator: previous, registered: true };
    if (!globalShortcut.register(shortcut, openQuickCapture)) {
      throw new Error('这个快捷键已被其他程序占用。');
    }
    try {
      settings.saveRiskPreferences({ captureShortcut: shortcut });
      if (shortcut !== previous && globalShortcut.isRegistered(previous)) globalShortcut.unregister(previous);
      captureShortcutRegistered = true;
      return { accelerator: shortcut, registered: true };
    } catch (error) {
      globalShortcut.unregister(shortcut);
      throw error;
    }
  };
  const initialCaptureShortcut = settings.getRiskPreferences().captureShortcut;
  let captureShortcutRegistered = false;
  try { captureShortcutRegistered = globalShortcut.register(initialCaptureShortcut, openQuickCapture); }
  catch (error) { console.warn('快速记录快捷键无法注册：', error.message); }
  if (!captureShortcutRegistered) {
    console.warn(`快速捕捉快捷键 ${initialCaptureShortcut} 不可用。可以在灵感页调整。`);
  }

  return {
    openQuickCapture, setCaptureShortcut, getWindow: () => captureWindow,
    shortcutState: () => ({ accelerator: settings.getRiskPreferences().captureShortcut, registered: captureShortcutRegistered }),
    close: () => {
      if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close();
    },
  };
}
