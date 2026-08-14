// JUNDSH 品牌宣传图生成器
// 用 Electron(Chromium) 渲染品牌图并截图，生成：
//   - assets/branding/jundsh-square-1080.png   朋友圈/社交分享（1080×1080）
//   - assets/branding/jundsh-social-1280x640.png GitHub social preview / README banner（1280×640）
//   - assets/branding/whale-logo-512.png       透明底白鲸 logo（512×512）
// 运行：node_modules\.bin\electron.cmd scripts/gen-branding.mjs
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'assets', 'branding')
fs.mkdirSync(outDir, { recursive: true })

const whaleSvg = fs.readFileSync(path.join(root, 'assets', 'whale.svg'), 'utf8')
const d = whaleSvg.match(/<path[^>]*\sd="([^"]+)"/)?.[1]
if (!d) throw new Error('无法从 whale.svg 提取路径')

// ---------- 通用片段 ----------
const FONT = `'Segoe UI Variable Display','Segoe UI','Microsoft YaHei UI','Microsoft YaHei',sans-serif`

const bubbles = () => `
  <i style="left:8%;bottom:-14px;width:14px;height:14px;animation-duration:6s;animation-delay:0s"></i>
  <i style="left:18%;bottom:-10px;width:7px;height:7px;animation-duration:7.5s;animation-delay:1.4s"></i>
  <i style="right:14%;bottom:-16px;width:10px;height:10px;animation-duration:6.8s;animation-delay:0.8s"></i>
  <i style="right:7%;bottom:-8px;width:5px;height:5px;animation-duration:8s;animation-delay:2.2s"></i>`

const whaleMark = (size) => `
  <div class="whale" style="width:${size}px;height:${size}px">
    <svg width="${size}" height="${size}" viewBox="0 0 50 50" fill="none"
         style="filter:drop-shadow(0 ${Math.round(size * 0.05)}px ${Math.round(size * 0.16)}px rgba(5,10,20,.55)) drop-shadow(0 0 ${Math.round(size * 0.22)}px rgba(90,120,255,.42))">
      <path d="${d}" fill="#ffffff"/>
    </svg>
  </div>`

const baseCss = `
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:100%; height:100%; overflow:hidden; }
  body {
    font-family:${FONT};
    background:
      radial-gradient(120% 95% at 50% -5%, rgba(77,107,254,.16) 0%, rgba(77,107,254,0) 55%),
      radial-gradient(110% 70% at 50% 118%, rgba(38,58,118,.30) 0%, rgba(38,58,118,0) 60%),
      linear-gradient(180deg, #111c30 0%, #0b0f17 100%);
    color:#eef2fb;
    user-select:none;
  }
  .grid {
    position:absolute; inset:0;
    background-image:
      linear-gradient(rgba(148,163,184,.045) 1px, transparent 1px),
      linear-gradient(90deg, rgba(148,163,184,.045) 1px, transparent 1px);
    background-size:44px 44px;
    mask-image:radial-gradient(120% 100% at 50% 40%, rgba(0,0,0,.9), transparent 78%);
  }
  .bubbles i {
    position:absolute; border-radius:50%;
    background:radial-gradient(circle at 35% 30%, rgba(255,255,255,.55), rgba(110,143,255,.14));
    opacity:0;
    animation:rise linear infinite;
  }
  @keyframes rise {
    0% { transform:translateY(0) scale(1); opacity:0; }
    10% { opacity:.55; }
    100% { transform:translateY(-340px) scale(1.3); opacity:0; }
  }
`

