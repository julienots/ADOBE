// Pont sécurisé entre l'application Windows et l'éditeur (contextIsolation activé) :
// seules ces deux fonctions sont exposées à la page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('prismeNative', {
  platform: process.platform,
  onOpenFile(callback) {
    ipcRenderer.on('open-file', (_event, file) => callback(file));
  },
  ready() {
    ipcRenderer.send('renderer-ready');
  },
});
