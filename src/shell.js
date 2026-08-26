// JUNDSH · DSH 桌面端 — 外壳逻辑
'use strict'

/* global desktop, JAtom */
const gui = document.getElementById('gui')

let settings = null
let loadedOnce = false
let retryTimer = null
let retrySeconds = 0
let toastTimer = null
let zoomTimer = null

const $ = (id) => document.getElementById(id)
const pill = $('status-pill')
const pillText = $('status-text')
const veil = $('veil')
const offline = $('offline')
const offlineHint = $('offline-hint')
const offlineUrl = $('offline-url')

// ---------------- 状态 ----------------
function setState(state) {
  pill.className = 'pill pill-' + state
  pillText.textContent = state === 'online' ? '在线' : state === 'connecting' ? '连接中' : '离线'
  offline.classList.toggle('hidden', state !== 'offline')
  veil.classList.toggle('hidden', loadedOnce || state !== 'connecting')
  if (state !== 'offline') stopRetry()
}

// DSH 服务状态：更新标题栏胶囊附加信息 + 设置面板状态块
let lastDsh = null
function renderDshState(state) {
  if (!state) return
  lastDsh = state
  const info = $('pill-info')
  if (state.alive) {
    const modeTag = state.managed ? '托管' : state.mode === 'external' ? '外部' : '自动'
    const up = state.uptimeSec ? fmtDuration(state.uptimeSec) : ''
    info.textContent = `${state.port} · ${modeTag}${up ? ' ' + up : ''}`
    pill.title = `DSH 服务正常（pid=${state.pid || '-'}，模式=${state.mode}）`
  } else {
    info.textContent = state.mode === 'external' ? `${state.port}` : `${state.port} · 未就绪`
    pill.title = state.lastError || 'DSH 服务不可达'
  }
  // 设置面板
  const line = $('dsh-status-line')
  const dot = $('dsh-status-dot')
  const detail = $('dsh-status-detail')
  if (state.alive) {
    dot.className = 'svc-dot ok'
    line.textContent = `在线 · ${state.mode}模式${state.managed ? '（托管 pid=' + state.pid + '）' : state.pid ? '（pid=' + state.pid + '）' : ''}`
    detail.textContent = state.uptimeSec ? `已运行 ${fmtDuration(state.uptimeSec)}` : ''
  } else {
    dot.className = 'svc-dot ' + (state.lastError ? 'err' : 'wait')
    line.textContent = state.mode === 'external'
      ? '未探测到服务（请先启动，或切换为托管模式由客户端拉起）'
      : '服务未就绪'
    detail.textContent = state.lastError || ''
  }
}
function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec))
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`
  return `${s}s`
}

// ---------------- 外观主题 ----------------
function applyTheme(dark) {
  document.body.classList.toggle('light', !dark)
}
function setSegTheme(theme) {
  document.querySelectorAll('#seg-theme .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === theme)
  })
}
// 皮肤规范化走共享 Schema（src/settings-schema.js → window.JSchema），缺失时本地兜底
const normalizeSkin = (skin) => (window.JSchema ? window.JSchema.normalizeSkin(skin) : (skin === 'default' ? 'abyss' : skin))
function applySkin(skin) {
  const s = normalizeSkin(skin)
  document.body.classList.remove('skin-graphite', 'skin-violet', 'skin-emerald', 'skin-amber')
  if (s !== 'abyss') document.body.classList.add('skin-' + s)
}
function setSegSkin(skin) {
  document.querySelectorAll('#seg-skin .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.skin === skin)
  })
}

// ---------------- 缩放 ----------------
function applyZoom(z) {
  try { gui.setZoomFactor(z) } catch { /* webview 尚未就绪 */ }
}
function persistZoom() {
  clearTimeout(zoomTimer)
  zoomTimer = setTimeout(async () => {
    settings.zoomFactor = gui.getZoomFactor()
    await desktop.setSettings({ zoomFactor: settings.zoomFactor })
  }, 400)
}
function zoomBy(delta) {
  let cur = 1
  try { cur = gui.getZoomFactor() } catch { /* webview 未就绪，按默认缩放 */ }
  const z = Math.min(2, Math.max(0.5, Math.round((cur + delta) * 20) / 20))
  applyZoom(z)
  $('input-zoom').value = Math.round(z * 100)
  updateZoomFill()
  persistZoom()
}

// ---------------- 离线重试 ----------------
function startRetry() {
  stopRetry()
  retrying = true
  retrySeconds = 5
  offlineHint.textContent = '5 秒后自动重试…'
  retryTimer = setInterval(() => {
    retrySeconds -= 1
    if (retrySeconds <= 0) {
      offlineHint.textContent = '正在重新连接…'
      gui.reload()
    } else {
      offlineHint.textContent = `${retrySeconds} 秒后自动重试…`
    }
  }, 1000)
}
function stopRetry() {
  retrying = false
  if (retryTimer) { clearInterval(retryTimer); retryTimer = null }
}

// ---------------- Toast ----------------
function toast(msg) {
  const el = $('toast')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200)
}

// ---------------- 设置弹窗 ----------------
// 用设置对象刷新整个表单（打开弹窗 / 导入配置后共用）
function fillSettingsForm(s) {
  $('input-url').value = s.targetUrl
  $('input-zoom').value = Math.round(s.zoomFactor * 100)
  updateZoomFill()
  $('input-tray').checked = s.minimizeToTray
  $('input-login').checked = !!s.loginItem
  $('input-float').checked = s.floatEnabled !== false
  $('input-hotkey').checked = s.hotkeySummon !== false
  $('input-notify-svc').checked = s.notifyServiceState !== false
  $('input-dsh-port').value = s.dsh?.port ?? 8080
  $('input-dsh-repo').value = s.dsh?.sourceRepo ?? ''
  setDshMode(s.dsh?.mode ?? 'external')
  setSegTheme(s.theme ?? 'system')
  setSegSkin(s.skin)
}
async function openSettings() {
  // 实时刷新（自启状态可能被用户在系统层修改，避免用 init 时的旧缓存）
  try {
    settings = await desktop.getSettings()
  } catch { /* 保持旧值 */ }
  fillSettingsForm(settings)
  // 同步服务状态
  renderDshState(lastDsh)
  desktop.getDshStatus().then(renderDshState).catch(() => {})
  $('settings').classList.add('open')
  // 焦点：托管模式下地址框只读，聚焦缩放到可编辑控件
  const firstEditable = settings.dsh?.mode === 'external' ? $('input-url') : $('input-dsh-port')
  setTimeout(() => firstEditable?.focus(), 120)
}
function setDshMode(mode) {
  document.querySelectorAll('#seg-dsh-mode .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode)
  })
  const managed = mode !== 'external'
  $('dsh-port-field').classList.toggle('hidden', !managed)
  $('dsh-repo-field').classList.toggle('hidden', mode !== 'source')
  // 托管模式下服务地址由端口自动推导
  const urlInput = $('input-url')
  if (managed) {
    urlInput.value = `http://127.0.0.1:${parseInt($('input-dsh-port').value, 10) || 8080}`
    urlInput.setAttribute('readonly', 'true')
    urlInput.style.opacity = '0.6'
  } else {
    urlInput.removeAttribute('readonly')
    urlInput.style.opacity = ''
  }
  $('dsh-mode-hint').textContent =
    mode === 'external' ? '外部模式：请先运行 start-dsh-web.ps1 启动服务' :
    mode === 'profile' ? '托管·Profile：由客户端拉起已安装的 DSH Profile' :
    '托管·源码：从源码仓库拉起 DSH（需 tsx 运行环境）'
}
function closeSettings() {
  $('settings').classList.remove('open')
  $('input-url').classList.remove('invalid')
}

