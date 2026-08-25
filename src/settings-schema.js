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
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else global.JSchema = api
})(typeof window !== 'undefined' ? window : globalThis)
