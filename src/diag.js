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

// 探测端口是否被监听
function portInUse(port) {
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

// 采集诊断报告。settings: 主进程设置对象；opts: { appVersion, appName, targetUrl }
function collect(settings, opts = {}) {
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

  // 关键探测结论
  const issues = []
  if (!profileBinInfo.exists) issues.push('已安装 DSH Profile 缺失（托管·Profile 模式不可用）')
  if (!sourceCliInfo.exists) issues.push('DSH 源码目录/入口不存在（托管·源码模式不可用）')
  if (!sourceTsx) issues.push('源码目录缺少 tsx 运行时（托管·源码模式启动会失败）')
  if (dshCfg.mode === 'external' && portInUse(dshCfg.port) !== true) issues.push(`外部模式：端口 ${dshCfg.port} 未被监听，请先运行 start-dsh-web.ps1`)

  const profileVersion = dshVersionFrom(profilePkgDir)

  const rows = [
    ['采集时间', new Date().toISOString().replace('T', ' ').slice(0, 19)],
    ['应用', `${opts.appName || 'JUNDSH'} v${opts.appVersion || '?'}`],
    ['操作系统', `${os.platform()} ${os.release()} (${os.arch()})`],
    ['Node.js', runVersion(process.execPath, ['--version']) || '获取失败'],
    ['Electron', process.versions && process.versions.electron || runVersion(process.execPath, ['-p', 'process.versions.electron']) || '?'],
    ['打包形态', opts.isPackaged ? '已安装/打包' : '开发模式'],
    ['用户目录', home],
    ['DSH Profile 目录', profileRoot + (profileBinInfo.exists ? ' ✓' : ' ✗')],
    ['  → DSH Profile 版本', profileVersion || '未检测到'],
    ['  → dsh bin.js', profileBin + (profileBinInfo.exists ? ' ✓' : ' ✗')],
    ['DSH 源码目录', path.resolve(sourceRepo)],
    ['  → 入口 bin.ts', sourceCli + (sourceCliInfo.exists ? ' ✓' : ' ✗')],
    ['  → tsx 运行时', sourceTsx ? '存在' : '缺失'],
    ['服务管理模式', dshCfg.mode],
    ['服务端口', dshCfg.port],
    ['端口监听状态', portInUse(dshCfg.port) === true ? '在线' : portInUse(dshCfg.port) === false ? '未监听' : '未知'],
    ['目标地址', opts.targetUrl || '?'],
  ]

  const line = (k, v) => `${k.padEnd(22)} : ${v}`
  let report = 'JUNDSH 环境诊断报告\n=====================\n'
  for (const [k, v] of rows) report += line(k, v) + '\n'
  report += '\n发现问题：' + (issues.length ? '' : '无')
  for (const i of issues) report += `\n  ! ${i}`

  return { report, rows, issues }
}

module.exports = { collect }
