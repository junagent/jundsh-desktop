// JUNDSH · DSH 桌面端 — 未读数标题解析（单一事实源）
// 网页聊天应用惯例：有未读时把数字加进 document.title 前缀，如
//   "(3) DeepSeek" / "（12）DeepSeek" / "【3】DeepSeek" / "[7] DeepSeek"
// 这里统一解析；无法识别或无未读返回 0。浏览器挂 window.JUnread，Node 走 require。
;(function (global) {
  'use strict'

  // 仅识别前缀形态：结尾的 "(2)" 极易与普通括号内容混淆（如 "会议(2)议程"），不采纳
  const PREFIXES = [
    /^\((\d{1,3})\)[\s\u2000-\u206F\u3000]*/, // (3)
    /^（(\d{1,3})）[\s\u2000-\u206F\u3000]*/, // （3）
    /^【(\d{1,3})】[\s\u2000-\u206F\u3000]*/, // 【3】
    /^\[(\d{1,3})\][\s\u2000-\u206F\u3000]*/, // [3]
  ]

  function parseUnreadTitle(title) {
    if (typeof title !== 'string') return 0
    for (const re of PREFIXES) {
      const m = re.exec(title.trim())
      if (m) {
        const n = parseInt(m[1], 10)
        if (Number.isInteger(n) && n >= 0) return Math.min(n, 999)
      }
    }
    return 0
  }

  const api = { parseUnreadTitle }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else global.JUnread = api
})(typeof window !== 'undefined' ? window : globalThis)
