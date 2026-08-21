// 冒烟：验证 DshService 托管启动（profile 模式）+ 看门狗自动重启
'use strict'
const { DshService } = require('../src/dsh-svc')
const http = require('node:http')

function httpOk(url) {
  return new Promise((resolve) => {
    const u = new URL(url)
    const req = http.get({ hostname: u.hostname, port: u.port, path: '/', timeout: 2500, headers: { Connection: 'close' } }, (res) => { res.resume(); resolve(res.statusCode < 500) })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

const PORT = 8090
let serviceSettings = {
  targetUrl: `http://127.0.0.1:${PORT}`,
  dsh: { mode: 'profile', port: PORT, sourceRepo: '' },
}
const states = []
const svc = new DshService({
  getSettings: () => serviceSettings,
  send: (s) => states.push(s),
  log: (...a) => console.log('[test]', ...a),
})

async function main() {
  svc.start()
  await new Promise((r) => setTimeout(r, 1200))
  console.log('initial state:', JSON.stringify(svc.getState()))
  console.log('starting managed (profile) on', PORT)
  const r = await svc.startManaged()
  console.log('startManaged result ok=', r.ok, 'lastError=', r.state.lastError)
  // 等待健康检查就绪
  await new Promise((r2) => setTimeout(r2, 8000))
  const st = svc.getState()
  console.log('final state:', JSON.stringify(st))
  const reachable = await httpOk(`http://127.0.0.1:${PORT}`)
  console.log('port reachable:', reachable, '| svc.alive:', st.alive)
  const pass = st.alive && reachable
  console.log(pass ? 'SMOKE: PASS' : 'SMOKE: FAIL')

  // ---- 看门狗测试：杀掉托管子进程，观察自动重启 ----
  const { execFileSync } = require('node:child_process')
  const pid = st.pid
  console.log('killing managed child pid=', pid)
  try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }) } catch (e) { console.log('kill warn:', e.message) }
  // 等待看门狗重排与重启（FAIL_THRESHOLD=2 次探测 + 退避）
  await new Promise((r) => setTimeout(r, 22000))
  const st2 = svc.getState()
  const reachable2 = await httpOk(`http://127.0.0.1:${PORT}`)
  console.log('after watchdog state:', JSON.stringify(st2), 'reachable:', reachable2)
  const watchdogOk = reachable2
  console.log(watchdogOk ? 'WATCHDOG: PASS' : 'WATCHDOG: FAIL')

  await svc.stop()
  const afterStop = await httpOk(`http://127.0.0.1:${PORT}`)
  console.log('after stop reachable:', afterStop, '(expect false)')
  process.exit(pass && watchdogOk && !afterStop ? 0 : 1)
}
main().catch((e) => { console.error('test error', e); process.exit(1) })
