// JUNDSH · DSH 桌面端 — 主进程
'use strict'

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, session, nativeImage, nativeTheme, screen, webContents, Notification } = require('electron')
const { autoUpdater } = require('electron-updater')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { DshService } = require('./dsh-svc')

const APP_NAME = 'JUNDSH'
const DEFAULT_URL = 'http://127.0.0.1:8080'
const DEBUG_SHOT = !!process.env.DSH_DESKTOP_SHOT // 调试：截图后退出
// 便携版（electron-builder portable target 解压运行）不支持自动更新
const IS_PORTABLE = process.env.PORTABLE_EXECUTABLE_DIR !== undefined

let mainWindow = null
let splashWindow = null
let tray = null
let quitting = false
let settings = null
let saveTimer = null // 设置防抖写入定时器
let dshSvc = null // DSH 服务管理器

const assetsDir = (...p) => path.join(__dirname, '..', 'assets', ...p)
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
  settings.targetUrl = typeof settings.targetUrl === 'string' && /^https?:\/\/\S+$/i.test(settings.targetUrl)
    ? settings.targetUrl
    : DEFAULT_URL
  settings.minimizeToTray = settings.minimizeToTray !== false
  settings.zoomFactor = Math.min(2, Math.max(0.5, Number(settings.zoomFactor) || 1))
  settings.theme = ['system', 'light', 'dark'].includes(settings.theme) ? settings.theme : 'system'
  settings.bounds = sanitizeBounds(settings.bounds)
  // DSH 服务管理配置（默认外部模式，完全向后兼容）
  settings.dsh = {
    mode: ['external', 'profile', 'source'].includes(settings.dsh?.mode) ? settings.dsh.mode : 'external',
    port: Math.min(65535, Math.max(1, parseInt(settings.dsh?.port, 10) || 8080)) || 8080,
    sourceRepo: typeof settings.dsh?.sourceRepo === 'string' && settings.dsh.sourceRepo
      ? settings.dsh.sourceRepo
      : path.join(os.homedir(), 'deepseek-harness'),
  }
  return settings
}

// DSH 服务管理器：把最新状态推给外壳
function pushDshStatus(state) {
  mainWindow?.webContents.send('dsh:status', state)
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
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#101113' : '#f4f5f7',
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
  })
  mainWindow.webContents.on('console-message', (event) => {
    if (event.level >= 2) console.log('[jundsh:shell]', event.message, `(${event.sourceId}:${event.lineNumber})`)
  })

  mainWindow.once('ready-to-show', () => {
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

  // 调试截图
  if (DEBUG_SHOT) {
    setTimeout(async () => {
      try {
        const dir = path.join(app.getPath('userData'), 'screenshots')
        fs.mkdirSync(dir, { recursive: true })
        if (splashWindow && !splashWindow.isDestroyed()) {
          fs.writeFileSync(path.join(dir, 'splash.png'), (await splashWindow.webContents.capturePage()).toPNG())
        }
      } catch (err) {
        console.error('[jundsh] 启动页截图失败:', err)
      }
    }, 1600)
    setTimeout(async () => {
      try {
        const dir = path.join(app.getPath('userData'), 'screenshots')
        fs.mkdirSync(dir, { recursive: true })
        if (process.env.DSH_DESKTOP_SHOT === 'modal') {
          await mainWindow.webContents.executeJavaScript(`document.getElementById('btn-settings').click()`)
          await new Promise((r) => setTimeout(r, 400))
        }
        const img = await mainWindow.webContents.capturePage()
        fs.writeFileSync(path.join(dir, 'shell.png'), img.toPNG())
        const dom = await mainWindow.webContents.executeJavaScript(`(() => {
          const q = (s) => document.querySelector(s);
          const imgs = [...document.querySelectorAll('img')].map((im) => ({ cls: im.className, w: im.naturalWidth, src: im.getAttribute('src') }));
          return {
            veilHidden: q('#veil')?.classList.contains('hidden'),
            offlineHidden: q('#offline')?.classList.contains('hidden'),
            pillClass: q('#status-pill')?.className,
            pillText: q('#status-text')?.textContent,
            pillInfo: q('#pill-info')?.textContent,
            dshStatusLine: q('#dsh-status-line')?.textContent,
            dshModeActive: q('#seg-dsh-mode .seg-btn.active')?.dataset.mode,
            bodyLight: document.body.classList.contains('light'),
            guiSrc: q('#gui')?.getAttribute('src'),
            imgs,
          };
        })()`)
        console.log('[jundsh:debug] DOM:', JSON.stringify(dom))
      } catch (err) {
        console.error('[jundsh] 截图失败:', err)
      }
      setTimeout(() => app.exit(0), 400)
    }, 7000)
  }
}

function showMainWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

// ---------------- 自动更新（基于 GitHub Releases） ----------------
function setupAutoUpdate() {
  if (!app.isPackaged) return // 开发模式跳过（无 app-update.yml）
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
  })
  autoUpdater.on('update-not-available', (info) => {
    console.log('[jundsh] 当前已是最新版本', info.version)
  })
  autoUpdater.on('download-progress', (p) => {
    console.log(`[jundsh] 下载更新 ${Math.round(p.percent)}%`)
  })
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[jundsh] 更新已下载:', info.version)
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

