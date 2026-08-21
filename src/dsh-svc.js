// JUNDSH · DSH 服务管理器
// 多模式启动 + 健康检查(SOCKS-like HTTP 探测) + 看门狗自动重启 + 状态推送。
//
// 三个模式：
//   external — 服务由外部运行（start-dsh-web.ps1 等），客户端只负责探测（默认，向后兼容）
//   profile  — 拉起已安装的 DSH Profile（%USERPROFILE%\.dsh\profiles\...\@deepseek-ai\dsh\lib\bin.js web --port N）
//   source   — 从源码仓库拉起（node --import tsx/esm apps/cli/src/bin.ts web --port N）
//
// 状态对象（只含原始值，可安全 JSON 传输）：
//   { mode, port, alive, pid, uptimeSec, managed, restartCount, lastError, probingAt }
'use strict'

const { spawn } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const os = require('node:os')

const MODES = ['external', 'profile', 'source']
const PROBE_INTERVAL = 5000 // 健康检查间隔
const FAIL_THRESHOLD = 2 // 连续失败 N 次才判定"服务不可用"
const MAX_RESTARTS = 5 // 单轮看门狗最大重启次数
const RESTART_BASE_DELAY = 2000 // 重启退避基数(ms)，每次翻倍

// 阻塞式 HTTP 探测：任意 <500 状态码都视为服务在响应；超时/连不上视为失败
function httpOk(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(url) } catch { return resolve(false) }
    const req = http.get(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname && u.pathname !== '/' ? u.pathname : '/',
        timeout: timeoutMs,
        headers: { Connection: 'close' },
      },
      (res) => {
        res.resume()
        resolve(res.statusCode < 500)
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

// 探测一个 URL 的监听 PID：专用于判断"进程在但端口没通"的场景
function listenerPid(port) {
  try {
    const { execFileSync } = require('node:child_process')
    const out = execFileSync('powershell', [
      '-NoProfile', '-Command',
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
    ], { encoding: 'utf8', timeout: 4000, windowsHide: true })
    const n = parseInt(String(out).trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

class DshService {
  constructor({ getSettings, send, log }) {
    this.getSettings = getSettings
    this.send = send // (state) => void，向主进程汇报最新状态
    this.log = log || ((...a) => console.log('[dsh-svc]', ...a))
    this.child = null
    this.probeTimer = null
    this.restartTimer = null
    this.consecutiveFails = 0
    this.restartCount = 0
    this.lockedRestart = false // 重启进行中，避免重入
    this.startedAt = null // 本次子进程启动时间
    this.state = {
      mode: 'external',
      port: 8080,
      alive: false,
      pid: null,
      uptimeSec: 0,
      managed: false,
      restartCount: 0,
      lastError: null,
      probingAt: null,
    }
  }

  // ---------- 对外 ----------
  // 启动服务管理（底层健康检查循环）。只探测，不强制拉起（拉起只发生在 start/restart 显式调用时）
  start() {
    this.applyConfig()
    this.stopProbe()
    this.probe() // 立即探测一次
    this.probeTimer = setInterval(() => this.probe(), PROBE_INTERVAL)
    this.log('manager started:', JSON.stringify({ mode: this.state.mode, port: this.state.port }))
  }

  // 停止一切（退出、关管理时调用）
  async stop() {
    this.stopProbe()
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    await this.killChild()
  }

  // 应用配置（设置变化后调用）
  applyConfig() {
    const s = this.getSettings()
    const cfg = s.dsh || {}
    const mode = MODES.includes(cfg.mode) ? cfg.mode : 'external'
    const port = Math.min(65535, Math.max(1, parseInt(cfg.port, 10) || 8080))
    const changed = mode !== this.state.mode || port !== this.state.port
    this.state.mode = mode
    this.state.port = port
    if (changed) {
      // 模式/端口变了：若正托管着一个旧 services，需要重启到新配置
      this.restartCount = 0
      this.consecutiveFails = 0
    }
  }

  getState() {
    if (this.state.alive && this.startedAt) {
      this.state.uptimeSec = Math.round((Date.now() - this.startedAt) / 1000)
    }
    return { ...this.state }
  }

  // 显式启动托管服务（外部/托管模式通用：先探测，不通则拉起）
  async startManaged() {
    this.applyConfig()
    const cfg = this.getSettings().dsh || {}
    this.state.managed = true
    this.state.lastError = null
    const url = this.targetUrl()
    if (await httpOk(url)) {
      this.heal({ alive: true })
      this.log('service already reachable, attached mode')
      return { ok: true, attached: true, state: this.getState() }
    }
    if (this.state.mode === 'external') {
      this.state.managed = false
      this.state.lastError = '外部模式不主动启动服务（请先运行 start-dsh-web.ps1 或改用 托管模式）'
      this.send(this.getState())
      return { ok: false, state: this.getState() }
    }
    await this.restart({ force: true })
    return { ok: this.state.alive, state: this.getState() }
  }

  // 停止托管服务
  async stopManaged() {
    await this.killChild()
    this.state.managed = false
    this.state.lastError = null
    this.consecutiveFails = 0
    this.restartCount = 0
    this.publish()
  }

  // 看门狗重启（可被 IPC 触发）
  async restart({ force = false } = {}) {
    if (this.lockedRestart) return { ok: this.state.alive, state: this.getState() }
    this.lockedRestart = true
    try {
      await this.killChild()
      this.state.lastError = null
      if (this.state.mode === 'external') {
        const ok = await httpOk(this.targetUrl())
        this.heal({ alive: ok })
        return { ok, state: this.getState() }
      }
      const ok = await this.launchChild()
      return { ok, state: this.getState() }
    } finally {
      this.lockedRestart = false
    }
  }

  // 探测用的目标地址：托管模式用自身端口，否则用 targetUrl（兼容旧设置）
  targetUrl() {
    const s = this.getSettings()
    const managed = this.state.mode !== 'external'
    if (managed) return `http://127.0.0.1:${this.state.port}`
    // external：沿用用户填写的 targetUrl（旧行为完全不变）
    return /^https?:\/\//i.test(s.targetUrl || '') ? s.targetUrl : `http://127.0.0.1:${this.state.port}`
  }

  // ---------- 内部 ----------
  probe() {
    const url = this.targetUrl()
    this.state.probingAt = new Date().toISOString()
    httpOk(url).then((ok) => {
      // 状态更新前重新读取配置，避免探测结果回到旧配置上
      this.applyConfig()
      this.heal({ alive: ok })
      if (!ok && this.state.mode !== 'external' && this.state.managed) {
        this.onUnhealthy()
      }
    })
  }

  heal(patch) {
    const prev = this.state
    this.state = { ...prev, ...patch }
    if (patch.alive !== prev.alive) {
      this.log('alive ->', patch.alive)
      if (patch.alive) {
        // 恢复在线
        this.consecutiveFails = 0
        this.restartCount = 0
        this.state.lastError = null
        if (!this.startedAt) this.startedAt = Date.now()
      }
      this.publish()
    } else if (this.state.alive && this.state.uptimeSec !== prev.uptimeSec) {
      this.publish()
    }
  }

  onUnhealthy() {
    this.consecutiveFails += 1
    if (this.state.alive) {
      // 已有并发探测恢复在线，停止计次
      this.consecutiveFails = 0
      return
    }
    if (this.consecutiveFails >= FAIL_THRESHOLD) {
      this.state.lastError = `连续 ${this.consecutiveFails} 次探测失败`
      this.send(this.getState())
      this.scheduleWatchdog()
    }
  }

  // 看门狗：串行化的一次重启 + 失败后按退避继续，直到成功或达到上限
  scheduleWatchdog() {
    if (this.restartTimer || this.lockedRestart) return // 已有计划或正在重启
    if (this.state.alive) return // 已恢复
    if (this.restartCount >= MAX_RESTARTS) {
      this.state.lastError = `看门狗已重试 ${MAX_RESTARTS} 次仍失败，请检查 DSH 配置`
      this.send(this.getState())
      return
    }
    const delay = Math.min(RESTART_BASE_DELAY * Math.pow(2, this.restartCount), 30000)
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null
      this.restartCount += 1
      this.log(`watchdog restart #${this.restartCount}`)
      await this.restart({ force: true })
      // 重启后仍未恢复则继续下一轮（退避）
      if (!this.state.alive && this.state.mode !== 'external') {
        this.scheduleWatchdog()
      }
    }, delay)
  }

  async killChild() {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      const p = this.child
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 1500)
        p.once('exit', () => { clearTimeout(t); resolve() })
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }).once('exit', resolve)
          } else {
            p.kill('SIGTERM')
            setTimeout(() => { try { p.kill('SIGKILL') } catch {} }, 800).unref()
          }
        } catch {
          clearTimeout(t); resolve()
        }
      })
      this.child = null
    }
    this.state.pid = null
  }

  buildCommand() {
    const cfg = this.getSettings().dsh || {}
    const port = this.state.port
    if (this.state.mode === 'profile') {
      const profileRoot = path.join(os.homedir(), '.dsh', 'profiles')
      const bin = path.join(profileRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      return {
        cmd: process.execPath,
        args: [bin, 'web', '--port', String(port), '--no-open'],
        cwd: profileRoot,
      }
    }
    if (this.state.mode === 'source') {
      const repo = cfg.sourceRepo || ''
      return {
        cmd: process.execPath,
        args: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--port', String(port), '--no-open'],
        cwd: repo,
      }
    }
    // 其余一律视为 external（不应走到这里）
    return null
  }

  async launchChild() {
    const cmd = this.buildCommand()
    if (!cmd || !cmd.cwd) {
      this.state.lastError = '没有可用的启动模式配置'
      this.send(this.getState())
      return
    }
    if (!require('node:fs').existsSync(cmd.cwd)) {
      this.state.lastError = `目录不存在: ${cmd.cwd}`
      this.send(this.getState())
      return
    }
    this.log('launching', cmd.cmd, ...cmd.args, 'cwd:', cmd.cwd)
    try {
      this.child = spawn(cmd.cmd, cmd.args, {
        cwd: cmd.cwd,
        windowsHide: true,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.startedAt = Date.now()
      this.state.pid = this.child.pid
      this.state.managed = true
      let outBuf = ''
      const pump = (buf) => {
        outBuf = (outBuf + buf.toString()).slice(-1200)
      }
      this.child.stdout.on('data', pump)
      this.child.stderr.on('data', pump)
      this.child.once('exit', (code, sig) => {
        this.log('child exited', code, sig)
        this.child = null
        this.state.pid = null
        this.startedAt = null
        const marker = /http:\/\/[^\s]+|listening/i.exec(outBuf)
        if (code && !this.state.alive && marker) {
          this.state.lastError = `DSH 启动后立即退出(code=${code})：${String(marker[0]).slice(0, 80)}`
          this.send(this.getState())
        }
      })
    } catch (err) {
      this.state.lastError = `启动失败: ${err.message}`
      this.child = null
    }
    this.send(this.getState())
    // 等待服务就绪（最多 30s），并把结果返回给调用方
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (await httpOk(this.targetUrl())) {
        this.heal({ alive: true })
        return true
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    this.state.lastError = '启动超时（30s）未见服务响应'
    this.send(this.getState())
    return false
  }

  stopProbe() {
    if (this.probeTimer) { clearInterval(this.probeTimer); this.probeTimer = null }
  }

  publish() {
    this.send(this.getState())
  }
}

module.exports = { DshService, MODES }
