const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('patentReader', {
  openDocument: () => ipcRenderer.invoke('document:open'),
  saveRevision: (originalPath) => ipcRenderer.invoke('document:save-revision', originalPath),
})
