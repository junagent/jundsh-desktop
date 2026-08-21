// JUNDSH · 桌面悬浮鲸鱼 — 悬浮窗逻辑
'use strict'

/* global float */

const shell = document.getElementById('whale-shell')
const whale = document.getElementById('whale')
const menuInner = document.getElementById('menu-inner')
const MENU_ITEMS = [
  { id: 'main', label: '打开主界面' },
  { id: 'settings', label: '设置' },
  { id: 'status', label: '连接：检测中…', status: true },
  { id: 'sep1', sep: true },
  { id: 'hide', label: '隐藏到托盘' },
  { id: 'quit', label: '退出', danger: true },
]

let menuOpen = false

// ---------- 菜单构建（菜单由本地 JS 渲染，避免皮肤/样式割裂） ----------
function buildMenu() {
  menuInner.textContent = ''
  for (const it of MENU_ITEMS) {
    if (it.sep) {
      const s = document.createElement('div')
      s.className = 'sep'
      menuInner.appendChild(s)
      continue
    }
    const b = document.createElement('button')
    b.className = 'mi' + (it.danger ? ' danger' : '')
    if (it.status) {
      const dot = document.createElement('span')
      dot.className = 'dot'
      b.appendChild(dot)
      b.dataset.statusDot = ''
      const label = document.createElement('span')
      label.className = 'grow'
      label.textContent = it.label
      b.appendChild(label)
    } else {
      const label = document.createElement('span')
      label.textContent = it.label
      b.appendChild(label)
    }
    b.addEventListener('click', () => {
      setMenu(false)
      route(it.id)
    })
    menuInner.appendChild(b)
  }
}

function setMenu(open) {
  menuOpen = open
  document.documentElement.classList.toggle('menu-open', open)
  menuInner.classList.toggle('hidden', !open)
}

function route(id) {
  switch (id) {
    case 'main': float.toggleMain(); break
    case 'settings': float.openSettings(); break
    case 'hide': float.hideFloat(); break
    case 'quit': float.quit(); break
  }
}

// ---------- 状态 ----------
function applyStatus(s) {
  if (!s) return
  const dot = menuInner.querySelector('[data-status-dot]')
  const label = menuInner.querySelector('.grow')
  if (!dot || !label) return
  if (s.alive) {
    dot.className = 'dot ok'
    label.textContent = `在线 · ${s.port}${s.uptimeSec ? ' · ' + fmt(s.uptimeSec) : ''}`
  } else {
    dot.className = 'dot err'
    label.textContent = `离线 · ${s.port}${s.lastError ? ' · ' + s.lastError : ''}`
  }
}
function fmt(sec) {
  sec = Math.max(0, Math.floor(sec))
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60)
  if (h) return `${h}h${String(m).padStart(2, '0')}m`
  return `${m}m${String(sec % 60).padStart(2, '0')}s`
}

// ---------- 交互 ----------
shell.addEventListener('mousedown', () => { setMenu(false) })
// 单击（非拖拽）打开菜单：用 click 事件并区分是否发生了拖动
let dragStart = null
shell.addEventListener('mousedown', (e) => {
  dragStart = { x: e.screenX, y: e.screenY }
})
shell.addEventListener('mouseup', (e) => {
  if (!dragStart) return
  const moved = Math.abs(e.screenX - dragStart.x) + Math.abs(e.screenY - dragStart.y) > 6
  dragStart = null
  if (!moved && !menuOpen) setMenu(true)
})
window.addEventListener('blur', () => setMenu(false))

float.onStatus(applyStatus)
float.getStatus().then(applyStatus).catch(() => {})
buildMenu()
