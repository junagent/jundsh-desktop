// JUNDSH · DSH 桌面端 — 外壳逻辑
'use strict'

/* global desktop */
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

// ---------------- 外观主题 ----------------
function applyTheme(dark) {
  document.body.classList.toggle('light', !dark)
}
function setSegTheme(theme) {
  document.querySelectorAll('#seg-theme .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === theme)
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
function openSettings() {
  $('input-url').value = settings.targetUrl
  $('input-zoom').value = Math.round(settings.zoomFactor * 100)
  updateZoomFill()
  $('input-tray').checked = settings.minimizeToTray
  $('input-login').checked = !!settings.loginItem
  $('settings').classList.add('open')
  setTimeout(() => $('input-url').focus(), 120)
}
function closeSettings() {
  $('settings').classList.remove('open')
  $('input-url').classList.remove('invalid')
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
  const next = {
    targetUrl: url,
    minimizeToTray: $('input-tray').checked,
    loginItem: $('input-login').checked,
    zoomFactor: Number($('input-zoom').value) / 100,
    theme: activeTheme,
  }
  settings = await desktop.setSettings(next)
  closeSettings()
  const zoom = Math.min(2, Math.max(0.5, Number($('input-zoom').value) / 100))
  applyZoom(zoom)
  if (url !== gui.getURL()) {
    loadedOnce = false
    setState('connecting')
    gui.src = url
    offlineUrl.textContent = url
  } else {
    setState('online')
  }
  toast('设置已保存')
}

// ---------------- 初始化 ----------------
async function init() {
  settings = await desktop.getSettings()
  $('app-version').textContent = settings.version
  offlineUrl.textContent = settings.targetUrl
  applyTheme(settings.dark)
  setSegTheme(settings.theme)
  applyZoom(settings.zoomFactor)

  // 主题切换
  desktop.onTheme(({ dark }) => applyTheme(dark))
  document.querySelectorAll('#seg-theme .seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#seg-theme .seg-btn').forEach((x) => x.classList.remove('active'))
      b.classList.add('active')
    })
  })

  // 标题栏按钮
  $('btn-min').addEventListener('click', () => desktop.minimize())
  $('btn-max').addEventListener('click', async () => {
    const max = await desktop.toggleMaximize()
    setMaximized(max)
  })
  $('btn-close').addEventListener('click', () => desktop.close())
  desktop.onMaximized(setMaximized)

  // 标题栏双击最大化/还原（按钮区域除外）
  $('titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return
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
    setSegTheme('system')
    toast('已恢复默认，点击「完成」保存')
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

  // 离线重试
  $('btn-retry').addEventListener('click', () => { offlineHint.textContent = '正在重新连接…'; gui.reload() })

  // 键盘
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('settings').classList.contains('open')) { closeSettings(); return }
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) { desktop.openDevTools(); return }
    if (e.ctrlKey && !e.shiftKey) {
      if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomBy(0.05) }
      else if (e.key === '-') { e.preventDefault(); zoomBy(-0.05) }
      else if (e.key === '0') { e.preventDefault(); applyZoom(1); $('input-zoom').value = 100; updateZoomFill(); persistZoom() }
    }
  })

  // 托盘命令
  desktop.onCommand((cmd) => {
    if (cmd === 'reload') gui.reload()
    else if (cmd === 'open-settings') openSettings()
  })
  desktop.onToast(toast)

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
