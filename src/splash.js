// JUNDSH · DSH 桌面端 — 启动页动效
// ASCII 原子水印 + 标题菊花轮换（纯 ASCII：| / - \）
;(function () {
  'use strict'

  // 原子水印：慢速低频旋转，减少动态效果时定格（atom.js 内部处理）
  var atomEl = document.getElementById('splash-atom')
  if (atomEl && window.JAtom) window.JAtom.mount(atomEl, { fps: 5 })

  // caption 前缀 ASCII 菊花
  var cap = document.getElementById('caption')
  if (cap) {
    var base = cap.textContent
    var spin = ['|', '/', '-', '\\']
    var i = 0
    setInterval(function () {
      cap.textContent = spin[i++ % spin.length] + ' ' + base
    }, 140)
  }
})()
