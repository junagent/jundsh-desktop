// JUNDSH · DSH 桌面端 — 主进程
'use strict'

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, session, nativeImage, nativeTheme, screen, webContents, Notification, crashReporter, dialog, globalShortcut } = require('electron')
const { autoUpdater } = require('electron-updater')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { DshService } = require('./dsh-svc')
const diag = require('./diag')
const debugHarness = require('./debug-harness')
const Schema = require('./settings-schema')

const APP_NAME = 'JUNDSH'
const DEFAULT_URL = 'http://127.0.0.1:8080'
const DEBUG_SHOT = !!process.env.DSH_DESKTOP_SHOT // 调试：截图后退出
// 便携版（electron-builder portable target 解压运行）不支持自动更新
const IS_PORTABLE = process.env.PORTABLE_EXECUTABLE_DIR !== undefined
// 开机自启静默启动：登录后小鲸鱼在托盘待命，不弹窗口（自启项带 --hidden 参数写入）
const START_HIDDEN = process.argv.includes('--hidden')
const HOTKEY_TOGGLE = 'Control+Alt+J' // 全局呼出/隐藏主窗

let mainWindow = null
let splashWindow = null
let floatWindow = null // 桌面悬浮鲸鱼
let tray = null
let quitting = false
let settings = null
let saveTimer = null // 设置防抖写入定时器
let dshSvc = null // DSH 服务管理器
let termChild = null // 内置终端子进程
let lastUpdateToastPct = null // 更新进度 toast 节流记忆

// 崩溃转储：仅本地保留（不外传），路径会出现在「环境诊断」报告中
// 必须在 app ready 之前启动才能覆盖启动期崩溃
try {
  crashReporter.start({ companyName: 'JUNDSH', uploadToServer: false })
} catch { /* 平台不支持或重复启动时忽略 */ }

const buildDir = (...p) => path.join(__dirname, '..', 'build', ...p)
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')

// ---------------- 设置持久化 ----------------
function loadSettings() {
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
  } catch {
    settings = {}
    migrateSettings()
  }
  // 字段规范化统一走 src/settings-schema.js（单一事实源）
  settings.targetUrl = Schema.isValidHttpUrl(settings.targetUrl) ? settings.targetUrl : DEFAULT_URL
  settings.minimizeToTray = settings.minimizeToTray !== false
  settings.zoomFactor = Schema.clampZoom(settings.zoomFactor)
  settings.theme = Schema.normalizeTheme(settings.theme)
  // v1.4 迁移：旧默认键 'default'（石墨蓝）→ 深海 ABYSS；未知值回退 abyss
  settings.skin = Schema.normalizeSkin(settings.skin)
  settings.bounds = sanitizeBounds(settings.bounds)
  // DSH 服务管理配置（默认外部模式，完全向后兼容）
  settings.dsh = {
    mode: Schema.normalizeDshMode(settings.dsh?.mode),
    port: Schema.clampPort(settings.dsh?.port, 8080),
    sourceRepo: typeof settings.dsh?.sourceRepo === 'string' && settings.dsh.sourceRepo
      ? settings.dsh.sourceRepo
      : path.join(os.homedir(), 'deepseek-harness'),
  }
  // 桌面悬浮鲸鱼（默认开启）
  settings.floatEnabled = settings.floatEnabled !== false
  // 全局快捷键呼出 / 服务状态系统通知（默认开启）
  settings.hotkeySummon = settings.hotkeySummon !== false
  settings.notifyServiceState = settings.notifyServiceState !== false
  const fb = settings.floatBounds
  const hasSavedFloat = !!(fb && typeof fb === 'object' && Number.isInteger(fb.x) && Number.isInteger(fb.y))
  settings.floatBounds = hasSavedFloat
    ? { x: fb.x, y: fb.y }
    : defaultFloatPos()
  // 吸附状态记忆（重启后恢复上次吸附边）
  // 首次启动（无历史位置）默认吸附右边缘缩条，让鲸鱼以精致姿态登场
  settings.floatSnapEdge = ['left', 'right', 'top', 'bottom'].includes(settings.floatSnapEdge)
    ? settings.floatSnapEdge
    : (hasSavedFloat ? null : 'right')
  return settings
}

// 悬浮鲸鱼默认位置：主显示器右侧，距右缘 24、距底缘 96（避开任务栏）
function defaultFloatPos() {
  const { workArea } = screen.getPrimaryDisplay()
  return { x: workArea.x + workArea.width - 24 - 128, y: workArea.y + workArea.height - 96 - 128 }
}

