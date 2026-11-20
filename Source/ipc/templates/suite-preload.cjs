const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopSuite', Object.freeze({
  invoke: (operation, payload) => ipcRenderer.invoke(channels["suite:invoke"], operation, payload),
  onChanged(listener) {
    if (typeof listener !== 'function') return;
    const wrapped = (_event, value) => listener(value);
    ipcRenderer.on(channels["suite:changed"], wrapped);
    return () => ipcRenderer.removeListener(channels["suite:changed"], wrapped);
  },
}));
