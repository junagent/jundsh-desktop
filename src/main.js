// JUNDSH · DSH 桌面端 — 主进程
'use strict'

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, session, nativeImage, nativeTheme, screen, webContents, Notification } = require('electron')
const { autoUpdater } = require('electron-updater')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { DshService } = require('./dsh-svc')
const diag = require('./diag')

const APP_NAME = 'JUNDSH'
const DEFAULT_URL = 'http://127.0.0.1:8080'
const DEBUG_SHOT = !!process.env.DSH_DESKTOP_SHOT // 调试：截图后退出
// 便携版（electron-builder portable target 解压运行）不支持自动更新
const IS_PORTABLE = process.env.PORTABLE_EXECUTABLE_DIR !== undefined

let mainWindow = null
let splashWindow = null
let floatWindow = null // 桌面悬浮鲸鱼
let tray = null
let quitting = false
let settings = null
let saveTimer = null // 设置防抖写入定时器
let dshSvc = null // DSH 服务管理器
let termChild = null // 内置终端子进程

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
  settings.skin = ['default', 'violet', 'emerald', 'amber'].includes(settings.skin) ? settings.skin : 'default'
  settings.bounds = sanitizeBounds(settings.bounds)
  // DSH 服务管理配置（默认外部模式，完全向后兼容）
  settings.dsh = {
    mode: ['external', 'profile', 'source'].includes(settings.dsh?.mode) ? settings.dsh.mode : 'external',
    port: Math.min(65535, Math.max(1, parseInt(settings.dsh?.port, 10) || 8080)) || 8080,
    sourceRepo: typeof settings.dsh?.sourceRepo === 'string' && settings.dsh.sourceRepo
      ? settings.dsh.sourceRepo
      : path.join(os.homedir(), 'deepseek-harness'),
  }
  // 桌面悬浮鲸鱼（默认开启）
  settings.floatEnabled = settings.floatEnabled !== false
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

