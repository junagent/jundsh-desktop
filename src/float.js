// JUNDSH · 桌面悬浮鲸鱼 — 悬浮窗逻辑
// 手动拖动（IPC 节流）+ 屏幕边缘吸附（贴边缩成小条，悬停浮出）+
// 深浅主题黑/白鲸切换 + 单击菜单 / 双击回主界面 / 右键菜单
'use strict'

/* global float */

const SIZE = 128
const SNAP = 40 // 吸附判定距离(px)
const STUB = 36 // 吸附时露出的宽度(px)
const MOVE_THRESHOLD = 6 // 判定为拖动的最小位移

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
let snapEdge = null // 当前吸附边: 'left'|'right'|'top'|'bottom'|null
let workArea = { x: 0, y: 0, width: 0, height: 0 }

// ---------- 菜单构建 ----------
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

// ---------- 吸附与位置 ----------
function clampScreen(x, y) {
  const { x: wx, y: wy, width: ww, height: wh } = workArea
  const c = (v, min, max) => Math.max(min, Math.min(max, v))
  return {
    x: c(x, wx - SIZE + STUB + 8, wx + ww - 8),
    y: c(y, wy - SIZE + STUB + 8, wy + wh - SIZE),
  }
}

// 拖动结束后：若贴某条边则吸附
function maybeSnap(x, y) {
  const { x: wx, y: wy, width: ww, height: wh } = workArea
  const right = wx + ww
  const bottom = wy + wh
  const options = []
  if (x - wx < SNAP) options.push('left')
  if (right - (x + SIZE) < SNAP) options.push('right')
  if (y - wy < SNAP) options.push('top')
  if (bottom - (y + SIZE) < SNAP) options.push('bottom')
  if (!options.length) return { x, y, edge: null }
  let edge = options[0]
  // 取距离最近的边
  const dist = {
    left: Math.abs(x - wx),
    right: Math.abs(right - (x + SIZE)),
    top: Math.abs(y - wy),
    bottom: Math.abs(bottom - (y + SIZE)),
  }
  edge = options.sort((a, b) => dist[a] - dist[b])[0]
  // 贴边：窗口整体仍在屏幕内，鲸鱼由 CSS 缩成小条露出
  let nx = x
  let ny = y
  if (edge === 'left') nx = wx
  if (edge === 'right') nx = right - SIZE
  if (edge === 'top') ny = wy
  if (edge === 'bottom') ny = bottom - SIZE
  return { x: nx, y: ny, edge }
}

function setSnapClass(edge) {
  snapEdge = edge
  document.documentElement.classList.toggle('snapped', !!edge)
  if (edge) {
    shell.title = '已贴边吸附，悬停浮出；双击返回主界面'
  }
}

// 拖动结束统一落位
function settle(x, y) {
  const s = maybeSnap(x, y)
  setSnapClass(s.edge)
  float.setPos(s.x, s.y).catch(() => {})
}

// ---------- 拖动 ----------
let drag = null
let raf = null
let pendingPos = null
function flushMove() {
  raf = null
  if (drag && pendingPos) {
    float.setPos(pendingPos.x, pendingPos.y).catch(() => {})
    pendingPos = null
  }
}
function scheduleMove(x, y) {
  pendingPos = clampScreen(x, y)
  if (!raf) raf = requestAnimationFrame(flushMove)
}

shell.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  setMenu(false)
  float.getPos().then((p) => {
    if (!p) return
    drag = { startX: e.screenX, startY: e.screenY, winX: p.x, winY: p.y, moved: false }
    shell.classList.add('dragging')
  }).catch(() => {})
})
window.addEventListener('mousemove', (e) => {
  if (!drag) return
  const dx = e.screenX - drag.startX
  const dy = e.screenY - drag.startY
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) > MOVE_THRESHOLD) {
    drag.moved = true
    setSnapClass(null) // 拖动中解除吸附
  }
  if (drag.moved) scheduleMove(drag.winX + dx, drag.winY + dy)
})
window.addEventListener('mouseup', (e) => {
  if (!drag) return
  const moved = drag.moved
  const dx = e.screenX - drag.startX
  const dy = e.screenY - drag.startY
  const endX = drag.winX + dx
  const endY = drag.winY + dy
  drag = null
  shell.classList.remove('dragging')
  if (moved) settle(endX, endY)
  else setMenu(true) // 单击打开菜单
})

// 双击回主界面（抑制单击开菜单的残留）
shell.addEventListener('dblclick', () => {
  setMenu(false)
  float.toggleMain()
})

// 右键菜单
window.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  setMenu(true)
})

window.addEventListener('blur', () => setMenu(false))

// ---------- 主题（黑/白鲸） ----------
function applyTheme(dark) {
  whale.src = dark ? '../assets/whale-white.svg' : '../assets/float-whale-black.svg'
}
float.getTheme().then(applyTheme).catch(() => {})
float.onTheme(applyTheme)

// ---------- 初始化 ----------
float.getWorkArea().then((wa) => {
  if (wa && wa.width) workArea = wa
}).catch(() => {})
float.onStatus(applyStatus)
float.getStatus().then(applyStatus).catch(() => {})
buildMenu()
