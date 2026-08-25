// JUNDSH · DSH 桌面端 — 预加载脚本（安全桥接）
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  minimize: () => ipcRenderer.send('app:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('app:maximize-toggle'),
  isMaximized: () => ipcRenderer.invoke('app:is-maximized'),
  onMaximized: (cb) => ipcRenderer.on('window:maximized', (_e, v) => cb(v)),
  close: () => ipcRenderer.send('app:close'),
  getSettings: () => ipcRenderer.invoke('app:get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('app:set-settings', patch),
  exportSettings: () => ipcRenderer.invoke('app:export-settings'),
  importSettings: () => ipcRenderer.invoke('app:import-settings'),
  openExternal: (url) => ipcRenderer.send('app:open-external', url),
  guiReady: () => ipcRenderer.send('app:gui-ready'),
  openDevTools: () => ipcRenderer.send('app:open-dev-tools'),
  openGuiDevTools: () => ipcRenderer.send('app:open-gui-dev-tools'),
  reload: () => ipcRenderer.send('app:reload'),
  relaunch: () => ipcRenderer.send('app:relaunch'),
  onCommand: (cb) => ipcRenderer.on('app:command', (_e, cmd) => cb(cmd)),
  onTheme: (cb) => ipcRenderer.on('theme:changed', (_e, v) => cb(v)),
  onToast: (cb) => ipcRenderer.on('app:toast', (_e, msg) => cb(msg)),
  // ---- DSH 服务管理 ----
  getDshStatus: () => ipcRenderer.invoke('dsh:get-status'),
  startDsh: () => ipcRenderer.invoke('dsh:start'),
  stopDsh: () => ipcRenderer.invoke('dsh:stop'),
  restartDsh: () => ipcRenderer.invoke('dsh:restart'),
  // ---- 环境诊断 ----
  getDiag: () => ipcRenderer.invoke('diag:collect'),
  // ---- 内置终端 ----
  termOpen: () => ipcRenderer.invoke('term:open'),
  termInput: (line) => ipcRenderer.invoke('term:input', line),
  termClose: () => ipcRenderer.invoke('term:close'),
  onTermData: (cb) => ipcRenderer.on('term:data', (_e, d) => cb(d)),
  onTermExit: (cb) => ipcRenderer.on('term:exit', (_e, code) => cb(code)),
  onDshStatus: (cb) => ipcRenderer.on('dsh:status', (_e, state) => cb(state)),
})