function createTray() {
  const icon = nativeImage.createFromPath(buildDir('tray.png'))
  tray = new Tray(icon)
  tray.setToolTip(`${APP_NAME} · DSH 桌面端`)
  const menu = Menu.buildFromTemplate([
    { label: '显示主界面', click: showMainWindow },
    { type: 'separator' },
    { label: '刷新页面', click: () => mainWindow?.webContents.send('app:command', 'reload') },
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
  tray.on('double-click', showMainWindow)
}

// ---------------- 窗口状态记忆 ----------------
function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  settings.maximized = mainWindow.isMaximized()
  if (!settings.maximized) settings.bounds = mainWindow.getBounds()
  saveSettings(true) // 退出路径立即落盘
}

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
    if (patch && typeof patch === 'object') {
      if (typeof patch.targetUrl === 'string') {
        const url = patch.targetUrl.trim()
        if (/^https?:\/\/\S+$/i.test(url)) settings.targetUrl = url
      }
      if (typeof patch.minimizeToTray === 'boolean') settings.minimizeToTray = patch.minimizeToTray
      if (typeof patch.zoomFactor === 'number') {
        settings.zoomFactor = Math.min(2, Math.max(0.5, patch.zoomFactor))
      }
      if (['system', 'light', 'dark'].includes(patch.theme)) {
        settings.theme = patch.theme
        applyTheme()
      }
      if (typeof patch.loginItem === 'boolean') {
        app.setLoginItemSettings({ openAtLogin: patch.loginItem })
        // 注意：不持久化 loginItem，读取时实时来自 getLoginItemSettings
      }
      if (patch.dsh && typeof patch.dsh === 'object') {
        const next = { ...settings.dsh }
        if (['external', 'profile', 'source'].includes(patch.dsh.mode)) {
          next.mode = patch.dsh.mode
          // 切换模式时同步端口默认值
          if (typeof patch.dsh.port === 'number') next.port = Math.min(65535, Math.max(1, patch.dsh.port))
        } else if (typeof patch.dsh.port === 'number') {
          next.port = Math.min(65535, Math.max(1, patch.dsh.port))
        }
        if (typeof patch.dsh.sourceRepo === 'string' && patch.dsh.sourceRepo) next.sourceRepo = patch.dsh.sourceRepo
        settings.dsh = next
        if (dshSvc) dshSvc.applyConfig()
      }
      saveSettings()
    }
    return settings
  }))
  ipcMain.on('app:open-external', guard((_e, url) => {
    if (typeof url === 'string' && /^https?:/i.test(url)) shell.openExternal(url)
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
    nativeTheme.on('updated', () => {
      mainWindow?.webContents.send('theme:changed', { dark: nativeTheme.shouldUseDarkColors })
    })
    registerIpc()
    setupAutoUpdate()
    requireDshSvc() // 启动服务管理器（默认仅探测，不主动拉起）
    if (!DEBUG_SHOT) createTray()
    createSplash()
    createMainWindow()
  })

  app.on('window-all-closed', () => {
    if (quitting || process.platform !== 'darwin') app.quit()
  })

  // 退出前冲刷未落盘的设置（防抖可能还在等待）
  app.on('before-quit', () => {
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
  })
}