// DSH 服务管理器：把最新状态推给外壳与悬浮窗；状态行变化时同步托盘菜单
let lastTrayState = null
function pushDshStatus(state) {
  mainWindow?.webContents.send('dsh:status', state)
  if (floatWindow && !floatWindow.isDestroyed()) floatWindow.webContents.send('dsh:status', state)
  // 托盘仅在有状态变化且菜单已建时刷新（避免每次探测重建菜单）
  if (tray && JSON.stringify(lastTrayState) !== JSON.stringify(state)) {
    lastTrayState = { alive: state.alive, port: state.port, lastError: state.lastError || null }
    refreshTrayMenu()
  }
  // 托盘彩色状态点
  setTrayStatus(state.alive ? 'online' : (state.mode !== 'external' && state.managed ? 'connecting' : 'offline'))
  maybeNotifyServiceState(state)
}

// ---------------- 服务状态系统通知 ----------------
// 主窗在托盘/隐藏时，DSH 上线↔离线转换用系统通知提醒（转换边缘触发，不重复轰炸）；
// 首次探测只记基线；用户正看着主窗时不打扰（状态胶囊已可见）
let lastAliveState // undefined = 尚未收到首次探测结果
function maybeNotifyServiceState(state) {
  const alive = !!state.alive
  if (lastAliveState === undefined) { lastAliveState = alive; return }
  if (alive === lastAliveState) return
  lastAliveState = alive
  if (!settings.notifyServiceState) return
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) return
  if (!Notification.isSupported()) return
  const n = new Notification({
    title: alive ? 'JUNDSH 已连接 DSH' : 'JUNDSH 与 DSH 断开',
    body: alive
      ? `服务已上线（端口 ${state.port}），点击查看`
      : `服务不可达（端口 ${state.port}${state.lastError ? ' · ' + state.lastError : ''}），点击查看`,
    icon: buildDir('icon.png'),
  })
  n.on('click', () => showMainWindow())
  n.on('failed', (_e, err) => console.error('[jundsh] 状态通知失败:', err))
  try { n.show() } catch { /* 平台限制时忽略 */ }
}

// ---------------- 全局快捷键呼出/隐藏主窗 ----------------
function applyHotkeySetting() {
  globalShortcut.unregister(HOTKEY_TOGGLE)
  if (!settings.hotkeySummon) return
  let ok = false
  try {
    ok = globalShortcut.register(HOTKEY_TOGGLE, toggleMainWindow)
  } catch (err) {
    console.error('[jundsh] 全局快捷键注册失败:', err.message)
  }
  if (!ok) {
    settings.hotkeySummon = false
    mainWindow?.webContents.send('app:toast', `快捷键 ${HOTKEY_TOGGLE} 注册失败（可能被其他应用占用）`)
  }
}
function toggleMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide()
  else showMainWindow()
}
function requireDshSvc() {
  if (dshSvc) return dshSvc
  dshSvc = new DshService({
    getSettings: () => settings,
    send: pushDshStatus,
    log: (...a) => console.log('[dsh-svc]', ...a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x) } catch { return String(x) } })()))),
  })
  dshSvc.start()
  return dshSvc
}

// 校验窗口记忆位置在某个显示器内，避免屏幕变化后窗口跑到屏幕外
function sanitizeBounds(b) {
  if (!b || typeof b !== 'object') return null
  const { x, y, width, height } = b
  if (![x, y, width, height].every(Number.isFinite)) return null
  if (width < 960 || height < 600) return null
  const displays = screen.getAllDisplays()
  const ok = displays.some((d) => {
    const wa = d.workArea
    return (
      x < wa.x + wa.width - 100 && x + width > wa.x + 100 &&
      y < wa.y + wa.height - 60 && y + height > wa.y + 60
    )
  })
  return ok ? { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) } : null
}

function applyTheme() {
  nativeTheme.themeSource = settings?.theme ?? 'system'
}

// 开机自启状态：以 HKCU Run 注册表键为准（app.getLoginItemSettings 在用户通过
// 任务管理器/设置禁用后可能与 OS 状态不同步，见 electron#20122）
function getLoginItemState() {
  try {
    const out = execFileSync('reg', [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v', APP_NAME,
    ], { encoding: 'utf8', timeout: 3000, windowsHide: true })
    return out.includes(APP_NAME)
  } catch {
    // 键不存在 = 未开启；也回退官方 API 兜底
    return app.getLoginItemSettings().openAtLogin
  }
}

// 设置写入防抖：频繁改动（缩放滑块等）合并为一次落盘；immediate=true 立即写
function saveSettings(immediate = false) {
  const doWrite = () => {
    try {
      fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2))
    } catch (err) {
      console.error('[jundsh] 保存设置失败:', err.message)
    }
  }
  if (immediate) {
    clearTimeout(saveTimer)
    saveTimer = null
    doWrite()
    return
  }
  clearTimeout(saveTimer)
  saveTimer = setTimeout(doWrite, 500)
}