// DSH 服务管理器：把最新状态推给外壳与悬浮窗
function pushDshStatus(state) {
  mainWindow?.webContents.send('dsh:status', state)
  if (floatWindow && !floatWindow.isDestroyed()) floatWindow.webContents.send('dsh:status', state)
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
        const dom = await mainWindow.webContents.executeJavaScript(`(async () => {
          const q = (s) => document.querySelector(s);
          const imgs = [...document.querySelectorAll('img')].map((im) => ({ cls: im.className, w: im.naturalWidth, src: im.getAttribute('src') }));
          let diagSummary = null;
          try {
            const dr = await window.desktop.getDiag();
            diagSummary = { issues: dr.issues, head: dr.report.split('\\n').slice(0, 4) };
          } catch (e) { diagSummary = { err: String(e) }; }
          // 终端 + 皮肤冒烟（走真实 UI）
          let termSummary = null;
          let skinSummary = null;
          try {
            const before = { hidden: q('#term').classList.contains('hidden'), status: q('#term-status')?.textContent };
            q('#btn-term').click();
            await new Promise((r) => setTimeout(r, 300));
            const mid = { hidden: q('#term').classList.contains('hidden'), status: q('#term-status')?.textContent };
            await new Promise((r) => setTimeout(r, 1500));
            const shown = q('#term') && !q('#term').classList.contains('hidden');
            const status = q('#term-status')?.textContent;
            const input = q('#term-in');
            let histRes = null;
            if (input) {
              input.value = 'Write-Output JUNDSH_TERM_E2E';
              input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
              // 命令历史：Enter 后按 ↑ 应恢复上一条命令
              await new Promise((r) => setTimeout(r, 120));
              input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
              await new Promise((r) => setTimeout(r, 120));
              histRes = input.value;
            }
            await new Promise((r) => setTimeout(r, 1500));
            const outTail = (q('#term-out')?.textContent || '').slice(-300);
            const finalStatus = q('#term-status')?.textContent;
            q('#btn-term-close').click();
            termSummary = { before, mid, shown, status, finalStatus, echoed: outTail.includes('JUNDSH_TERM_E2E'), hist: histRes };
            // 皮肤冒烟：切到极光紫，验证 body.skin-violet 生效，然后还原默认
            const skinBtn = q('#seg-skin .seg-btn[data-skin="violet"]');
            skinBtn?.click();
            await new Promise((r) => setTimeout(r, 120));
            skinSummary = {
              hasClass: document.body.classList.contains('skin-violet'),
              active: q('#seg-skin .seg-btn.active')?.dataset.skin,
            };
            const dft = q('#seg-skin .seg-btn[data-skin="default"]');
            dft?.click();
          } catch (e) {
            termSummary = termSummary || { err: String(e), stack: String(e && e.stack).slice(0, 300) };
            skinSummary = skinSummary || { err: String(e) };
          }
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
            diagSummary,
            termSummary,
            skinSummary,
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
  if (process.env.DSH_DESKTOP_SHOT === 'float') {
    console.log('[jundsh:debug] FLOAT mode: window created', !!floatWindow)
    setTimeout(async () => {
      try {
        const dir = path.join(app.getPath('userData'), 'screenshots')
        fs.mkdirSync(dir, { recursive: true })
        await new Promise((r) => setTimeout(r, 600))
        console.log('[jundsh:debug] FLOAT visible?', !!(floatWindow && !floatWindow.isDestroyed() && floatWindow.isVisible()))
        if (floatWindow && !floatWindow.isDestroyed() && floatWindow.isVisible()) {
          const img = await floatWindow.webContents.capturePage()
          fs.writeFileSync(path.join(dir, 'float.png'), img.toPNG())
          const dom = await floatWindow.webContents.executeJavaScript(`(async () => {
            const whaleEl = document.getElementById('whale');
            const shellEl = document.getElementById('whale-shell');
            const base = {
              whaleSrc: whaleEl ? whaleEl.getAttribute('src') : null,
              cursor: shellEl ? getComputedStyle(shellEl).cursor : null,
              menuItems: document.querySelectorAll('#menu-inner .mi').length,
              floaty: whaleEl ? getComputedStyle(whaleEl).animationName : null,
              snapped: document.documentElement.classList.contains('snapped'),
            };
            let snapMem = null;
            try { snapMem = await window.float.getSnap(); } catch (e) { snapMem = 'err:' + e; }
            let wa2 = null;
            try { wa2 = await window.float.getWorkArea(); } catch (e) { wa2 = 'err:' + e; }
            base.snapMem = snapMem;
            base.workArea = wa2 && wa2.width ? wa2.width + 'x' + wa2.height : wa2;
            // 主题：切到系统 dark 场景无法合成，这里验证内置 applyTheme 分支可用
            let theme = null;
            try { theme = await window.float.getTheme(); } catch (e) { theme = 'err:' + e; }
            // 拖动模拟：mousedown -> mousemove(>阈值) -> mouseup，应触发 setPos 无异常
            let dragRes = 'not-run';
            try {
              const s = shellEl;
              const w = window;
              s.dispatchEvent(new MouseEvent('mousedown', { button: 0, screenX: 10, screenY: 10, bubbles: true }));
              w.dispatchEvent(new MouseEvent('mousemove', { screenX: 80, screenY: 40, bubbles: true }));
              w.dispatchEvent(new MouseEvent('mouseup', { screenX: 80, screenY: 40, bubbles: true }));
              dragRes = 'ok';
            } catch (e) { dragRes = 'err:' + e; }
            return Object.assign({ theme, dragRes }, base);
          })()`)
          console.log('[jundsh:debug] FLOAT DOM:', JSON.stringify(dom))
        } else {
          console.log('[jundsh:debug] FLOAT DOM: not visible/created')
        }
      } catch (err) {
        console.error('[jundsh] 悬浮窗截图失败:', err && err.message)
      }
      console.log('[jundsh:debug] FLOAT exit')
      setTimeout(() => app.exit(0), 300)
    }, 1200)
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
  refreshTrayMenu()
  tray.on('double-click', showMainWindow)
}

// 重建托盘菜单（悬浮开关状态变化后刷新，保证托盘与设置/悬浮窗一致）
function refreshTrayMenu() {
  if (!tray) return
  const menu = Menu.buildFromTemplate([
    { label: '显示主界面', click: showMainWindow },
    { type: 'separator' },
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
      if (['default', 'violet', 'emerald', 'amber'].includes(patch.skin)) {
        settings.skin = patch.skin
        if (floatWindow && !floatWindow.isDestroyed()) {
          floatWindow.webContents.send('float:persona', { dark: nativeTheme.shouldUseDarkColors, skin: settings.skin })
        }
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
  // ---- 环境诊断 ----
  ipcMain.handle('diag:collect', guard(() => diag.collect(settings, {
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
  // 悬浮窗工作区（吸附计算用，以悬浮窗自身所在显示器为准）
  ipcMain.handle('float:get-workarea', fguard(() => {
    const anchor = (floatWindow && !floatWindow.isDestroyed()) ? floatWindow.getPosition() : [0, 0]
    const { workArea } = screen.getDisplayNearestPoint({ x: anchor[0], y: anchor[1] })
    return { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height }
  }))
  ipcMain.handle('float:get-theme', fguard(() => nativeTheme.shouldUseDarkColors))
  // 外观信息：主题明暗 + 皮肤名（供悬浮窗菜单跟随 skin accent 协调）
  ipcMain.handle('float:get-persona', fguard(() => ({
    dark: nativeTheme.shouldUseDarkColors,
    skin: settings.skin || 'default',
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
    nativeTheme.on('updated', () => {
      const dark = nativeTheme.shouldUseDarkColors
      mainWindow?.webContents.send('theme:changed', { dark })
      pushFloatTheme(dark)
    })
    registerIpc()
    setupAutoUpdate()
    requireDshSvc() // 启动服务管理器（默认仅探测，不主动拉起）
    if (!DEBUG_SHOT) createTray()
    createSplash()
    createMainWindow()
    // 桌面悬浮鲸鱼（调试截图模式下仅 float 模式创建以便验证；其余跳过避免干扰截图）
    if (!DEBUG_SHOT || process.env.DSH_DESKTOP_SHOT === 'float') createFloatWindow()
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
    killTermChild()
  })
}
