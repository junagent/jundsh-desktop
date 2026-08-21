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
  // 拖拽结束保存位置
  onMoved: (cb) => ipcRenderer.on('float:moved', () => cb()),
})