// 从旧版名称目录迁移设置（小鲸鱼桌面端 / whale-desktop → JUNDSH）
function migrateSettings() {
  for (const old of ['小鲸鱼桌面端', 'whale-desktop']) {
    const oldFile = path.join(app.getPath('userData'), '..', old, 'settings.json')
    try {
      const data = fs.readFileSync(oldFile, 'utf8')
      fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
      fs.writeFileSync(settingsFile(), data)
      console.log('[jundsh] 已从旧目录迁移设置:', old)
      settings = JSON.parse(data)
      return
    } catch { /* 该目录不存在或读取失败，尝试下一个 */ }
  }
}

// ---------------- 窗口 ----------------
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 460,
    height: 330,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: { sandbox: true, contextIsolation: true },
  })
  splashWindow.loadFile(path.join(__dirname, 'splash.html'))
  splashWindow.once('ready-to-show', () => splashWindow?.show())
  splashWindow.on('closed', () => { splashWindow = null })
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close()
    splashWindow = null
  }
}

function createMainWindow() {
  const b = settings.bounds
  mainWindow = new BrowserWindow({
    x: b?.x,
    y: b?.y,
    width: b?.width ?? 1440,
    height: b?.height ?? 880,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    icon: buildDir('icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#070d17' : '#f4f5f7',
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    // Windows 11：系统级亚克力/Mica 背景（不支持时自动忽略）
    ...(process.platform === 'win32' ? { backgroundMaterial: 'mica' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // preload 仅用 contextBridge/ipcRenderer，沙箱下可用
      webviewTag: true,
      spellcheck: false,
    },
  })

  mainWindow.loadFile(path.join(__dirname, 'shell.html'))

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[jundsh] shell 加载失败:', code, desc, url)
  })
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[jundsh] shell 渲染进程退出:', JSON.stringify(details))
    // 意外崩溃（非退出流程）自动重载外壳；限次避免崩溃循环风暴
    if (!quitting && details.reason !== 'clean-exit') {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload()
      }, 800)
    }
  })
  mainWindow.webContents.on('console-message', (event) => {
    if (event.level >= 2) console.log('[jundsh:shell]', event.message, `(${event.sourceId}:${event.lineNumber})`)
  })

  mainWindow.once('ready-to-show', () => {
    // 开机自启静默启动：不弹窗、不出启动页，小鲸鱼在托盘待命（点托盘/快捷键唤出）
    if (START_HIDDEN) { setTimeout(closeSplash, 0); return }
    if (settings.maximized) mainWindow.maximize()
    mainWindow.show()
    // 启动页居中到主窗口
    if (splashWindow && !splashWindow.isDestroyed()) {
      const [x, y] = mainWindow.getPosition()
      const [w, h] = mainWindow.getSize()
      splashWindow.setPosition(Math.round(x + w / 2 - 230), Math.round(y + h / 2 - 165))
    }
    // GUI 就绪由 shell 通过 IPC 告知；这里兜底关闭启动页
    setTimeout(closeSplash, 12000)
  })

  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized', false))
  // 用户看向主窗即清空未读（任务栏角标/托盘计数一并归零）
  mainWindow.on('focus', () => applyUnread(0))
  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('window:maximized', true))
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('window:maximized', false))

  // 关闭按钮：最小化到托盘（可设置）
  mainWindow.on('close', (e) => {
    saveWindowState()
    if (!quitting && settings?.minimizeToTray) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })

  // 外部链接一律交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const fileUrl = mainWindow.webContents.getURL().split('#')[0]
    if (!url.startsWith(fileUrl)) {
      e.preventDefault()
      if (/^https?:/i.test(url)) shell.openExternal(url)
    }
  })

  // webview 安全加固：拒绝任何注入的 preload / node 能力
  mainWindow.webContents.on('will-attach-webview', (_e, webPreferences) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.spellcheck = false
  })

  // 下载保存到系统下载目录；同名文件自动追加 (1)(2)… 避免静默覆盖
  session.defaultSession.on('will-download', (_e, item) => {
    const dir = app.getPath('downloads')
    let name = item.getFilename().replace(/[\\/:*?"<>|]/g, '_') // 清洗非法字符
    let target = path.join(dir, name)
    const ext = path.extname(name)
    const base = path.basename(name, ext)
    let i = 1
    while (fs.existsSync(target)) {
      target = path.join(dir, `${base} (${i})${ext}`)
      i++
    }
    item.setSavePath(target)
    item.once('done', (_ev, state) => {
      if (state === 'completed' && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:toast', `已下载到 ${target}`)
      }
    })
  })

  // 调试截图/探针（DSH_DESKTOP_SHOT）：实现已移至 src/debug-harness.js
  if (DEBUG_SHOT) {
    debugHarness.scheduleSplashShot(splashWindow)
    debugHarness.scheduleShellProbe(mainWindow)
  }
}

function showMainWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

// ---------------- 便携版迁移引导 ----------------
// electron-builder portable 运行时解压到临时目录，无法自动更新；
// 首次运行一次性提示用户迁移到安装版（设置记忆，不打扰）
function maybePortableNudge() {
  if (!IS_PORTABLE || !mainWindow || settings.portableNudgeShown) return
  settings.portableNudgeShown = true
  saveSettings(true)
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'JUNDSH 便携版',
    message: '你正在使用 JUNDSH 便携版',
    detail: '便携版不支持自动更新。建议下载安装版，获得自动更新与更完整的系统集成体验。',
    buttons: ['前往下载安装版', '继续使用便携版'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }).then(({ response }) => {
    if (response === 0) shell.openExternal('https://github.com/junagent/jundsh-desktop/releases/latest')
  }).catch(() => { /* 对话框被取消 */ })
}