// ---------------- 环境诊断 ----------------
async function runDiag() {
  const box = $('diag-box')
  const pre = $('diag-text')
  const copyBtn = $('btn-diag-copy')
  box.classList.remove('hidden')
  pre.textContent = '正在采集…'
  copyBtn.disabled = true
  try {
    const r = await desktop.getDiag()
    pre.textContent = r.report
    $('diag-hint').textContent = r.issues.length
      ? `发现 ${r.issues.length} 个问题：${r.issues.join('；')}`
      : '未发现问题，环境正常'
    copyBtn.disabled = false
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(r.report).then(() => toast('诊断报告已复制'))
    }
  } catch {
    pre.textContent = '诊断失败'
    $('diag-hint').textContent = '无法采集诊断信息'
  }
}
function updateZoomFill() {
  const el = $('input-zoom')
  const v = Number(el.value)
  el.style.setProperty('--fill', `${((v - 50) / 150) * 100}%`)
  $('zoom-val').textContent = `${v}%`
}
async function saveSettings() {
  const url = $('input-url').value.trim()
  const input = $('input-url')
  if (!/^https?:\/\/\S+$/i.test(url)) {
    input.classList.remove('invalid')
    void input.offsetWidth
    input.classList.add('invalid')
    input.focus()
    return
  }
  const activeTheme = document.querySelector('#seg-theme .seg-btn.active')?.dataset.theme ?? 'system'
  const activeSkin = normalizeSkin(document.querySelector('#seg-skin .seg-btn.active')?.dataset.skin ?? 'abyss')
  const next = {
    targetUrl: url,
    minimizeToTray: $('input-tray').checked,
    loginItem: $('input-login').checked,
    floatEnabled: $('input-float').checked,
    hotkeySummon: $('input-hotkey').checked,
    notifyServiceState: $('input-notify-svc').checked,
    zoomFactor: Number($('input-zoom').value) / 100,
    theme: activeTheme,
    skin: activeSkin,
  }
  // DSH 服务配置
  const activeDshMode = document.querySelector('#seg-dsh-mode .seg-btn.active')?.dataset.mode ?? 'external'
  const nextPort = Math.min(65535, Math.max(1, parseInt($('input-dsh-port').value, 10) || 8080))
  next.dsh = {
    mode: activeDshMode,
    port: nextPort,
    sourceRepo: $('input-dsh-repo').value.trim(),
  }
  // 托管模式下 targetUrl 自动跟随端口，保证 webview 与服务一致
  let effectiveUrl = url
  if (activeDshMode !== 'external') {
    effectiveUrl = `http://127.0.0.1:${nextPort}`
    next.targetUrl = effectiveUrl
  }
  settings = await desktop.setSettings(next)
  closeSettings()
  const zoom = Math.min(2, Math.max(0.5, Number($('input-zoom').value) / 100))
  applyZoom(zoom)
  if (effectiveUrl !== gui.getURL()) {
    loadedOnce = false
    setState('connecting')
    gui.src = effectiveUrl
    offlineUrl.textContent = effectiveUrl
  } else {
    setState('online')
  }
  // 托管模式下保存即尝试拉起服务
  if (activeDshMode !== 'external') {
    toast('设置已保存，正在启动 DSH 服务…')
    desktop.startDsh().then((r) => {
      renderDshState(r?.state)
      if (r?.ok) toast('DSH 服务已就绪')
      else toast('服务启动未完成，请查看服务状态')
    }).catch(() => toast('服务启动失败'))
  } else {
    toast('设置已保存')
  }
}

