// JUNDSH · DSH 桌面端 — ASCII 原子像素渲染器
// 纯 ASCII 字符画原子：三条椭圆轨道（水平 + 双斜）围绕核心，
// 电子沿轨道逐帧运行，帧序列首尾无缝循环。
// 浏览器用法：JAtom.mount(el, { fps }) → 返回 { stop() }
// Node 用法：require('./atom.js').frame(i) / .frames
;(function (global) {
  'use strict'

  var COLS = 25   // 画布宽（字符列）
  var ROWS = 11   // 画布高（字符行）
  var CX = 12     // 核心列
  var CY = 5      // 核心行
  var ASPECT = 0.5  // 终端字符高宽比补偿（行距压扁）
  var FRAME_COUNT = 24

  // 三条轨道：倾角（弧度）+ 半长轴/半短轴 + 转速（帧/圈取整保证无缝）+ 相位
  var ORBITS = [
    { tilt: 0,                 rx: 11,  ry: 3.6, speed: 1,  phase: 0 },
    { tilt: (58 * Math.PI) / 180,  rx: 9.5, ry: 4.4, speed: -1, phase: (2 * Math.PI) / 3 },
    { tilt: (-58 * Math.PI) / 180, rx: 9.5, ry: 4.4, speed: 1,  phase: (4 * Math.PI) / 3 },
  ]

  function orbitPoint(o, theta) {
    var cosT = Math.cos(theta), sinT = Math.sin(theta)
    var cosP = Math.cos(o.tilt), sinP = Math.sin(o.tilt)
    return {
      x: o.rx * cosT * cosP - o.ry * sinT * sinP,
      y: (o.rx * cosT * sinP + o.ry * sinT * cosP) * ASPECT,
      dx: -o.rx * sinT * cosP - o.ry * cosT * sinP,
      dy: (-o.rx * sinT * sinP + o.ry * cosT * cosP) * ASPECT,
    }
  }

  // 按轨迹局部斜率选字符：平→'-'，陡→'|'，其余按方向分 '/' 与 '\'
  function pathChar(dx, dy) {
    if (dx === 0 && dy === 0) return '-'
    var ang = Math.abs(Math.atan2(dy, dx))
    if (ang < Math.PI / 8 || ang > Math.PI - Math.PI / 8) return '-'
    if (ang > Math.PI / 2 - Math.PI / 8 && ang < Math.PI / 2 + Math.PI / 8) return '|'
    return dx * dy > 0 ? '\\' : '/'
  }

  // 预计算轨道静态字符层（后画的轨道覆盖先画的）
  var grid = new Array(ROWS)
  for (var r = 0; r < ROWS; r++) grid[r] = new Array(COLS).fill(' ')
  ORBITS.forEach(function (o) {
    var steps = 240
    for (var i = 0; i <= steps; i++) {
      var p = orbitPoint(o, (i / steps) * Math.PI * 2)
      var c = Math.round(CX + p.x)
      var rw = Math.round(CY + p.y)
      if (c >= 0 && c < COLS && rw >= 0 && rw < ROWS) grid[rw][c] = pathChar(p.dx, p.dy)
    }
  })
  // 核心（覆盖交叉点）
  grid[CY][CX] = '@'
  grid[CY][CX - 1] = '='
  grid[CY][CX + 1] = '='

  function render(electronAngles) {
    var g = new Array(ROWS)
    for (var r = 0; r < ROWS; r++) g[r] = grid[r].slice()
    ORBITS.forEach(function (o, idx) {
      var p = orbitPoint(o, electronAngles[idx])
      var c = Math.round(CX + p.x)
      var rw = Math.round(CY + p.y)
      if (c >= 0 && c < COLS && rw >= 0 && rw < ROWS && !(rw === CY && Math.abs(c - CX) <= 1)) {
        g[rw][c] = 'o'
      }
    })
    return g.map(function (row) { return row.join('') }).join('\n')
  }

  // 第 f 帧；电子角速度为 2π 的整数倍除以帧数 ⇒ 首尾无缝
  function frame(f) {
    var t = (f % FRAME_COUNT + FRAME_COUNT) % FRAME_COUNT
    var angles = ORBITS.map(function (o) {
      return o.phase + (o.speed * t * 2 * Math.PI) / FRAME_COUNT
    })
    return render(angles)
  }

  var frames = []
  for (var fi = 0; fi < FRAME_COUNT; fi++) frames.push(frame(fi))

  // 浏览器挂载：定时换帧；系统减少动态效果时定格首帧；页面隐藏时暂停省电
  function mount(el, opts) {
    if (!el) return { stop: function () {} }
    opts = opts || {}
    var fps = Math.min(24, Math.max(2, opts.fps || 8))
    var reduced = false
    try { reduced = global.matchMedia('(prefers-reduced-motion: reduce)').matches } catch (e) { /* 保持动画 */ }
    var i = 0
    var timer = null
    function show() {
      el.textContent = frame(i++)
    }
    if (reduced) {
      show()
      i = 0
      return { stop: function () {} }
    }
    show()
    timer = setInterval(show, Math.round(1000 / fps))
    function onVis() {
      if (timer) { clearInterval(timer); timer = null }
      if (!global.document.hidden) timer = setInterval(show, Math.round(1000 / fps))
    }
    global.document.addEventListener('visibilitychange', onVis)
    return {
      stop: function () {
        if (timer) clearInterval(timer)
        timer = null
        global.document.removeEventListener('visibilitychange', onVis)
      },
    }
  }

  var api = { frameCount: FRAME_COUNT, frame: frame, frames: frames, mount: mount }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else global.JAtom = api
})(typeof window !== 'undefined' ? window : globalThis)
