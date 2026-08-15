# 安全策略

## 支持的版本

仅对最新发布版本（`main` 分支 + 最新 Release）提供安全修复。

## 报告漏洞

请**不要**在公开 issue 中提交未修复的安全漏洞。

- 私密途径：发送邮件或在 issue 中标记 `security` 标签并说明严重性
- 请包含：影响版本、复现步骤、影响范围、建议修复方案（如有）

## 项目安全设计

本应用的安全边界：

- **外壳窗口**：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，preload 仅暴露白名单 API
- **webview（DSH 页面）**：强制 `nodeIntegration: false`、`sandbox: true`，拒绝注入 preload
- **IPC**：所有主进程 handler 校验调用方必须是外壳页面（sender 校验）
- **导航**：外部链接一律交给系统浏览器打开，不信任的导航被阻止
- **CSP**：外壳页面 `script-src 'self'`，无内联脚本

若上述设计被绕过，请立即按上方方式报告。
