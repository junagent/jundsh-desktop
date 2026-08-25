// JUNDSH · DSH 桌面端 — 设置 Schema（单一事实源）
// 主进程 loadSettings / app:set-settings 补丁校验、外壳 shell.js、悬浮窗 float.js
// 共用同一套取值范围与规范化逻辑；新增设置字段只改这里。
// UMD：浏览器挂 window.JSchema，Node 走 require。
;(function (global) {
  'use strict'

  // 皮肤：abyss 为默认（v1.4 起）；'default' 是 v1.3 旧键，迁移为 abyss
  const SKINS = ['abyss', 'graphite', 'violet', 'emerald', 'amber']
  const SKIN_ALIASES = { default: 'abyss' }
  const THEMES = ['system', 'light', 'dark']
  const DSH_MODES = ['external', 'profile', 'source']

  function normalizeSkin(skin) {
    const s = SKIN_ALIASES[skin] || skin
    return SKINS.includes(s) ? s : 'abyss'
  }
  // 严格判定：补丁校验用——只有真实可识别的键才允许写入（别名也算识别）
  function isKnownSkin(skin) {
    if (typeof skin !== 'string') return false
    const s = SKIN_ALIASES[skin] || skin
    return SKINS.includes(s)
  }
  function normalizeTheme(theme) {
    return THEMES.includes(theme) ? theme : 'system'
  }
  function normalizeDshMode(mode) {
    return DSH_MODES.includes(mode) ? mode : 'external'
  }
  function isValidHttpUrl(url) {
    return typeof url === 'string' && /^https?:\/\/\S+$/i.test(url)
  }
  function clampZoom(zoom) {
    const z = Number(zoom)
    if (!Number.isFinite(z)) return 1
    return Math.min(2, Math.max(0.5, z))
  }
  function clampPort(port, fallback) {
    fallback = Number.isInteger(fallback) ? fallback : 8080
    const p = parseInt(port, 10)
    if (!Number.isFinite(p) || p < 1) return Math.min(65535, fallback)
    return Math.min(65535, p)
  }

  // 设置导入白名单：从任意来源 JSON 中挑出可识别、规范化后的字段（不含设备相关项：
  // 窗口位置/最大化/悬浮鲸位置/自启状态/便携版提醒等均不随备份迁移）
  function pickImportable(raw) {
    const patch = {}
    if (!raw || typeof raw !== 'object') return patch
    if (isValidHttpUrl(typeof raw.targetUrl === 'string' ? raw.targetUrl.trim() : '')) {
      patch.targetUrl = raw.targetUrl.trim()
    }
    if (typeof raw.minimizeToTray === 'boolean') patch.minimizeToTray = raw.minimizeToTray
    if (typeof raw.zoomFactor === 'number') patch.zoomFactor = clampZoom(raw.zoomFactor)
    if (THEMES.includes(raw.theme)) patch.theme = raw.theme
    if (isKnownSkin(raw.skin)) patch.skin = normalizeSkin(raw.skin)
    if (typeof raw.floatEnabled === 'boolean') patch.floatEnabled = raw.floatEnabled
    if (typeof raw.hotkeySummon === 'boolean') patch.hotkeySummon = raw.hotkeySummon
    if (typeof raw.notifyServiceState === 'boolean') patch.notifyServiceState = raw.notifyServiceState
    if (raw.dsh && typeof raw.dsh === 'object') {
      const d = {}
      if (DSH_MODES.includes(raw.dsh.mode)) d.mode = raw.dsh.mode
      if (typeof raw.dsh.port === 'number') d.port = clampPort(raw.dsh.port)
      if (typeof raw.dsh.sourceRepo === 'string' && raw.dsh.sourceRepo) d.sourceRepo = raw.dsh.sourceRepo
      if (Object.keys(d).length) patch.dsh = d
    }
    return patch
  }

  const api = {
    SKINS,
    THEMES,
    DSH_MODES,
    normalizeSkin,
    isKnownSkin,
    normalizeTheme,
    normalizeDshMode,
    isValidHttpUrl,
    clampZoom,
    clampPort,
    pickImportable,
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else global.JSchema = api
})(typeof window !== 'undefined' ? window : globalThis)