// ---------- 页面构造 ----------
function squarePage() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${baseCss}
  .wrap { position:relative; width:1080px; height:1080px; display:flex; flex-direction:column; align-items:center; overflow:hidden; }
  .bubbles { position:absolute; inset:0; }
  .halo {
    position:absolute; left:50%; top:41%; width:560px; height:300px;
    transform:translate(-50%,-50%);
    background:radial-gradient(50% 50% at 50% 50%, rgba(90,120,255,.20), rgba(90,120,255,0) 70%);
    filter:blur(6px);
  }
  .whale { position:relative; margin-top:220px; animation:floaty 4.5s ease-in-out infinite; }
  @keyframes floaty { 0%,100%{ transform:translateY(0) rotate(-1.5deg);} 50%{ transform:translateY(-12px) rotate(1.5deg);} }
  .title { margin-top:56px; font-size:104px; font-weight:700; letter-spacing:.28em; text-indent:.28em;
    text-shadow:0 4px 30px rgba(77,107,254,.45); }
  .sub { margin-top:20px; font-size:25px; letter-spacing:.55em; text-indent:.55em; color:#8b96b3; font-weight:600; }
  .divider { margin-top:34px; width:120px; height:2px; border-radius:2px;
    background:linear-gradient(90deg, transparent, rgba(110,143,255,.8), transparent); }
  .tag { margin-top:30px; font-size:20px; letter-spacing:.4em; text-indent:.4em; color:#5f6b85; font-weight:600; }
  .foot { position:absolute; bottom:44px; font-size:17px; letter-spacing:.18em; color:#3f4a63; font-weight:600; }
</style></head><body>
  <div class="wrap">
    <div class="grid"></div>
    <div class="bubbles">${bubbles()}</div>
    <div class="halo"></div>
    ${whaleMark(300)}
    <div class="title">JUNDSH</div>
    <div class="sub">DEEPSEEK HARNESS DESKTOP</div>
    <div class="divider"></div>
    <div class="tag">黑色鲸鱼 · 深蓝之海</div>
    <div class="foot">v1.0.0 · MIT · OPEN SOURCE</div>
  </div>
</body></html>`
}

function socialPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${baseCss}
  .wrap { position:relative; width:1280px; height:640px; display:flex; align-items:center; overflow:hidden; }
  .bubbles { position:absolute; inset:0; }
  .left { position:relative; flex:none; width:560px; display:flex; align-items:center; justify-content:center; }
  .whale { position:relative; animation:floaty 4.5s ease-in-out infinite; }
  @keyframes floaty { 0%,100%{ transform:translateY(0) rotate(-1.5deg);} 50%{ transform:translateY(-10px) rotate(1.5deg);} }
  .right { position:relative; flex:1; padding-right:72px; }
  .title { font-size:76px; font-weight:700; letter-spacing:.22em; text-shadow:0 4px 30px rgba(77,107,254,.45); }
  .sub { margin-top:14px; font-size:21px; letter-spacing:.42em; color:#8b96b3; font-weight:600; }
  .divider { margin-top:30px; width:120px; height:2px; border-radius:2px;
    background:linear-gradient(90deg, rgba(110,143,255,.85), transparent); }
  .feats { margin-top:30px; display:flex; flex-direction:column; gap:12px; }
  .feat { display:flex; align-items:center; gap:14px; font-size:19px; color:#aeb8d2; letter-spacing:.06em; font-weight:500; }
  .dot { width:8px; height:8px; border-radius:50%; background:linear-gradient(135deg,#6e8fff,#4d6bfe);
    box-shadow:0 0 12px rgba(77,107,254,.8); flex:none; }
  .foot { position:absolute; left:584px; bottom:34px; font-size:16px; letter-spacing:.22em; color:#3f4a63; font-weight:600; }
</style></head><body>
  <div class="wrap">
    <div class="grid"></div>
    <div class="bubbles">${bubbles()}</div>
    <div class="left">${whaleMark(250)}</div>
    <div class="right">
      <div class="title">JUNDSH</div>
      <div class="sub">DEEPSEEK HARNESS DESKTOP</div>
      <div class="divider"></div>
      <div class="feats">
        <div class="feat"><i class="dot"></i>无边框毛玻璃窗口 · 深色主题自适应</div>
        <div class="feat"><i class="dot"></i>鲸鱼唤醒启动页 · 离线休息页</div>
        <div class="feat"><i class="dot"></i>系统托盘 · 设置持久化 · 单实例</div>
      </div>
    </div>
    <div class="foot">v1.0.0 · MIT LICENSE · OPEN SOURCE</div>
  </div>
</body></html>`
}

function logoPage() {
  // 透明底白鲸（无背景），额外加柔和的蓝色外发光
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; }
  html,body { width:100%; height:100%; overflow:hidden; background:transparent; }
  body { display:grid; place-items:center; }
  svg { filter:drop-shadow(0 6px 24px rgba(5,10,20,.5)) drop-shadow(0 0 46px rgba(90,120,255,.5)); }
</style></head><body>
  <svg width="440" height="440" viewBox="0 0 50 50" fill="none">
    <path d="${d}" fill="#ffffff"/>
  </svg>
</body></html>`
}

// ---------- 渲染 ----------
// 注意：Windows 上 offscreen 窗口 destroy 后再新建，新窗口 loadFile 会
// ERR_FAILED(-2)。因此复用一个窗口，用 setContentSize 切换尺寸。
async function render(win, html, w, h, outFile) {
  win.setContentSize(w, h)
  await new Promise((r) => setTimeout(r, 300)) // 等尺寸生效
  const tmp = path.join(root, `.branding-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.html`)
  fs.writeFileSync(tmp, html, 'utf8')
  try {
    await win.loadFile(tmp)
    await new Promise((r) => setTimeout(r, 700)) // 等动画/字体就绪
    const img = await win.webContents.capturePage()
    const buf = img.toPNG()
    await sharp(buf).resize(w, h).png({ compressionLevel: 9 }).toFile(outFile)
    console.log('生成:', path.relative(root, outFile), '->', w + 'x' + h)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1080, height: 1080, show: false, frame: false,
    useContentSize: true, enableLargerThanScreen: true,
    transparent: true, // logo 页需要透明底（不透明页面不受影响）
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true },
  })
  try {
    await render(win, squarePage(), 1080, 1080, path.join(outDir, 'jundsh-square-1080.png'))
    await render(win, socialPage(), 1280, 640, path.join(outDir, 'jundsh-social-1280x640.png'))
    // logo：透明底，只截鲸鱼区域
    await render(win, logoPage(), 512, 512, path.join(outDir, 'whale-logo-512.png'))
  } catch (err) {
    console.error('生成失败:', err)
    process.exitCode = 1
  } finally {
    win.destroy()
    app.exit(process.exitCode || 0)
  }
})