// ---------------- 内置终端 ----------------
const termBox = $('term')
const termOut = $('term-out')
const termIn = $('term-in')
const termStatus = $('term-status')
let termOpen = false
const TERM_MAX = 20000 // 输出缓冲上限（字符）

// 命令历史（会话级）：Enter 入栈、↑/↓ 遍历、空输入不重复入栈
const termHistory = []
let termHistIdx = -1 // -1 = 当前正在输入的新命令

function appendTerm(d) {
  let txt = String(d)
  termOut.textContent += txt
  // 截断过旧内容，保持顶部最新窗口
  if (termOut.textContent.length > TERM_MAX) {
    termOut.textContent = termOut.textContent.slice(-TERM_MAX)
  }
  termOut.scrollTop = termOut.scrollHeight
}

function termSubmit() {
  const line = termIn.value
  if (!line.trim()) return // 空命令不执行也不入历史
  termIn.value = ''
  termHistory.push(line)
  termHistIdx = termHistory.length // 回到"新命令"位置
  // 本地回显
  appendTerm('PS> ' + line + '\n')
  desktop.termInput(line).catch(() => {})
}

// 历史导航：dir = -1 上一条，1 = 下一条
function termNavHistory(dir, currentVal = '') {
  if (!termHistory.length) return
  let idx = termHistIdx
  if (dir < 0) idx = Math.max(0, (idx < 0 ? termHistory.length : idx) - 1)
  else idx = Math.min(termHistory.length, (idx < 0 ? termHistory.length : idx) + 1)
  termHistIdx = idx
  if (idx >= termHistory.length) termIn.value = currentVal // 到末尾恢复正在输入的内容
  else termIn.value = termHistory[idx]
  termIn.setSelectionRange(termIn.value.length, termIn.value.length)
}

async function toggleTerm(forceOpen) {
  // 当前不可见（含 hidden 类）→ 目标为打开；否则关闭
  const wantOpen = forceOpen !== undefined ? forceOpen : termBox.classList.contains('hidden')
  if (!wantOpen) {
    await desktop.termClose().catch(() => {})
    termBox.classList.add('hidden')
    termOpen = false
    termStatus.textContent = '已关闭'
    $('btn-term').classList.remove('active')
    document.body.classList.remove('term-visible')
    return
  }
  termBox.classList.remove('hidden')
  // 终端首开占位：ASCII 原子 + 就绪提示（产生真实输出后不再出现；手动清屏保持空白）
  if (!termOut.textContent && window.JAtom) {
    termOut.textContent = JAtom.frame(0) + '\n  [JUNDSH] PowerShell 就绪 — 输入命令，回车执行；Ctrl+L 清屏\n\n'
  }
  termOpen = true
  $('btn-term').classList.add('active')
  document.body.classList.add('term-visible')
  termStatus.textContent = '连接中…'
  try {
    const r = await desktop.termOpen()
    termStatus.textContent = r.ok ? `在线 · ${r.cwd}` : '失败'
    if (r.ok && r.cwd) termStatus.title = r.cwd
  } catch {
    termStatus.textContent = '启动失败'
  }
  setTimeout(() => termIn.focus(), 60)
}

