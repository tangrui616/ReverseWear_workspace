const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stilltimeCapture', {
  save: entry => ipcRenderer.invoke(channels["capture:save"], entry),
  close: () => ipcRenderer.invoke(channels["capture:close"]),
  onAppearance: listener => { ipcRenderer.on(channels["capture:appearance"], (_event, mode) => listener(mode)); },
  onSource: listener => {
    const handle = (_event, source) => listener(source);
    ipcRenderer.on(channels["capture:source"], handle);
    return () => ipcRenderer.removeListener(channels["capture:source"], handle);
  },
});