// ---------------- 桌面悬浮鲸鱼 ----------------
function createFloatWindow() {
  if (!settings.floatEnabled) return
  const b = settings.floatBounds
  const SIZE = 128
  floatWindow = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: SIZE,
    height: SIZE,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'float-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  floatWindow.setAlwaysOnTop(true, 'floating')
  floatWindow.loadFile(path.join(__dirname, 'float.html'))
  // 调试探针（DSH_DESKTOP_SHOT=float）：实现已移至 src/debug-harness.js
  if (process.env.DSH_DESKTOP_SHOT === 'float') {
    debugHarness.scheduleFloatProbe(floatWindow)
    return floatWindow
  }
  floatWindow.on('moved', () => {
    if (!floatWindow || floatWindow.isDestroyed()) return
    const [x, y] = floatWindow.getPosition()
    settings.floatBounds = { x, y }
    saveSettings()
  })
  floatWindow.on('closed', () => { floatWindow = null })
  return floatWindow
}

function showFloatWindow() {
  if (!floatWindow || floatWindow.isDestroyed()) createFloatWindow()
  if (floatWindow && !floatWindow.isDestroyed() && !floatWindow.isVisible()) floatWindow.show()
}

// ---------------- 自动更新（基于 GitHub Releases） ----------------
function setupAutoUpdate() {
  if (!app.isPackaged) {
    // 开发模式：不检查更新，但给出可察觉提示（避免"为什么没有更新"困惑）
    console.log('[jundsh] 开发模式：不检查自动更新')
    setTimeout(() => {
      mainWindow?.webContents.send('app:toast', '开发模式不检查更新')
    }, 4000)
    return
  }
  if (IS_PORTABLE) {
    console.log('[jundsh] 便携版不支持自动更新，请使用安装版')
    return
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    console.log('[jundsh] 正在检查更新…')
  })
  autoUpdater.on('update-available', (info) => {
    console.log('[jundsh] 发现新版本:', info.version)
    lastUpdateToastPct = null
  })
  autoUpdater.on('update-not-available', (info) => {
    console.log('[jundsh] 当前已是最新版本', info.version)
  })
  autoUpdater.on('download-progress', (p) => {
    console.log(`[jundsh] 下载更新 ${Math.round(p.percent)}%`)
    // 节流：仅整 +5% 或首次提示 toast，避免高频刷屏
    const pct = Math.round(p.percent)
    if (pct >= 5 && (pct % 5 === 0 || !lastUpdateToastPct)) {
      lastUpdateToastPct = pct
      mainWindow?.webContents.send('app:toast', `正在下载更新 ${pct}%…`)
    }
  })
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[jundsh] 更新已下载:', info.version)
    lastUpdateToastPct = null
    notifyUpdateReady(info.version)
  })
  autoUpdater.on('error', (err) => {
    console.error('[jundsh] 自动更新失败:', err && err.message)
    mainWindow?.webContents.send('app:toast', '检查更新失败，请稍后重试')
  })

  // 启动 8 秒后静默检查（避开启动高峰期）
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[jundsh] 检查更新出错:', err && err.message)
    })
  }, 8000)
}

// 更新就绪：系统通知，点击后重启安装
function notifyUpdateReady(version) {
  if (!Notification.isSupported()) return
  const n = new Notification({
    title: 'JUNDSH 更新已就绪',
    body: `新版本 v${version} 已下载完成，点击重启并安装`,
    icon: buildDir('icon.png'),
  })
  n.on('click', () => {
    setImmediate(() => autoUpdater.quitAndInstall())
  })
  n.show()
  // 同时给外壳发 toast
  mainWindow?.webContents.send('app:toast', `更新 v${version} 已下载，重启后生效`)
}

// 托盘状态行用短时长格式化（跟 shell fmtDuration 类似，独立小函数避免依赖）
function fmtTray(sec) {
  sec = Math.max(0, Math.floor(sec))
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60)
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  return `${m}m${String(sec % 60).padStart(2, '0')}s`
}

