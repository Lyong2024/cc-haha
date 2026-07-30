# Pure Web PROGRESS

> 每完成可验证里程碑追加命令输出证据。日期：2026-07-29 起。

## 总览

| Phase | 状态 | 备注 |
|-------|------|------|
| 文档 / 设计 | done | brainstorm 已确认并落盘 |
| Phase 0 骨架 | done | electron/tauri 删除、CLI、SQLite、SPA build、Docker 草稿 |
| Phase 1 登录+对话 | done | Admin cookie 强制登录；会话列表/设置/工作台可用 |
| Phase 2 工作台+在线用户 | done | 系统管理只读在线用户（Web+IM）；隐藏 H5/宠物/CU/终端入口 |
| Phase 3 IM+自动化 | done* | adapters process API 独立路由；presence 合并；定时任务/用量沿用既有页（*未专项重验） |

## 决策确认记录

- 2026-07-29：Phase 0–3；渐进包结构；删除 Electron/宠物；Admin cookie 强制登录；无 H5 Token；无 remote 模式；SQLite 高性能；在线用户 Web+IM 只读不踢人；IM 要做。
- 2026-07-29：默认包管理器改为 **pnpm@11.17.0**；Bun 仅作 Server/CLI 运行时。

## 证据日志

### 文档

- 创建：`BASELINE.md`、`pure-web-design.md`、`implementation-plan.md`、`deploy.md`、`task-checklist.md`、`PROGRESS.md`

### Phase 0

```text
$ node scripts/check-no-electron.mjs
check-no-electron: OK

$ bun test src/server/__tests__/web-control-db.test.ts
2 pass, 0 fail  (WAL + web/im online users)

$ cd web && pnpm run build
✓ built in ~1s → dist/
```

### Phase 1 — 强制登录

```text
GET /health → {"status":"ok","service":"haha-web",...}
GET /api/auth/status → setupRequired:true, username:null
GET /api/sessions (no cookie) → 401
POST /api/auth/setup { username, password, confirmPassword }
  → {"ok":true,"authenticated":true,"username":"admin"} + Set-Cookie
POST /api/auth/login { username, password } → ok
GET /api/auth/me (cookie) → authenticated admin + username
GET /api/sessions (cookie) → 200
# SPA：系统初始化表单含 账号 / 密码 / 确认密码
```

### Phase 2 — 在线用户

```text
GET /api/system/online-users (cookie) →
  users: [ { source:"web", ... status:"online" }, { source:"im", platform:"wechat", ... } ]
  note: Read-only ... Kick is not supported.
```

设置页：新增「系统管理」；已移除 H5 访问 / 宠物 / Computer Use / 终端入口。

### Phase 3 — IM 宿主

- `GET /api/adapters/process/status`
- `POST /api/adapters/process/start` `{ platform }`
- `POST /api/adapters/process/stop` `{ platform }`
- `refreshImPresenceFromConfig()` 在在线用户列表时合并配对用户

### 2026-07-29 收尾修复与浏览器验收

```text
# 修复 1：adapters process 路由拆到 adapterProcess.ts
# （避免加载 adapters.ts → whatsapp/session → 缺失 @whiskeysockets/baileys 导致 500 并拖垮 server）

$ bun -e "handleAdapterProcessApi(...) " → 200 {"running":[]}

$ curl login + GET /api/adapters/process/status → 200 {"running":[]}
$ curl GET /api/system/online-users → 200 (web + im:wechat)
$ curl GET /api/sessions?limit=5 → 200
$ curl GET /api/h5-access (cookie) → 200
$ bun test src/server/__tests__/web-control-db.test.ts → 2 pass

# SPA：纯浏览器跳过 H5 fetchAll 请求（settingsStore loadH5AccessSettings）
# UI Playwright：设置 → 系统管理 → 在线用户 + IM 进程 + 退出登录；console errors = 0
# 系统浏览器已打开 http://127.0.0.1:3456/
```

## 已知限制

- SPA 完整 TypeScript `tsc -b` 仍可能因遗留测试/宠物文件报错；产品构建使用 `vite build`（`pnpm run build`）。
- 根目录运行时依赖建议 `pnpm install` + 必要时 `bun install` 补齐 Bun 直连模块解析（见 `.npmrc` hoist）。
- desktop `pnpm approve-builds --all` 需首次批准 esbuild。
- WhatsApp 登录/协议 API 仍依赖可选包 `@whiskeysockets/baileys`；未安装时 process 控制可用，WhatsApp 专有 API 会 500。
- Computer Use / 原生 PTY / 踢人：不做。
- 定时任务与 Token 用量 UI：沿用既有页面，未单独重做验收。