// ---------------- 未读消息感知 ----------------
// webview 标题带未读前缀（如 "(3) DeepSeek"）→ 解析上报主进程（角标/托盘/悬浮鲸）
function bindUnreadTracking() {
  const parse = window.JUnread ? window.JUnread.parseUnreadTitle : () => 0
  gui.addEventListener('page-title-updated', (e) => {
    desktop.reportUnread(parse(e.title))
  })
}

// ---------------- 页内查找（Ctrl+F） ----------------
const findBar = $('findbar')
const findIn = $('find-in')
const findCount = $('find-count')
let findOpen = false

function openFind() {
  findOpen = true
  findBar.classList.remove('hidden')
  findIn.focus()
  findIn.select()
  if (findIn.value.trim()) doFind()
}
function closeFind() {
  if (!findOpen) return
  findOpen = false
  findBar.classList.add('hidden')
  try { gui.stopFindInPage('clearSelection') } catch { /* webview 未就绪 */ }
  findCount.textContent = ''
}
function doFind(forward) {
  const q = findIn.value
  if (!q) { try { gui.stopFindInPage('clearSelection') } catch { /* ignore */ } findCount.textContent = ''; return }
  const opts = forward === undefined ? undefined : { forward: !!forward, findNext: true }
  try { gui.findInPage(q, opts) } catch { /* webview 未就绪 */ }
}

// ---------------- 命令面板（Ctrl+K） ----------------
const paletteEl = $('palette')
const paletteIn = $('palette-in')
const paletteList = $('palette-list')
let paletteActive = 0
let paletteItems = []

// 即时生效并落盘（走主进程 applySettingsPatch 同一校验通道），同时同步设置面板控件状态
async function applyLiveSetting(patch, okHint) {
  settings = await desktop.setSettings(patch)
  fillSettingsForm(settings)
  if (patch.skin) applySkin(settings.skin)
  if (patch.zoomFactor) { applyZoom(settings.zoomFactor); $('input-zoom').value = Math.round(settings.zoomFactor * 100); updateZoomFill() }
  toast(okHint)
}

function buildCommands() {
  const termVisible = termOpen && !termBox.classList.contains('hidden')
  return [
    { t: '页内查找', hint: 'Ctrl+F', run: openFind },
    { t: termVisible ? '关闭终端' : '打开终端', hint: 'Ctrl+`', run: () => toggleTerm(!termVisible) },
    { t: '打开设置', run: openSettings },
    { t: '刷新页面', run: () => { loadedOnce = false; setState('connecting'); gui.reload() } },
    { t: '启动 DSH 服务', run: async () => { toast('正在启动/接入 DSH 服务…'); const r = await desktop.startDsh().catch(() => null); renderDshState(r?.state); toast(r?.attached ? '已接入外部服务' : r?.ok ? 'DSH 服务已启动' : '启动未完成，请查看服务状态') } },
    { t: '重启 DSH 服务', run: async () => { toast('正在重启 DSH 服务…'); const r = await desktop.restartDsh().catch(() => null); if (r?.state) renderDshState(r.state) } },
    { t: '停止托管服务', run: async () => { const r = await desktop.stopDsh().catch(() => null); if (r?.state) renderDshState(r.state); toast('已停止托管服务') } },
    { t: '外观：跟随系统', run: () => applyLiveSetting({ theme: 'system' }, '已切换：跟随系统') },
    { t: '外观：浅色', run: () => applyLiveSetting({ theme: 'light' }, '已切换：浅色') },
    { t: '外观：深色', run: () => applyLiveSetting({ theme: 'dark' }, '已切换：深色') },
    { t: '皮肤：深海 ABYSS', k: 'abyss 默认', run: () => applyLiveSetting({ skin: 'abyss' }, '皮肤：深海 ABYSS') },
    { t: '皮肤：石墨蓝', k: 'graphite', run: () => applyLiveSetting({ skin: 'graphite' }, '皮肤：石墨蓝') },
    { t: '皮肤：极光紫', k: 'violet', run: () => applyLiveSetting({ skin: 'violet' }, '皮肤：极光紫') },
    { t: '皮肤：翡翠绿', k: 'emerald', run: () => applyLiveSetting({ skin: 'emerald' }, '皮肤：翡翠绿') },
    { t: '皮肤：暖阳琥珀', k: 'amber', run: () => applyLiveSetting({ skin: 'amber' }, '皮肤：暖阳琥珀') },
    { t: '界面放大', hint: 'Ctrl+=', run: () => zoomBy(0.05) },
    { t: '界面缩小', hint: 'Ctrl+-', run: () => zoomBy(-0.05) },
    { t: '缩放重置 100%', hint: 'Ctrl+0', run: () => applyLiveSetting({ zoomFactor: 1 }, '缩放已重置') },
    { t: settings.floatEnabled !== false ? '隐藏悬浮鲸鱼' : '显示悬浮鲸鱼', run: () => applyLiveSetting({ floatEnabled: !settings.floatEnabled }, settings.floatEnabled === false ? '悬浮鲸鱼已显示' : '悬浮鲸鱼已隐藏') },
    { t: settings.hotkeySummon !== false ? '关闭全局快捷键呼出' : '开启全局快捷键呼出', k: 'hotkey Ctrl+Alt+J', run: () => applyLiveSetting({ hotkeySummon: !(settings.hotkeySummon !== false) }, settings.hotkeySummon === false ? '全局快捷键已开启' : '全局快捷键已关闭') },
    { t: settings.notifyServiceState !== false ? '关闭服务状态通知' : '开启服务状态通知', run: () => applyLiveSetting({ notifyServiceState: !(settings.notifyServiceState !== false) }, settings.notifyServiceState === false ? '服务通知已开启' : '服务通知已关闭') },
    { t: '导出配置备份', run: async () => { const r = await desktop.exportSettings().catch(() => null); toast(r?.ok ? '配置已导出' : r?.error ? `导出失败：${r.error}` : '已取消') } },
    { t: '导入配置备份', run: async () => { const r = await desktop.importSettings().catch(() => null); if (!r || !r.ok) { if (r?.error) toast(r.error); return } settings = await desktop.getSettings(); fillSettingsForm(settings); applyZoom(settings.zoomFactor); applySkin(settings.skin); if (settings.targetUrl !== gui.getURL()) { loadedOnce = false; setState('connecting'); gui.src = settings.targetUrl; offlineUrl.textContent = settings.targetUrl } else setState('online'); toast(`已导入 ${r.applied.length} 项设置`) } },
    { t: '检查更新', run: async () => { toast('正在检查更新…'); await desktop.checkUpdate().catch(() => {}) } },
    { t: '收起到托盘', run: () => desktop.close() },
  ]
}

