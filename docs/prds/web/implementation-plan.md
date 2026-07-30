# Pure Web Implementation Plan

> 每个 Task 尽量小粒度；验收命令写在 Task 末尾。  
> 顺序：P0 → P1 → P2 → P3，未完成不得跳步宣称完成。

---

## Phase 0 — 骨架

### T0.1 文档与分支

- [x] `docs/prds/web/*` 设计文档
- [ ] 自 `main` 创建 `web` 分支
- **验收**: `git branch --show-current` → `web`

### T0.2 删除桌面壳路径

- [ ] 删除 `web/electron/**`（含 preload/ipc/services）
- [ ] 删除宠物相关 renderer/preload/资源入口（产品路径）
- [ ] 删除 `web/src-tauri/**`
- [ ] 清理 `web/package.json`：去掉 electron 主入口与 electron 脚本依赖（保留 vite SPA 构建）
- **验收**: `scripts/check-no-electron.mjs`；web 构建不引用 electron

### T0.3 SPA 纯 Web 启动

- [ ] `browserHost` 为唯一 host；same-origin 解析 Server
- [x] Server `staticH5` 托管仓库根 `dist/`（兼容 `web/dist`）
- [ ] 去掉依赖 Electron 注入 local access token 的硬路径（改 cookie 会话，P1 接完）
- **验收**: `cd web && pnpm run build`；Server 返回 `index.html`

### T0.4 控制面 SQLite

- [ ] `src/server/services/webControlDb.ts`（open + PRAGMA）
- [ ] schema：admin / web_sessions / presence
- [ ] 单测：journal_mode=wal
- **验收**: `bun test` 覆盖 webControlDb

### T0.5 Web CLI

- [ ] `bin/claude-haha-web`（或 `.ts` + bin 包装）
- [ ] 子命令：`start|stop|status|reset-password`
- [ ] 支持 `--host --port --data-dir --work-dir --dist`
- **验收**: `claude-haha-web status` / start 后 curl health

### T0.6 check-no-electron + Docker 草稿

- [ ] `scripts/check-no-electron.mjs`
- [ ] `Dockerfile.web` + `docker-compose.web.yml`
- **验收**: 脚本 exit 0；compose 文件静态合法

### T0.7 冒烟

- [ ] curl `/health` → ok
- [ ] curl `/` → 200 HTML
- **验收**: 记录于 PROGRESS.md

---

## Phase 1 — 强制登录 + 对话

### T1.1 Auth API

- [ ] `GET /api/auth/status`
- [ ] `POST /api/auth/setup`
- [ ] `POST /api/auth/login` / `logout` / `me`
- [ ] cookie session；bcrypt 密码
- **验收**: 未 setup 可 setup；登录后 me 200

### T1.2 强制鉴权中间件

- [ ] 替换/收敛 H5 token 与 loopback 免登对 web 产品路径的放行
- [ ] `/api`（除公开 auth）、`/ws`、`/proxy` 强制 session
- [ ] 删除或旁路 H5 Token 产品 API/UI
- **验收**: 无 cookie → 401

### T1.3 SPA 登录门控

- [ ] Setup / Login 页
- [ ] 登录后进入现有 AppShell 会话流
- **验收**: 浏览器可完成登录进入主 UI

### T1.4 Provider + 流式

- [ ] 确保 Provider CRUD + redact 在强制登录下可用
- [ ] WS 流式 + stop（现有协议）
- **验收**: chat-contract / 集成冒烟

---

## Phase 2 — 工作台 + 系统管理

### T2.1 UI 清理

- [ ] 删除宠物/H5 访问/Electron 窗口控件/更新检查等入口
- [ ] Computer Use / PTY：删除或 disabled 文案
- **验收**: grep 设置路由无 pet/h5-token 入口

### T2.2 在线用户只读

- [ ] `GET /api/system/online-users`
- [ ] Web presence：登录/请求/WS 刷新 last_seen
- [ ] 设置 → 系统管理只读表
- [ ] **无 kick API/按钮**
- **验收**: 登录后列表含 Web 行

### T2.3 Diff / 权限 / Skills / MCP

- [ ] 验证现有能力在 cookie 鉴权下可用；补缺口
- **验收**: 对应 server/desktop 窄测

---

## Phase 3 — IM + 自动化 + 契约

### T3.1 IM 宿主

- [ ] Server/CLI 启动/停止 adapters（无 Electron）
- [ ] IM 设置页可用
- [ ] IM 活跃写入 presence
- **验收**: online-users 可含 type=im；adapter 启停 API

### T3.2 定时任务 + 用量

- [ ] 现有 cron/scheduled 在 web 路径可用
- [ ] Token 用量展示（若已有则接通 UI）
- **验收**: API 冒烟

### T3.3 契约与文档

- [ ] 主要 `/api` 列表/契约测试加固
- [ ] `deploy.md`、README pure-web 节、AGENTS.md 更新
- [ ] PROGRESS.md 证据齐全
- **验收**: check:impact 选中命令

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 删除 electron 导致 desktop 测试大面积失败 | web 分支调整 package scripts；桌面 e2e 标记不适用 |
| 强制登录破坏现有 server 单测 | 测试注入 session 或 test-only bypass env 仅 CI 临时目录 |
| H5 策略代码纠缠 | 新 `webAuth` 路径优先；旧 H5 policy 逐步剥离 |
| IM 无真账号 | mock + 进程启停验收 |
