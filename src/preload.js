const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window controls
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close:    () => ipcRenderer.send('win-close'),

  // System info
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  getDiskInfo:   () => ipcRenderer.invoke('get-disk-info'),
  estimateSizes: () => ipcRenderer.invoke('estimate-sizes'),

  // Cleaning
  runClean: (tasks) => ipcRenderer.invoke('run-clean', tasks),
  onCleanLog: (cb) => ipcRenderer.on('clean-log', (e, data) => cb(data)),

  // Tools
  runSfc:          () => ipcRenderer.invoke('run-sfc'),
  runDism:         () => ipcRenderer.invoke('run-dism'),
  runDiskCleanup:  () => ipcRenderer.invoke('run-disk-cleanup'),
  runNetworkReset: () => ipcRenderer.invoke('run-network-reset'),
  onToolLog: (cb) => ipcRenderer.on('tool-log', (e, data) => cb(data)),

  // Startup
  getStartupItems:   ()      => ipcRenderer.invoke('get-startup-items'),
  toggleStartupItem: (item)  => ipcRenderer.invoke('toggle-startup-item', item),

  // Performance Boost
  runBoost: (type) => ipcRenderer.invoke('run-boost', type),

  // Gaming Mode
  runGaming: (type) => ipcRenderer.invoke('run-gaming', type),

  // Background Apps
  runBgApp: (type) => ipcRenderer.invoke('run-bgapp', type),

  // Excludes
  getExcludes:  ()     => ipcRenderer.invoke('get-excludes'),
  saveExcludes: (list) => ipcRenderer.invoke('save-excludes', list),

  // Feature log (boost, gaming, bgapps)
  onFeatureLog:    (cb) => ipcRenderer.on('feature-log', (e, data) => cb(data)),
  removeFeatureLog: ()  => ipcRenderer.removeAllListeners('feature-log'),

  // Shell
  openExternal: (url) => ipcRenderer.send('open-external', url),
  openPath:     (p)   => ipcRenderer.send('open-path', p),

  // Remove listeners
  removeCleanLog: () => ipcRenderer.removeAllListeners('clean-log'),
  removeToolLog:  () => ipcRenderer.removeAllListeners('tool-log'),
});
