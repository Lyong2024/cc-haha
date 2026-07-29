# Pure Web Task Checklist

## Phase 0

- [x] web 分支
- [x] 删除 electron / pet / tauri 产品路径
- [x] SPA build + Server 静态托管
- [x] web-control SQLite + WAL PRAGMA
- [x] claude-haha-web CLI
- [x] check-no-electron
- [x] Dockerfile.web + compose
- [x] health + index 冒烟

## Phase 1

- [x] auth setup/login/logout/status/me
- [x] 强制 session（api/ws/proxy）
- [x] 移除 H5 Token 产品路径
- [x] SPA 登录门控
- [x] Provider + 流式对话（沿用既有 API/WS；cookie 鉴权后 200）

## Phase 2

- [x] 清理宠物/H5/Electron UI
- [x] 在线用户 API + UI（Web+IM，只读，无踢人）
- [x] Diff / 权限 / Skills / MCP 通路（既有页面保留）

## Phase 3

- [x] IM adapters 由 server process API 拉起（独立 adapterProcess 路由，不依赖 baileys）
- [x] IM presence 进在线用户
- [x] 定时任务 + 用量（沿用既有设置页入口，浏览器可打开；未专项回归）
- [x] 契约/文档/PROGRESS 收尾

## 安全回归

- [x] 未登录 401
- [x] 无 H5 Token UI
- [x] 无 kick API
- [x] journal_mode=wal
- [x] 无 electron 依赖（web 路径）
- [ ] 日志无 secret（未专项扫）