// 子序列模糊匹配：命中打分（前缀 > 词首 > 子序列），未命中返回 -1
function fuzzyScore(query, text) {
  if (!query) return 0
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  const idx = t.indexOf(q)
  if (idx === 0) return 100
  if (idx > 0 && /[\s·：:\-_/]/.test(t[idx - 1])) return 80
  if (idx > 0) return 60
  let ti = 0, score = 30
  for (const ch of q) {
    ti = t.indexOf(ch, ti)
    if (ti < 0) return -1
    ti++
  }
  return score
}

function paletteRender() {
  const q = paletteIn.value.trim()
  paletteItems = buildCommands()
    .map((c) => ({ c, s: Math.max(fuzzyScore(q, c.t), c.k ? fuzzyScore(q, c.k) : -1) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c)
  paletteActive = 0
  if (!paletteItems.length) {
    paletteList.innerHTML = '<div class="palette-empty">没有匹配的命令</div>'
    return
  }
  paletteList.innerHTML = ''
  paletteItems.forEach((c, i) => {
    const div = document.createElement('div')
    div.className = 'palette-item' + (i === paletteActive ? ' active' : '')
    div.innerHTML = `<span>${c.t}</span>${c.hint ? `<span class="pi-hint">${c.hint}</span>` : ''}`
    div.addEventListener('click', () => paletteRun(i))
    div.addEventListener('mousemove', () => {
      if (paletteActive === i) return
      paletteActive = i
      paletteList.querySelectorAll('.palette-item').forEach((el, j) => el.classList.toggle('active', j === paletteActive))
    })
    paletteList.appendChild(div)
  })
  paletteList.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
}
function paletteMove(delta) {
  if (!paletteItems.length) return
  paletteActive = (paletteActive + delta + paletteItems.length) % paletteItems.length
  paletteList.querySelectorAll('.palette-item').forEach((el, j) => el.classList.toggle('active', j === paletteActive))
  paletteList.querySelectorAll('.palette-item')[paletteActive]?.scrollIntoView({ block: 'nearest' })
}
function paletteRun(i) {
  const cmd = paletteItems[i]
  closePalette()
  if (cmd) cmd.run()
}
function openPalette() {
  closeFind()
  paletteEl.classList.remove('hidden')
  paletteIn.value = ''
  paletteRender()
  setTimeout(() => paletteIn.focus(), 40)
}
function closePalette() {
  paletteEl.classList.add('hidden')
  paletteIn.blur()
}

// ---------------- 初始化 ----------------
async function init() {
  settings = await desktop.getSettings()
  $('app-version').textContent = settings.version
  offlineUrl.textContent = settings.targetUrl
  applyTheme(settings.dark)
  applySkin(settings.skin)
  setSegTheme(settings.theme)
  applyZoom(settings.zoomFactor)

  // ASCII 原子像素：加载遮罩 + 离线页挂载（reduced-motion 时自动定格）
  if (window.JAtom) {
    JAtom.mount($('veil-atom'), { fps: 6 })
    JAtom.mount($('offline-atom'), { fps: 7 })
  }

  // 主题切换
  desktop.onTheme(({ dark }) => applyTheme(dark))
  document.querySelectorAll('#seg-theme .seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#seg-theme .seg-btn').forEach((x) => x.classList.remove('active'))
      b.classList.add('active')
    })
  })

  // 皮肤切换（即时预览，保存后持久化）
  document.querySelectorAll('#seg-skin .seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#seg-skin .seg-btn').forEach((x) => x.classList.remove('active'))
      b.classList.add('active')
      applySkin(b.dataset.skin)
    })
  })

  // DSH 服务模式切换（设置未保存前仅切换提示/显隐）
  document.querySelectorAll('#seg-dsh-mode .seg-btn').forEach((b) => {
    b.addEventListener('click', () => setDshMode(b.dataset.mode))
  })

  // DSH 服务控制
  $('btn-dsh-start').addEventListener('click', async () => {
    toast('正在启动/接入 DSH 服务…')
    const r = await desktop.startDsh().catch(() => ({ state: null }))
    renderDshState(r?.state)
    toast(r?.attached ? '已接入外部服务' : r?.ok ? 'DSH 服务已启动' : '启动未完成，请查看服务状态')
  })
  $('btn-dsh-restart').addEventListener('click', async () => {
    toast('正在重启 DSH 服务…')
    const r = await desktop.restartDsh().catch(() => ({ state: null }))
    if (r && r.state) renderDshState(r.state)
  })
  $('btn-dsh-stop').addEventListener('click', async () => {
    const r = await desktop.stopDsh().catch(() => ({ state: null }))
    if (r && r.state) renderDshState(r.state)
    toast('已停止托管服务')
  })

  // 环境诊断
  $('btn-diag').addEventListener('click', runDiag)

  // 设置导入 / 导出（备份与跨设备迁移；主进程负责文件对话框与白名单校验）
  $('btn-export-settings').addEventListener('click', async () => {
    try {
      const r = await desktop.exportSettings()
      toast(r?.ok ? '配置已导出' : r?.error ? `导出失败：${r.error}` : '已取消')
    } catch { toast('导出失败，请重试') }
  })
  $('btn-import-settings').addEventListener('click', async () => {
    try {
      const r = await desktop.importSettings()
      if (!r || !r.ok) { if (r?.error) toast(r.error); return } // 取消则静默
      settings = await desktop.getSettings()
      fillSettingsForm(settings)
      // 外壳视觉与连接立即跟上导入结果（主题经 nativeTheme 联动自动推送）
      applyZoom(settings.zoomFactor)
      applySkin(settings.skin)
      if (settings.targetUrl !== gui.getURL()) {
        loadedOnce = false
        setState('connecting')
        gui.src = settings.targetUrl
        offlineUrl.textContent = settings.targetUrl
      } else {
        setState('online')
      }
      toast(`已导入 ${r.applied.length} 项设置`)
    } catch { toast('导入失败，请重试') }
  })

  // 内置终端
  $('btn-term').addEventListener('click', () => toggleTerm())
  $('btn-term-close').addEventListener('click', () => toggleTerm(false))
  $('btn-term-clear').addEventListener('click', () => { termOut.textContent = '' })
  termIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); termSubmit(); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); termNavHistory(-1, termIn.value); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); termNavHistory(1, termIn.value); return }
    if (e.ctrlKey && e.key === 'l') { e.preventDefault(); termOut.textContent = ''; return }
    // 任意编辑时重置历史位置为"新命令"
    termHistIdx = -1
  })
  desktop.onTermData(appendTerm)
  desktop.onTermExit((code) => {
    termStatus.textContent = code === 0 ? '已退出' : `已退出(code=${code})`
    termOpen = false
    $('btn-term').classList.remove('active')
  })

  // 标题栏按钮
  $('btn-min').addEventListener('click', () => desktop.minimize())
  $('btn-max').addEventListener('click', async () => {
    const max = await desktop.toggleMaximize()
    setMaximized(max)
  })
  $('btn-close').addEventListener('click', () => desktop.close())
  desktop.onMaximized(setMaximized)

  // 标题栏双击最大化/还原（按钮区域除外；弹窗打开时忽略，避免误操作）
  $('titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return
    if ($('settings').classList.contains('open')) return
    desktop.toggleMaximize().then(setMaximized)
  })

  // 导航
  $('btn-back').addEventListener('click', () => { if (gui.canGoBack()) gui.goBack() })
  $('btn-fwd').addEventListener('click', () => { if (gui.canGoForward()) gui.goForward() })
  $('btn-reload').addEventListener('click', () => { loadedOnce = false; setState('connecting'); gui.reload() })
  $('btn-open').addEventListener('click', () => desktop.openExternal(gui.getURL()))
  $('btn-settings').addEventListener('click', openSettings)

  // 设置弹窗
  $('btn-save').addEventListener('click', saveSettings)
  $('btn-reset').addEventListener('click', async () => {
    $('input-url').value = settings.defaultUrl
    $('input-zoom').value = 100
    updateZoomFill()
    $('input-tray').checked = true
    $('input-login').checked = false
    $('input-float').checked = true
    $('input-hotkey').checked = true
    $('input-notify-svc').checked = true
    setSegTheme('system')
    setSegSkin('abyss')
    applySkin('abyss')
    // 「恢复默认」立即生效落盘，避免用户只见控件变、未保存造成困惑
    try {
      const resetDshMode = document.querySelector('#seg-dsh-mode .seg-btn.active')?.dataset.mode ?? 'external'
      await desktop.setSettings({
        targetUrl: settings.defaultUrl,
        minimizeToTray: true,
        loginItem: false,
        floatEnabled: true,
        hotkeySummon: true,
        notifyServiceState: true,
        zoomFactor: 1,
        theme: 'system',
        skin: 'abyss',
        dsh: { mode: resetDshMode, port: settings.dsh?.port ?? 8080, sourceRepo: settings.dsh?.sourceRepo ?? '' },
      })
      applyZoom(1)
      if (settings.defaultUrl !== gui.getURL()) {
        loadedOnce = false
        setState('connecting')
        gui.src = settings.defaultUrl
        offlineUrl.textContent = settings.defaultUrl
      } else {
        setState('online')
      }
      toast('已恢复默认')
    } catch {
      toast('恢复默认失败，请重试')
    }
  })
  $('btn-settings-close').addEventListener('click', closeSettings)
  $('settings').addEventListener('click', (e) => { if (e.target === $('settings')) closeSettings() })
  $('input-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSettings() })
  $('input-zoom').addEventListener('input', () => {
    updateZoomFill()
    applyZoom(Number($('input-zoom').value) / 100)
  })
  $('input-zoom').addEventListener('change', () => {
    settings.zoomFactor = Number($('input-zoom').value) / 100
    desktop.setSettings({ zoomFactor: settings.zoomFactor })
  })

  // 托管模式下端口变化实时同步服务地址
  $('input-dsh-port').addEventListener('input', () => {
    const mode = document.querySelector('#seg-dsh-mode .seg-btn.active')?.dataset.mode ?? 'external'
    if (mode !== 'external') {
      const port = Math.min(65535, Math.max(1, parseInt($('input-dsh-port').value, 10) || 8080))
      $('input-url').value = `http://127.0.0.1:${port}`
    }
  })

  // 离线重试
  $('btn-retry').addEventListener('click', () => { offlineHint.textContent = '正在重新连接…'; gui.reload() })
  // 离线页：尝试启动服务（托管模式下由客户端拉起；外部模式给出提示后进设置）
  $('btn-offline-start-svc').addEventListener('click', async () => {
    const cur = await desktop.getSettings().catch(() => null)
    const mode = cur?.dsh?.mode ?? 'external'
    if (mode === 'external') {
      toast('外部模式：请先在设置中启用「托管·Profile/源码」')
      openSettings()
      return
    }
    offlineHint.textContent = '正在启动 DSH 服务…'
    const r = await desktop.startDsh().catch(() => ({ state: null }))
    offlineHint.textContent = r?.ok ? '服务已启动，正在连接…' : (r?.state?.lastError || '启动未完成，请查看设置中的服务状态')
    renderDshState(r?.state)
    if (r?.ok) gui.reload()
  })

  // 键盘
  document.addEventListener('keydown', (e) => {
    const paletteOpen = !$('palette').classList.contains('hidden')
    // Esc：命令面板 → 查找条 → 设置 → 终端（从上到下逐层关闭）
    if (e.key === 'Escape') {
      if (paletteOpen) { closePalette(); return }
      if (findOpen) { closeFind(); return }
      if ($('settings').classList.contains('open')) { closeSettings(); return }
      if (termOpen && !termBox.classList.contains('hidden')) { toggleTerm(false); return }
    }
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) { desktop.openDevTools(); return }
    // 命令面板（设置弹窗打开时不抢占）
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      if ($('settings').classList.contains('open')) return
      e.preventDefault(); openPalette(); return
    }
    // 页内查找（终端抽屉打开时不抢，避免被遮挡造成困惑；webview 内按键走 before-input-event 转发）
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
      const termVisible = termOpen && !termBox.classList.contains('hidden')
      if ($('settings').classList.contains('open') || termVisible) return
      e.preventDefault(); openFind(); return
    }
    if (e.ctrlKey && !e.shiftKey && !$('settings').classList.contains('open')) {
      // 设置弹窗打开时禁用缩放快捷键，避免干扰滑块操作
      if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomBy(0.05) }
      else if (e.key === '-') { e.preventDefault(); zoomBy(-0.05) }
      else if (e.key === '0') { e.preventDefault(); applyZoom(1); $('input-zoom').value = 100; updateZoomFill(); persistZoom() }
    }
  })

  // 页内查找条交互
  findIn.addEventListener('input', () => doFind())
  findIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doFind(!e.shiftKey) }
  })
  $('find-next').addEventListener('click', () => { findIn.focus(); doFind(true) })
  $('find-prev').addEventListener('click', () => { findIn.focus(); doFind(false) })
  $('find-close').addEventListener('click', closeFind)

  // 命令面板交互
  paletteIn.addEventListener('input', paletteRender)
  paletteIn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteMove(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteMove(-1) }
    else if (e.key === 'Enter') { e.preventDefault(); paletteRun(paletteActive) }
  })
  $('palette').addEventListener('mousedown', (e) => { if (e.target === $('palette')) closePalette() })

  // 托盘命令
  desktop.onCommand((cmd) => {
    if (cmd === 'reload') gui.reload()
    else if (cmd === 'open-settings') openSettings()
  })
  desktop.onToast(toast)

  // DSH 服务状态订阅
  desktop.onDshStatus(renderDshState)
  desktop.getDshStatus().then(renderDshState).catch(() => {})

  // 键盘：Ctrl+` 快速开关终端
  document.addEventListener('keydown', (e2) => {
    if (e2.ctrlKey && !e2.shiftKey && !e2.altKey && (e2.key === '`' || e2.key === '~')) {
      e2.preventDefault()
      toggleTerm()
    }
  })

  bindGui()
  gui.src = settings.targetUrl
}

