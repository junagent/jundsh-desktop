// JUNDSH · DSH 桌面端 — ESLint 扁平配置（ESLint 9）
// 只做正确性检查（未定义变量/不可达代码等），不掺格式意见；格式交给 Prettier（可选使用）
'use strict'
const js = require('@eslint/js')
const globals = require('globals')

module.exports = [
  { ignores: ['node_modules/**', 'release/**', 'build/**', 'assets/**'] },
  js.configs.recommended,
  {
    // 主进程 / 预加载：CommonJS + Node 全局；渲染端脚本混用 browser 全局；本配置文件自身同规则
    files: ['src/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    // 工具脚本（CommonJS）：如 scripts/smoke-dsh-svc.js
    files: ['scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    // 工具与测试脚本：ESM
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },
]
