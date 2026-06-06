'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  showItem: (filePath) => ipcRenderer.invoke('show-item', filePath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  loginPlatform: (platform) => ipcRenderer.invoke('login-platform', platform),
  logoutPlatform: (platform) => ipcRenderer.invoke('logout-platform', platform),
  cookiesStatus: () => ipcRenderer.invoke('cookies-status'),
  igSearch: (query) => ipcRenderer.invoke('ig-search', query),
  fbSearch: (query, max) => ipcRenderer.invoke('fb-search', query, max),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, data) => cb(data)),
  isElectron: true,
});
