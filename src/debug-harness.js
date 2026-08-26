// JUNDSH · DSH 桌面端 — 调试/冒烟采集（环境变量 DSH_DESKTOP_SHOT 启用）
//   =1     截启动页 + 主窗截图与 DOM 探针后退出
//   =modal 主窗先打开设置面板再截图
//   =float 仅创建悬浮鲸鱼并截图探针
// 独立模块：只在调试路径 require，不进常规运行时。
'use strict'

const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

function shotDir() {
  const dir = path.join(app.getPath('userData'), 'screenshots')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function saveShot(win, name) {
  if (!win || win.isDestroyed()) return
  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.join(shotDir(), name), img.toPNG())
}

// 启动页截图（1.6s 时点）
function scheduleSplashShot(splashWindow) {
  setTimeout(async () => {
    try {
      await saveShot(splashWindow, 'splash.png')
    } catch (err) {
      console.error('[jundsh] 启动页截图失败:', err)
    }
  }, 1600)
}

// 主窗外壳 DOM 探针：页面状态 + 终端 E2E 冒烟（历史/回显）+ 皮肤切换冒烟
async function shellDomProbe(mainWindow) {
  return mainWindow.webContents.executeJavaScript(`(async () => {
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
            const dft = q('#seg-skin .seg-btn[data-skin="abyss"]');
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
            uiExtras: {
              findbar: !!q('#findbar'),
              findHidden: q('#findbar')?.classList.contains('hidden'),
              palette: !!q('#palette'),
              paletteListItems: document.querySelectorAll('#palette-list .palette-item').length,
              jUnread: typeof window.JUnread !== 'undefined' ? 'ok' : 'missing',
              titleNow: document.title,
            },
          };
        })()`)
}

// 主窗截图 + 探针（7s 时点，随后退出应用）
function scheduleShellProbe(mainWindow) {
  setTimeout(async () => {
    try {
      if (process.env.DSH_DESKTOP_SHOT === 'modal') {
        await mainWindow.webContents.executeJavaScript(`document.getElementById('btn-settings').click()`)
        await new Promise((r) => setTimeout(r, 400))
      }
      await saveShot(mainWindow, 'shell.png')
      const dom = await shellDomProbe(mainWindow)
      console.log('[jundsh:debug] DOM:', JSON.stringify(dom))
    } catch (err) {
      console.error('[jundsh] 截图失败:', err)
    }
    setTimeout(() => app.exit(0), 400)
  }, 7000)
}

// 悬浮鲸鱼窗口探针（1.2s 时点）：主题联动 / 菜单渲染 / 拖动模拟，随后退出应用
function scheduleFloatProbe(floatWindow) {
  console.log('[jundsh:debug] FLOAT mode: window created', !!floatWindow)
  setTimeout(async () => {
    try {
      await new Promise((r) => setTimeout(r, 600))
      console.log('[jundsh:debug] FLOAT visible?', !!(floatWindow && !floatWindow.isDestroyed() && floatWindow.isVisible()))
      if (floatWindow && !floatWindow.isDestroyed() && floatWindow.isVisible()) {
        await saveShot(floatWindow, 'float.png')
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
}

module.exports = { scheduleSplashShot, scheduleShellProbe, scheduleFloatProbe }
