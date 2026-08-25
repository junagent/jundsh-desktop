// JUNDSH · 环境诊断
// 采集本机运行环境与 DSH 相关路径的状态，帮助快速定位常见问题。
// 纯只读采集，无副作用；结果可经 IPC 提供给外壳展示/复制。
'use strict'

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')

function fileInfo(p) {
  try {
    const st = fs.statSync(p)
    return { exists: true, ok: '存在', kind: st.isDirectory() ? '目录' : '文件' }
  } catch {
    return { exists: false, ok: '缺失', kind: '-' }
  }
}

// 尽力读取某路径下的 dsh 包版本
function dshVersionFrom(pkgDir) {
  try {
    const pj = path.join(pkgDir, 'package.json')
    if (fs.existsSync(pj)) {
      const v = JSON.parse(fs.readFileSync(pj, 'utf8')).version
      return typeof v === 'string' ? v : null
    }
  } catch { /* ignore */ }
  return null
}

function runVersion(cmd, args) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, windowsHide: true })
    return String(out).trim().split(/\r?\n/)[0] || null
  } catch {
    return null
  }
}

// 探测端口监听状态：true=在监听 / false=未监听 / null=未知
function portListenState(port) {
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count`,
    ], { encoding: 'utf8', timeout: 4000, windowsHide: true })
    return parseInt(String(out).trim(), 10) > 0
  } catch {
    return null // 未知
  }
}

// HTTP 探测目标是否为 DSH 服务（抓首页前 2KB，匹配官方 Web UI 签名）
// DSH 首页特征：__ModuleLoader__ / @deepseek-ai/dsh-client-modules
const DSH_SIGNATURES = ['__ModuleLoader__', 'dsh-client-modules', 'deepseek-harness']
function httpBearsDshSignature(url) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(url) } catch { return resolve(false) }
    const http = require('node:http')
    const req = http.get({
      hostname: u.hostname, port: u.port,
      path: u.pathname && u.pathname !== '/' ? u.pathname : '/', timeout: 2500,
      headers: { Connection: 'close' },
    }, (res) => {
      let buf = ''
      res.on('data', (d) => {
        buf += d
        if (buf.length > 2048) { req.destroy() }
      })
      res.on('end', () => {
        const hit = DSH_SIGNATURES.some((s) => buf.includes(s))
        resolve(hit)
      })
      res.on('error', () => resolve(false))
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

// 端口占用智能判定（异步）：'dsh'（DSH 正常服务） / 'occupied'（被非 DSH 程序占用） / 'free'（未监听） / 'unknown'
async function portDiagnosis(url, port) {
  const listen = portListenState(port)
  if (listen === null) return 'unknown'
  if (!listen) return 'free'
  return (await httpBearsDshSignature(url)) ? 'dsh' : 'occupied'
}

// 采集诊断报告（异步）。settings: 主进程设置对象；opts: { appVersion, appName, targetUrl }
// 性能：同一次采集内复用探测结果，避免重复启动子进程
// 崩溃转储（本地）：存在历史 dump 说明发生过渲染/主进程崩溃；路径供用户反馈问题用
function crashDumpsInfo() {
  try {
    const dir = require('electron').app.getPath('crashDumps')
    let count = 0
    try {
      count = fs.readdirSync(dir).filter((f) => f.endsWith('.dmp')).length
    } catch { /* 目录尚未创建 = 无崩溃记录 */ }
    return count ? `${dir}（${count} 个）` : `${dir}（无记录）`
  } catch {
    return '不可用'
  }
}

async function collect(settings, opts = {}) {
  const home = os.homedir()
  const profileRoot = path.join(home, '.dsh', 'profiles')
  const profileBin = path.join(profileRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const profilePkgDir = path.join(profileRoot, 'node_modules', '@deepseek-ai', 'dsh')
  const sourceRepo = settings?.dsh?.sourceRepo || path.join(home, 'deepseek-harness')
  const sourceCli = path.join(sourceRepo, 'apps', 'cli', 'src', 'bin.ts')
  const sourceTsx = path.join(sourceRepo, 'node_modules', 'tsx')
  const dshCfg = {
    mode: settings?.dsh?.mode || 'external',
    port: settings?.dsh?.port || 8080,
  }

  const profileBinInfo = fileInfo(profileBin)
  const sourceCliInfo = fileInfo(sourceCli)

  // 一次性探测（同一次采集内结果复用，避免重复启动 powershell/子进程）
  const nodeVer = runVersion(process.execPath, ['--version']) || '获取失败'
  const electronVer = (process.versions && process.versions.electron) || null
  const targetUrl = opts.targetUrl || `http://127.0.0.1:${dshCfg.port}`
  const portDx = await portDiagnosis(targetUrl, dshCfg.port) // 'dsh' | 'occupied' | 'free' | 'unknown'

  // 关键探测结论
  const issues = []
  if (!profileBinInfo.exists) issues.push('已安装 DSH Profile 缺失（托管·Profile 模式不可用）')
  if (!sourceCliInfo.exists) issues.push('DSH 源码目录/入口不存在（托管·源码模式不可用）')
  if (!sourceTsx) issues.push('源码目录缺少 tsx 运行时（托管·源码模式启动会失败）')
  if (dshCfg.mode === 'external') {
    if (portDx === 'free') issues.push(`外部模式：端口 ${dshCfg.port} 未监听，请先运行 start-dsh-web.ps1 启动服务`)
    if (portDx === 'occupied') issues.push(`端口 ${dshCfg.port} 已被其他程序占用（但响应不像是 DSH），请检查占用或改端口`)
    if (portDx === 'unknown') issues.push('端口状态无法探测（powershell 未可用）')
  } else if (portDx === 'occupied') {
    issues.push(`端口 ${dshCfg.port} 已被其他程序占用，托管服务无法在此端口启动，请更换端口`)
  }

  const profileVersion = dshVersionFrom(profilePkgDir)

  const rows = [
    ['采集时间', new Date().toISOString().replace('T', ' ').slice(0, 19)],
    ['应用', `${opts.appName || 'JUNDSH'} v${opts.appVersion || '?'}`],
    ['操作系统', `${os.platform()} ${os.release()} (${os.arch()})`],
    ['Node.js', nodeVer],
    ['Electron', electronVer || '内置'],
    ['打包形态', opts.isPackaged ? '已安装/打包' : '开发模式'],
    ['崩溃转储', crashDumpsInfo()],
    ['用户目录', home],
    ['DSH Profile 目录', profileRoot + (profileBinInfo.exists ? ' ✓' : ' ✗')],
    ['  → DSH Profile 版本', profileVersion || '未检测到'],
    ['  → dsh bin.js', profileBin + (profileBinInfo.exists ? ' ✓' : ' ✗')],
    ['DSH 源码目录', path.resolve(sourceRepo)],
    ['  → 入口 bin.ts', sourceCli + (sourceCliInfo.exists ? ' ✓' : ' ✗')],
    ['  → tsx 运行时', sourceTsx ? '存在' : '缺失'],
    ['服务管理模式', dshCfg.mode],
    ['服务端口', dshCfg.port],
    ['端口诊断', portDx === 'dsh' ? 'DSH 正常服务' : portDx === 'occupied' ? '被其他程序占用' : portDx === 'free' ? '未监听' : '未知'],
    ['目标地址', targetUrl],
  ]

  const line = (k, v) => `${k.padEnd(22)} : ${v}`
  let report = 'JUNDSH 环境诊断报告\n=====================\n'
  for (const [k, v] of rows) report += line(k, v) + '\n'
  report += '\n发现问题：' + (issues.length ? '' : '无')
  for (const i of issues) report += `\n  ! ${i}`

  return { report, rows, issues }
}

module.exports = { collect }
