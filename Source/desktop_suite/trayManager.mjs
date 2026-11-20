import { Menu, Tray } from 'electron';

export function createTrayManager({ icon, status, openMain, openClipboard, toggleCapture, toggleStack, clearHistory, quit, onError }) {
  let tray;
  const run = action => () => { void Promise.resolve().then(action).catch(onError); };
  return {
    refresh() {
      const settings = status();
      if (!settings.trayEnabled) {
        tray?.destroy();
        tray = undefined;
        return;
      }
      if (!tray) {
        tray = new Tray(icon);
        tray.on('double-click', openMain);
      }
      tray.setToolTip(settings.nativeAvailable ? '反穿衣工作台' : '反穿衣工作台 · 剪贴板助手不可用');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '打开工作台', click: openMain },
        { label: settings.nativeAvailable ? 'Windows 剪贴板助手可用' : 'Windows 剪贴板助手不可用', enabled: false },
        { label: '剪贴板', click: run(openClipboard) },
        { type: 'separator' },
        { label: '采集剪贴板历史', type: 'checkbox', checked: settings.captureEnabled, click: run(toggleCapture) },
        { label: '顺序粘贴栈', type: 'checkbox', checked: settings.stackEnabled, click: run(toggleStack) },
        { label: '清理普通历史…', click: run(clearHistory) },
        { type: 'separator' },
        { label: '彻底退出', click: quit },
      ]));
    },
    close() {
      tray?.destroy();
      tray = undefined;
    },
  };
}