// ---------------- 未读消息感知 ----------------
// DSH 网页把未读数写进标题前缀（如 "(3) DeepSeek"），外壳解析后经 app:unread 上报；
// 这里驱动任务栏角标 + 托盘 tooltip，并转发悬浮鲸加速呼吸灯。主窗聚焦 = 用户在看，立即清零。
let unreadCount = 0
const overlayBadge = () => nativeImage.createFromPath(buildDir('overlay-unread.png'))
function applyUnread(n) {
  n = Math.max(0, Math.min(999, parseInt(n, 10) || 0))
  if (n === unreadCount) return
  unreadCount = n
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setOverlayIcon(unreadCount > 0 ? overlayBadge() : null, unreadCount > 0 ? `${unreadCount} 条未读消息` : '')
  }
  updateTrayTooltip()
  if (floatWindow && !floatWindow.isDestroyed()) floatWindow.webContents.send('float:unread', unreadCount)
}
function updateTrayTooltip() {
  if (!tray) return
  tray.setToolTip(`${APP_NAME} · DSH 桌面端${unreadCount > 0 ? ` · ${unreadCount} 条未读` : ''}`)
}

function createTray() {
  const icon = nativeImage.createFromPath(buildDir('tray.png'))
  tray = new Tray(icon)
  updateTrayTooltip()
  refreshTrayMenu()
  tray.on('double-click', showMainWindow)
}

// 服务状态 → 托盘彩色状态点（online 青蓝 / connecting 琥珀 / offline 灰红；key 去重防闪烁）
let lastTrayStatusKey = ''
function setTrayStatus(key) {
  if (!tray || key === lastTrayStatusKey) return
  lastTrayStatusKey = key
  const file = buildDir(key === 'idle' ? 'tray.png' : `tray-${key}.png`)
  const img = nativeImage.createFromPath(file)
  tray.setImage(img.isEmpty() ? nativeImage.createFromPath(buildDir('tray.png')) : img)
}

// 重建托盘菜单（悬浮开关状态变化后刷新，保证托盘与设置/悬浮窗一致）
function refreshTrayMenu() {
  if (!tray) return
  // 当前连接状态行（只读；由 pushDshStatus 在状态变化时刷新）
  const st = dshSvc ? dshSvc.getState() : null
  const statusLabel = st
    ? (st.alive
      ? `● DSH 在线 · ${st.port}${st.uptimeSec ? ' · ' + fmtTray(st.uptimeSec) : ''}`
      : `○ DSH 离线 · ${st.port}${st.lastError ? ' · ' + st.lastError : ''}`)
    : '● DSH 连接中…'
  const menu = Menu.buildFromTemplate([
    { label: '显示主界面', click: showMainWindow },
    { type: 'separator' },
    { label: statusLabel, enabled: false, icon: undefined },
    { label: '刷新页面', click: () => mainWindow?.webContents.send('app:command', 'reload') },
    {
      label: '桌面悬浮鲸鱼',
      type: 'checkbox',
      checked: settings.floatEnabled !== false,
      click: (item) => {
        settings.floatEnabled = item.checked
        saveSettings(true)
        if (item.checked) {
          if (!floatWindow || floatWindow.isDestroyed()) createFloatWindow()
          else if (!floatWindow.isVisible()) floatWindow.show()
        } else if (floatWindow && !floatWindow.isDestroyed()) {
          floatWindow.close()
          floatWindow = null
        }
        refreshTrayMenu()
      },
    },
    { label: '显示悬浮鲸鱼', click: showFloatWindow, enabled: settings.floatEnabled !== false },
    { label: '设置…', click: () => mainWindow?.webContents.send('app:command', 'open-settings') },
    { label: '检查更新…', click: () => {
      if (!app.isPackaged) { mainWindow?.webContents.send('app:toast', '开发模式不检查更新'); return }
      if (IS_PORTABLE) { mainWindow?.webContents.send('app:toast', '便携版不支持自动更新，请下载安装版'); return }
      autoUpdater.checkForUpdates().catch((err) => console.error('[jundsh] 检查更新出错:', err && err.message))
    } },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
}

// ---------------- 窗口状态记忆 ----------------
function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  settings.maximized = mainWindow.isMaximized()
  if (!settings.maximized) settings.bounds = mainWindow.getBounds()
  saveSettings(true) // 退出路径立即落盘
}

// ---------------- 设置补丁应用 ----------------
// 设置面板保存 / 备份导入共用的唯一入口：白名单校验 + 联动副作用 + 落盘
function applySettingsPatch(patch) {
  if (!patch || typeof patch !== 'object') return
  if (Schema.isValidHttpUrl(typeof patch.targetUrl === 'string' ? patch.targetUrl.trim() : '')) {
    settings.targetUrl = patch.targetUrl.trim()
  }
  if (typeof patch.minimizeToTray === 'boolean') settings.minimizeToTray = patch.minimizeToTray
  if (typeof patch.zoomFactor === 'number') {
    settings.zoomFactor = Schema.clampZoom(patch.zoomFactor)
  }
  if (Schema.THEMES.includes(patch.theme)) {
    settings.theme = patch.theme
    applyTheme()
  }
  if (Schema.isKnownSkin(patch.skin)) {
    // 兼容旧键：'default' 视为 abyss（isKnownSkin 已识别别名）
    settings.skin = Schema.normalizeSkin(patch.skin)
    if (floatWindow && !floatWindow.isDestroyed()) {
      floatWindow.webContents.send('float:persona', { dark: nativeTheme.shouldUseDarkColors, skin: settings.skin })
    }
  }
  if (typeof patch.loginItem === 'boolean') {
    // 自启项带 --hidden：登录后静默进托盘，不弹窗打扰
    app.setLoginItemSettings({ openAtLogin: patch.loginItem, args: ['--hidden'] })
    // 注意：不持久化 loginItem，读取时实时来自 getLoginItemSettings
  }
  if (typeof patch.hotkeySummon === 'boolean') {
    settings.hotkeySummon = patch.hotkeySummon
    applyHotkeySetting()
  }
  if (typeof patch.notifyServiceState === 'boolean') {
    settings.notifyServiceState = patch.notifyServiceState
  }
  if (patch.dsh && typeof patch.dsh === 'object') {
    const next = { ...settings.dsh }
    if (Schema.DSH_MODES.includes(patch.dsh.mode)) {
      next.mode = patch.dsh.mode
      // 切换模式时同步端口默认值
      if (typeof patch.dsh.port === 'number') next.port = Schema.clampPort(patch.dsh.port)
    } else if (typeof patch.dsh.port === 'number') {
      next.port = Schema.clampPort(patch.dsh.port)
    }
    if (typeof patch.dsh.sourceRepo === 'string' && patch.dsh.sourceRepo) next.sourceRepo = patch.dsh.sourceRepo
    settings.dsh = next
    if (dshSvc) dshSvc.applyConfig()
  }
  // 桌面悬浮鲸鱼开关
  if (typeof patch.floatEnabled === 'boolean') {
    settings.floatEnabled = patch.floatEnabled
    if (settings.floatEnabled) {
      if (!floatWindow || floatWindow.isDestroyed()) createFloatWindow()
      else if (!floatWindow.isVisible()) floatWindow.show()
    } else if (floatWindow && !floatWindow.isDestroyed()) {
      floatWindow.close()
      floatWindow = null
    }
    refreshTrayMenu()
  }
  saveSettings()
}

// 导出备份时剔除的设备相关易变键（换机迁移无意义）
const VOLATILE_KEYS = new Set(['bounds', 'maximized', 'floatBounds', 'floatSnapEdge', 'portableNudgeShown'])

// ---------------- IPC ----------------
// 只接受来自外壳页面（mainWindow.webContents）的调用，忽略 webview 等其他 sender
function guard(fn) {
  return (event, ...args) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return
    return fn(event, ...args)
  }
}

