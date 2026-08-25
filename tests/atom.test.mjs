// ASCII 原子像素渲染器测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import atom from '../src/atom.js'

const ROWS = 11
const COLS = 25

test('画布尺寸恒定 11 行 × 25 列', () => {
  for (let i = 0; i < atom.frameCount; i++) {
    const rows = atom.frame(i).split('\n')
    assert.equal(rows.length, ROWS, `帧 ${i} 行数`)
    for (const r of rows) assert.equal(r.length, COLS, `帧 ${i} 列数`)
  }
})

test('电子逐帧运行：每帧都含电子 o 与核心 @', () => {
  for (let i = 0; i < atom.frameCount; i++) {
    const f = atom.frame(i)
    assert.ok(f.includes('o'), `帧 ${i} 缺少电子`)
    assert.ok(f.includes('@'), `帧 ${i} 缺少核心`)
  }
})

test('首尾无缝循环：frame(0) === frame(frameCount)', () => {
  assert.equal(atom.frame(0), atom.frame(atom.frameCount))
})

test('负数与超界帧索引安全取模', () => {
  assert.equal(atom.frame(-3), atom.frame(atom.frameCount - 3))
  assert.equal(atom.frame(atom.frameCount * 2 + 5), atom.frame(5))
})

test('渲染确定性：同一帧两次生成完全一致', () => {
  assert.equal(atom.frame(7), atom.frame(7))
})

test('电子确实在动：24 帧中至少出现两种不同的电子位置', () => {
  // 取第一行包含电子的帧号集合，若电子静止则所有帧相同
  const signatures = new Set()
  for (let i = 0; i < atom.frameCount; i++) {
    signatures.add(atom.frame(i).split('\n').map((r) => r.indexOf('o')).join(','))
  }
  assert.ok(signatures.size > 1, '电子位置在帧间没有变化')
})