function setMaximized(max) {
  $('btn-max').classList.toggle('restore', max)
  $('btn-max').title = max ? '还原' : '最大化'
}

// ---------------- webview ----------------
let failed = false
let retrying = false

function bindGui() {
  gui.addEventListener('did-start-loading', () => {
    failed = false
    if (!retrying) setState('connecting')
  })

  gui.addEventListener('did-stop-loading', () => {
    if (failed) return // 失败后仍会触发，保持离线
    if (!loadedOnce) {
      loadedOnce = true
      desktop.guiReady()
    }
    setState('online')
  })

  gui.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3) return // ERR_ABORTED
    if (e.isMainFrame === false) return // 页面内 iframe/子资源失败不算离线
    failed = true
    setState('offline')
    startRetry()
  })

  gui.addEventListener('render-process-gone', () => {
    failed = true
    setState('offline')
    startRetry()
  })

  gui.addEventListener('new-window', (e) => {
    e.preventDefault()
    if (/^https?:/i.test(e.url)) desktop.openExternal(e.url)
  })

  gui.addEventListener('did-navigate', updateNav)
  gui.addEventListener('did-navigate-in-page', updateNav)
  bindUnreadTracking()
  // 页内查找结果计数
  gui.addEventListener('found-in-page', (e) => {
    const r = e.result
    findCount.textContent = r && r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : ''
  })

  // 键盘快捷键只在 webview 挂载时注册一次（dom-ready 每次导航都会触发，若在
  // 那里注册会导致 before-input-event 监听器不断累积、快捷键重复执行）
  gui.addEventListener('did-attach', () => {
    try {
      gui.getWebContents().on('before-input-event', (e, input) => {
        if (input.type !== 'keyDown') return
        // webview 内按 F12 / Ctrl+Shift+I：打开 DSH 页面的开发者工具
        if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
          e.preventDefault(); desktop.openGuiDevTools(); return
        }
        if (!input.control && !input.meta) return
        // webview 内的 Ctrl+F / Ctrl+K 转给外壳（页内查找 / 命令面板）
        if (!input.shift && !input.alt) {
          const k = input.key.toLowerCase()
          if (k === 'f') { e.preventDefault(); openFind(); return }
          if (k === 'k') { e.preventDefault(); openPalette(); return }
        }
        if (input.key === '=' || input.key === '+') { e.preventDefault(); zoomBy(0.05) }
        else if (input.key === '-') { e.preventDefault(); zoomBy(-0.05) }
        else if (input.key === '0') { e.preventDefault(); applyZoom(1); $('input-zoom').value = 100; updateZoomFill(); persistZoom() }
      })
    } catch { /* webview 未就绪 */ }
  })

  gui.addEventListener('dom-ready', () => {
    applyZoom(settings.zoomFactor)
    updateNav()
  })
}

function updateNav() {
  try {
    $('btn-back').classList.toggle('disabled', !gui.canGoBack())
    $('btn-fwd').classList.toggle('disabled', !gui.canGoForward())
  } catch { /* ignore */ }
}

init()
