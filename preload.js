// Bridges a few desktop-only features (file pickers, app icons) into the editor page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deckHost', {
  isDesktop: true,
  localKey: ipcRenderer.sendSync('local-key'),
  pickFile: (opts) => ipcRenderer.invoke('pick-file', opts),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  pickImage: (opts) => ipcRenderer.invoke('pick-image', opts && opts.large ? { large: true } : {}),
  fileIcon: (src) => ipcRenderer.invoke('file-icon', src),
  listApps: (refresh) => ipcRenderer.invoke('list-apps', refresh),
  loginItem: (value) => ipcRenderer.invoke('login-item', value),
  setTitlebar: (colors) => ipcRenderer.invoke('titlebar', colors),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  saveRating: (state) => ipcRenderer.invoke('rating-save', state),
  onAskRating: (fn) => ipcRenderer.on('ask-rating', () => fn()),
  ratingDone: () => ipcRenderer.send('rating-done'),
});
