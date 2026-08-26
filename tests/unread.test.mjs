// 未读数标题解析测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Unread from '../src/unread.js'

const { parseUnreadTitle } = Unread

test('半角括号前缀：(3) DeepSeek → 3', () => {
  assert.equal(parseUnreadTitle('(3) DeepSeek'), 3)
})

test('全角括号与方头括号： （12）X / 【3】X / [7] X', () => {
  assert.equal(parseUnreadTitle('（12）DeepSeek'), 12)
  assert.equal(parseUnreadTitle('【3】DeepSeek'), 3)
  assert.equal(parseUnreadTitle('[7] DeepSeek'), 7)
})

test('数字后允许空格分隔', () => {
  assert.equal(parseUnreadTitle('(5)  DeepSeek Harness'), 5)
})

test('无未读或普通标题 → 0', () => {
  assert.equal(parseUnreadTitle('DeepSeek'), 0)
  assert.equal(parseUnreadTitle(''), 0)
})

test('结尾括号不误判（避免"会议(2)议程"类标题）', () => {
  assert.equal(parseUnreadTitle('DeepSeek (2)'), 0)
  assert.equal(parseUnreadTitle('会议(2)议程'), 0)
})

test('非法输入与非数字内容安全返回 0', () => {
  assert.equal(parseUnreadTitle(null), 0)
  assert.equal(parseUnreadTitle(undefined), 0)
  assert.equal(parseUnreadTitle(123), 0)
  assert.equal(parseUnreadTitle('(abc) X'), 0)
})

test('未读数上限 999；超过 3 位数字视为非未读标记（防误判）', () => {
  assert.equal(parseUnreadTitle('(999) X'), 999)
  assert.equal(parseUnreadTitle('(99999) X'), 0)
})