function registerIpc() {
  ipcMain.on('app:minimize', guard(() => mainWindow?.minimize()))
  ipcMain.handle('app:maximize-toggle', guard(() => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
  }))
  ipcMain.handle('app:is-maximized', guard(() => mainWindow?.isMaximized() ?? false))
  ipcMain.on('app:close', guard(() => mainWindow?.close()))
  ipcMain.handle('app:get-settings', guard(() => ({
    ...settings,
    version: app.getVersion(),
    appName: APP_NAME,
    defaultUrl: DEFAULT_URL,
    dark: nativeTheme.shouldUseDarkColors,
    loginItem: getLoginItemState(),
  })))
  ipcMain.handle('app:set-settings', guard((_e, patch) => {
    applySettingsPatch(patch)
    return settings
  }))
  // 设置导出：剔除设备相关易变键（窗口/悬浮鲸位置、自启状态等），另存为 JSON 备份
  ipcMain.handle('app:export-settings', guard(async () => {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '导出 JUNDSH 设置',
      defaultPath: 'jundsh-settings-backup.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (r.canceled || !r.filePath) return { ok: false }
    try {
      const clone = {}
      for (const [k, v] of Object.entries(settings)) {
        if (!VOLATILE_KEYS.has(k)) clone[k] = v
      }
      fs.writeFileSync(r.filePath, JSON.stringify(clone, null, 2))
      return { ok: true, path: r.filePath }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }))
  // 设置导入：读 JSON → Schema 白名单过滤 → 复用设置补丁路径（校验/联动完全一致）
  ipcMain.handle('app:import-settings', guard(async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '导入 JUNDSH 设置',
      filters: [{ name: 'JSON', extensions: ['json'] }, { name: '所有文件', extensions: ['*'] }],
      properties: ['openFile'],
    })
    if (r.canceled || !r.filePaths?.[0]) return { ok: false }
    try {
      const raw = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'))
      const patch = Schema.pickImportable(raw)
      const applied = Object.keys(patch)
      if (!applied.length) return { ok: false, error: '文件中没有可识别的 JUNDSH 设置' }
      applySettingsPatch(patch)
      return { ok: true, applied }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }))
  ipcMain.on('app:open-external', guard((_e, url) => {
    if (typeof url === 'string' && /^https?:/i.test(url)) shell.openExternal(url)
  }))
  // 未读数上报（外壳从 webview 标题解析）；正在看主窗时忽略非零值，聚焦即清零
  ipcMain.on('app:unread', guard((_e, n) => {
    const focused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()
    if (focused) applyUnread(0)
    else applyUnread(n)
  }))
  // 检查更新（命令面板 / 托盘共用逻辑）
  ipcMain.handle('app:check-update', guard(() => {
    if (!app.isPackaged) { mainWindow.webContents.send('app:toast', '开发模式不检查更新'); return { ok: false } }
    if (IS_PORTABLE) { mainWindow.webContents.send('app:toast', '便携版不支持自动更新，请下载安装版'); return { ok: false } }
    autoUpdater.checkForUpdates().catch((err) => console.error('[jundsh] 检查更新出错:', err && err.message))
    return { ok: true }
  }))
  ipcMain.on('app:gui-ready', guard(closeSplash))
  ipcMain.on('app:open-dev-tools', guard(() => mainWindow?.webContents.openDevTools({ mode: 'detach' })))
  // 打开 webview 内 DSH 页面的开发者工具（外壳内 F12 用 app:open-dev-tools）
  ipcMain.on('app:open-gui-dev-tools', guard(() => {
    const wc = webContents.getAllWebContents().find((w) => w.getType() === 'webview')
    if (wc) wc.openDevTools({ mode: 'detach' })
  }))
  ipcMain.on('app:reload', guard(() => mainWindow?.webContents.reload()))
  ipcMain.on('app:relaunch', guard(() => {
    quitting = true
    app.relaunch()
    app.exit(0)
  }))
  // ---- DSH 服务管理 ----
  ipcMain.handle('dsh:get-status', guard(() => requireDshSvc().getState()))
  // 显式启动（外部模式探测到已可达则 attached；托管模式下拉起服务）
  ipcMain.handle('dsh:start', guard(async () => requireDshSvc().startManaged()))
  // 停止托管服务（外部模式不作处理）
  ipcMain.handle('dsh:stop', guard(async () => {
    const svc = requireDshSvc()
    await svc.stopManaged()
    return svc.getState()
  }))
  // 重启托管服务
  ipcMain.handle('dsh:restart', guard(async () => {
    const svc = requireDshSvc()
    svc.applyConfig()
    return await svc.restart({ force: true })
  }))
  // ---- 环境诊断 ----
  ipcMain.handle('diag:collect', guard(async () => diag.collect(settings, {
    appVersion: app.getVersion(),
    appName: APP_NAME,
    targetUrl: settings.targetUrl,
    isPackaged: app.isPackaged,
  })))
  // ---- 内置终端（轻量：PowerShell 子进程 + IPC 双向串流，零原生依赖）----
  ipcMain.handle('term:open', guard(() => {
    killTermChild()
    const cwd = settings.termCwd && fs.existsSync(settings.termCwd) ? settings.termCwd : os.homedir()
    termChild = spawn('powershell.exe', ['-NoLogo', '-NoExit', '-Command', 'Set-Location -LiteralPath ' + JSON.stringify(cwd)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    termChild.stdout.on('data', (d) => mainWindow?.webContents.send('term:data', d.toString('utf8')))
    termChild.stderr.on('data', (d) => mainWindow?.webContents.send('term:data', d.toString('utf8')))
    termChild.once('exit', (code) => {
      mainWindow?.webContents.send('term:exit', code)
      termChild = null
    })
    return { ok: true, cwd }
  }))
  ipcMain.handle('term:input', guard((_e, line) => {
    if (!termChild || termChild.exitCode !== null) return { ok: false }
    // 兼容任意结尾：统一补 \n；特殊保留为一行
    const s = String(line == null ? '' : line).replace(/\r?\n/g, '')
    termChild.stdin.write(s + '\n')
    return { ok: true }
  }))
  ipcMain.handle('term:close', guard(() => { killTermChild(); return { ok: true } }))
  // ---- 桌面悬浮鲸鱼（独立 sender，仅接受悬浮窗自身 webContents） ----
  const fguard = (fn) => (event, ...args) => {
    if (!floatWindow || floatWindow.isDestroyed() || event.sender !== floatWindow.webContents) return
    return fn(event, ...args)
  }
  ipcMain.handle('float:get-status', fguard(() => requireDshSvc().getState()))
  ipcMain.on('float:toggle-main', fguard(() => showMainWindow()))
  ipcMain.on('float:open-settings', fguard(() => {
    showMainWindow()
    setTimeout(() => mainWindow?.webContents.send('app:command', 'open-settings'), 120)
  }))
  ipcMain.on('float:quit', fguard(() => {
    quitting = true
    app.quit()
  }))
  ipcMain.on('float:hide-self', fguard(() => {
    floatWindow?.hide()
  }))
  // 拖拽位置（悬浮窗手动拖动时，经 IPC 移动并持久化）；坐标 clamp 在所在显示器内
  ipcMain.handle('float:set-pos', fguard((_e, x, y) => {
    if (!floatWindow || floatWindow.isDestroyed()) return { ok: false }
    const px = Math.round(Number(x))
    const py = Math.round(Number(y))
    if (!Number.isFinite(px) || !Number.isFinite(py)) return { ok: false }
    const anchor = floatWindow.getPosition()
    const wa = screen.getDisplayNearestPoint({ x: anchor[0], y: anchor[1] }).workArea
    const c = (v, min, max) => Math.max(min, Math.min(max, v))
    const cx = c(px, wa.x - 64, wa.x + wa.width - 64)
    const cy = c(py, wa.y, wa.y + wa.height - 128)
    floatWindow.setPosition(cx, cy)
    settings.floatBounds = { x: cx, y: cy }
    saveSettings()
    return { ok: true }
  }))
  ipcMain.handle('float:get-pos', fguard(() => {
    if (!floatWindow || floatWindow.isDestroyed()) return null
    const [x, y] = floatWindow.getPosition()
    return { x, y }
  }))
  // 悬浮窗工作区（吸附计算用，以悬浮窗自身所在显示器为准；可选按渲染器给出的锚点查询）
  ipcMain.handle('float:get-workarea', fguard((_e, anchor) => {
    let pos = (floatWindow && !floatWindow.isDestroyed()) ? floatWindow.getPosition() : [0, 0]
    if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
      pos = [anchor.x, anchor.y]
    }
    const { workArea } = screen.getDisplayNearestPoint({ x: pos[0], y: pos[1] })
    return { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height }
  }))
  ipcMain.handle('float:get-theme', fguard(() => nativeTheme.shouldUseDarkColors))
  // 外观信息：主题明暗 + 皮肤名（供悬浮窗菜单跟随 skin accent 协调）
  ipcMain.handle('float:get-persona', fguard(() => ({
    dark: nativeTheme.shouldUseDarkColors,
    skin: settings.skin || 'abyss',
  })))
  // 皮肤变化时也通知悬浮窗
  ipcMain.handle('float:set-snap', fguard((_e, edge) => {
    settings.floatSnapEdge = ['left', 'right', 'top', 'bottom'].includes(edge) ? edge : null
    saveSettings()
    return { ok: true }
  }))
  ipcMain.handle('float:get-snap', fguard(() => settings.floatSnapEdge || null))
}

