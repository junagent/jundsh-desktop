// JUNDSH · 桌面悬浮鲸鱼 — 预加载桥（安全隔离，仅暴露白名单方法）
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('float', {
  // 状态 & 事件
  getStatus: () => ipcRenderer.invoke('float:get-status'),
  onStatus: (cb) => ipcRenderer.on('dsh:status', (_e, s) => cb(s)),
  // 控制
  toggleMain: () => ipcRenderer.send('float:toggle-main'),
  openSettings: () => ipcRenderer.send('float:open-settings'),
  quit: () => ipcRenderer.send('float:quit'),
  hideFloat: () => ipcRenderer.send('float:hide-self'),
  // 拖拽/吸附/主题
  setPos: (x, y) => ipcRenderer.invoke('float:set-pos', x, y),
  getPos: () => ipcRenderer.invoke('float:get-pos'),
  getWorkArea: (anchor) => ipcRenderer.invoke('float:get-workarea', anchor),
  getTheme: () => ipcRenderer.invoke('float:get-theme'),
  onTheme: (cb) => ipcRenderer.on('float:theme', (_e, dark) => cb(dark)),
  // 吸附状态记忆
  setSnap: (edge) => ipcRenderer.invoke('float:set-snap', edge),
  getSnap: () => ipcRenderer.invoke('float:get-snap'),
  // 外观（主题明暗 + 皮肤）
  getPersona: () => ipcRenderer.invoke('float:get-persona'),
  onPersona: (cb) => ipcRenderer.on('float:persona', (_e, p) => cb(p)),
})
