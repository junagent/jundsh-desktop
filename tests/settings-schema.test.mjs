// 设置 Schema 测试（主进程 / 外壳 / 悬浮窗三方共用的规范化逻辑）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Schema from '../src/settings-schema.js'

test('normalizeSkin：v1.3 旧键 default 迁移为 abyss', () => {
  assert.equal(Schema.normalizeSkin('default'), 'abyss')
})

test('normalizeSkin：合法键原样保留', () => {
  for (const s of ['abyss', 'graphite', 'violet', 'emerald', 'amber']) {
    assert.equal(Schema.normalizeSkin(s), s)
  }
})

test('normalizeSkin：未知值与空值安全回退 abyss', () => {
  assert.equal(Schema.normalizeSkin('neon-pink'), 'abyss')
  assert.equal(Schema.normalizeSkin(undefined), 'abyss')
  assert.equal(Schema.normalizeSkin(null), 'abyss')
  assert.equal(Schema.normalizeSkin(''), 'abyss')
})

test('isKnownSkin：补丁校验严格——别名可识别，未知拒绝', () => {
  assert.equal(Schema.isKnownSkin('default'), true)
  assert.equal(Schema.isKnownSkin('graphite'), true)
  assert.equal(Schema.isKnownSkin('nope'), false)
  assert.equal(Schema.isKnownSkin(undefined), false)
  assert.equal(Schema.isKnownSkin(42), false)
})

test('clampZoom：夹在 0.5–2，非法值归 1', () => {
  assert.equal(Schema.clampZoom(0.1), 0.5)
  assert.equal(Schema.clampZoom(5), 2)
  assert.equal(Schema.clampZoom(1.25), 1.25)
  assert.equal(Schema.clampZoom('abc'), 1)
  assert.equal(Schema.clampZoom(NaN), 1)
  assert.equal(Schema.clampZoom(undefined), 1)
})

test('clampPort：1–65535，非法回退默认 8080', () => {
  assert.equal(Schema.clampPort(3000), 3000)
  assert.equal(Schema.clampPort('8080'), 8080)
  assert.equal(Schema.clampPort(70000), 65535)
  assert.equal(Schema.clampPort(0), 8080)
  assert.equal(Schema.clampPort(-5), 8080)
  assert.equal(Schema.clampPort('abc'), 8080)
  assert.equal(Schema.clampPort(undefined, 9000), 9000)
})

test('isValidHttpUrl：仅接受 http(s) 非空白地址', () => {
  assert.equal(Schema.isValidHttpUrl('http://127.0.0.1:8080'), true)
  assert.equal(Schema.isValidHttpUrl('https://dsh.example.com/x'), true)
  assert.equal(Schema.isValidHttpUrl('ftp://127.0.0.1'), false)
  assert.equal(Schema.isValidHttpUrl('http://127.0.0.1 x'), false) // 含空白
  assert.equal(Schema.isValidHttpUrl(''), false)
  assert.equal(Schema.isValidHttpUrl(undefined), false)
  assert.equal(Schema.isValidHttpUrl(123), false)
})

test('normalizeTheme 与 normalizeDshMode：白名单外回退默认', () => {
  assert.equal(Schema.normalizeTheme('dark'), 'dark')
  assert.equal(Schema.normalizeTheme('sepia'), 'system')
  assert.equal(Schema.normalizeDshMode('profile'), 'profile')
  assert.equal(Schema.normalizeDshMode('auto'), 'external')
})

test('清单常量与规范化互洽', () => {
  assert.deepEqual([...Schema.SKINS].sort(), ['abyss', 'amber', 'emerald', 'graphite', 'violet'])
  assert.deepEqual([...Schema.THEMES].sort(), ['dark', 'light', 'system'])
  assert.deepEqual([...Schema.DSH_MODES].sort(), ['external', 'profile', 'source'])
})

test('pickImportable：合法字段全量保留并规范化', () => {
  const patch = Schema.pickImportable({
    targetUrl: ' http://127.0.0.1:9000 ',
    minimizeToTray: false,
    zoomFactor: 9,
    theme: 'dark',
    skin: 'default',
    floatEnabled: false,
    hotkeySummon: false,
    notifyServiceState: true,
    dsh: { mode: 'profile', port: 99999, sourceRepo: 'D:/dsh' },
  })
  assert.deepEqual(patch, {
    targetUrl: 'http://127.0.0.1:9000',
    minimizeToTray: false,
    zoomFactor: 2, // clamp 上限
    theme: 'dark',
    skin: 'abyss', // 旧键别名迁移
    floatEnabled: false,
    hotkeySummon: false,
    notifyServiceState: true,
    dsh: { mode: 'profile', port: 65535, sourceRepo: 'D:/dsh' },
  })
})

test('pickImportable：白名单外与设备相关字段一律剔除', () => {
  const patch = Schema.pickImportable({
    targetUrl: 'not-a-url',
    theme: 'sepia',
    loginItem: true, // 设备相关：不随备份迁移
    bounds: { x: 0, y: 0 },
    maximized: true,
    version: '1.4.0',
    unknownKey: 42,
  })
  assert.deepEqual(patch, {})
})

test('pickImportable：dsh 部分字段只收可识别的', () => {
  const patch = Schema.pickImportable({ dsh: { mode: 'auto', port: 'abc', sourceRepo: '' } })
  assert.deepEqual(patch, {}) // 全部不可识别 → 不带 dsh
  const patch2 = Schema.pickImportable({ dsh: { mode: 'source', port: 7000 } })
  assert.deepEqual(patch2, { dsh: { mode: 'source', port: 7000 } })
})

test('pickImportable：非对象输入安全返回空补丁', () => {
  assert.deepEqual(Schema.pickImportable(null), {})
  assert.deepEqual(Schema.pickImportable('json'), {})
  assert.deepEqual(Schema.pickImportable(123), {})
})