// 主题变化也通知悬浮窗（黑/白鲸鱼切换）
function pushFloatTheme(dark) {
  if (floatWindow && !floatWindow.isDestroyed()) floatWindow.webContents.send('float:theme', dark)
}

function killTermChild() {
  if (termChild && termChild.exitCode === null) {
    try { termChild.stdin.end() } catch { /* ignore */ }
    try { termChild.kill() } catch { /* ignore */ }
    // 强杀兜底
    const pid = termChild.pid
    if (pid) {
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
      } catch { /* ignore */ }
    }
  }
  termChild = null
}

// ---------------- 生命周期 ----------------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('com.jundsh.desktop')
    loadSettings()
    applyTheme()
    applyHotkeySetting()
    nativeTheme.on('updated', () => {
      const dark = nativeTheme.shouldUseDarkColors
      mainWindow?.webContents.send('theme:changed', { dark })
      pushFloatTheme(dark)
    })
    registerIpc()
    setupAutoUpdate()
    requireDshSvc() // 启动服务管理器（默认仅探测，不主动拉起）
    if (!DEBUG_SHOT) createTray()
    // 开机自启静默启动（--hidden）跳过启动页；调试截图模式保留
    if (!START_HIDDEN) createSplash()
    createMainWindow()
    // 桌面悬浮鲸鱼（调试截图模式下仅 float 模式创建以便验证；其余跳过避免干扰截图）
    if (!DEBUG_SHOT || process.env.DSH_DESKTOP_SHOT === 'float') createFloatWindow()
    maybePortableNudge()
  })

  app.on('window-all-closed', () => {
    if (quitting || process.platform !== 'darwin') app.quit()
  })

  // 退出前冲刷未落盘的设置（防抖可能还在等待）
  app.on('before-quit', () => {
    globalShortcut.unregisterAll()
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
      try {
        fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2))
      } catch (err) {
        console.error('[jundsh] 退出时保存设置失败:', err.message)
      }
    }
    // 停掉由本客户端托管的 DSH 子进程
    if (dshSvc) {
      dshSvc.stop().catch((err) => console.error('[jundsh] 停止 DSH 服务出错:', err && err.message))
    }
    killTermChild()
  })
}
