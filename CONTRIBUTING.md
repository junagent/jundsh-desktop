# 贡献指南

欢迎贡献！无论是修 bug、加功能、改文档还是提建议，都感谢你的参与。

## 工作流程

1. Fork 本仓库并创建你的分支：`git checkout -b feat/my-feature`
2. 修改代码，遵循下面的规范
3. 本地验证：`node --check src/*.js` + `npm start` 冒烟
4. 提交并推送，然后发起 Pull Request
5. 在 PR 描述中说明改动动机和验证方式

## 代码规范

- **语言**：CommonJS + `'use strict'`（主进程/外壳），无 TypeScript/构建步骤
- **缩进**：2 空格
- **命名**：camelCase 变量/函数，常量 UPPER_SNAKE
- **IPC**：新增主进程通道时，必须在 `registerIpc()` 中用 `guard()` 包裹（sender 校验），并在 `preload.js` 暴露白名单桥接
- **安全**：不要给 webview/guest 开启 nodeIntegration；外部链接用 `shell.openExternal`
- **日志**：主进程用 `[jundsh]` 前缀

## 提交信息

```
feat: 新功能
fix: 修复 bug
docs: 文档改动
chore: 构建/工具/杂项
perf: 性能优化
refactor: 重构（无行为变化）
```

## 发布流程（维护者）

```bash
npm version patch | minor | major
git push --follow-tags   # CI 自动构建并发布 GitHub Release
```

CI 由 `.github/workflows/build.yml` 驱动，使用 `GITHUB_TOKEN` 自动上传安装包到 Releases。

## 测试

项目目前无自动化测试框架，验证方式：

- `node --check src/main.js src/preload.js src/shell.js` — 语法
- `DSH_DESKTOP_SHOT=1 electron .` — 启动冒烟（自动截图后退出）
- 手动验证：连接 / 离线 / 缩放 / 托盘 / 设置持久化
