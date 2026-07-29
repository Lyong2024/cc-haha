# cc-haha Pure Web 改造设计

> **分支**: `web`（基于 `main`）  
> **日期**: 2026-07-29  
> **状态**: 已确认（brainstorm 完成）  
> **读者**: 人类实现者 / AI 编码代理

---

## 1. 背景与动机

cc-haha 以 Electron 桌面为一等公民，但 **本地 Server（`src/server`）已是桌面与 H5 的共享运行时边界**。本改造将 `web` 分支做成 **纯自托管 Web 产品**：

- 浏览器 SPA + Bun Server + CLI 子进程
- 单管理员强制登录
- IM 作为移动端聊天控制（不必打开 Web UI）
- 无 Electron、无桌面宠物、无 H5 Token、无独立 remote 产品模式

与 AionUi pure-web 的差异：

| AionUi | cc-haha |
|--------|---------|
| Gateway + aioncore | **强化 `src/server` + CLI 子进程** |
| 四包 monorepo 拆分 | **渐进**：保留路径，删桌面壳 |
| 可能多套鉴权 | **唯一 Admin session** |

---

## 2. 已确认决策

| 决策点 | 选择 |
|--------|------|
| 产品形态 | 自托管 Web 控制台 |
| 交付深度 | Phase 0–3（含 IM 宿主、定时任务/用量/契约） |
| 包结构 | 渐进演进（`desktop/src` + `src/server`） |
| Electron / 宠物 / Tauri | **web 分支删除** |
| 账号 | **唯一 Admin**；强制登录；session cookie |
| H5 Token | **不做** |
| remote 模式开关 | **不做**（仅 `--host` / `SERVER_HOST`） |
| 控制面存储 | **SQLite + 高性能 PRAGMA** |
| 在线用户 | **Web 会话 + IM 活跃**；**只读，不踢人** |
| IM | **要做**（移动端聊天控制） |
| Computer Use / 原生 PTY | 删除入口或 disabled |

---

## 3. 目标与非目标

### 3.1 目标

1. `claude-haha-web start` / Docker 启动后，浏览器可 setup/登录并使用工作台。
2. Provider 配置后流式对话、停生成、多会话（Key 仅服务端）。
3. Cowork 核心：权限审批、Diff、Skills/MCP、主题（无宠物）。
4. IM 由 web 宿主拉起；手机可不进 Web UI 聊天控制。
5. 系统管理展示在线 Web 会话与 IM 活跃（IP、登录/活跃时间等）。
6. web 产品路径无 electron 运行时依赖；`/sdk/*` 不对公网暴露。

### 3.2 非目标

- Electron 壳、托盘、自动更新、安装器、宠物。
- H5 Token、扫码 H5 远程、remote 产品模式。
- 踢人 / 吊销 session 运营操作（超时失效属安全策略，可保留）。
- 多管理员 / 多租户 SaaS / 计费。
- 浏览器持 API Key 做服务端推理；浏览器直连 CLI 或 `/sdk/*`。
- 为 Web 重写第二套会话引擎。
- monorepo 四包大拆（本轮不做）。

### 3.3 成功标准

| ID | 标准 | 验证 |
|----|------|------|
| S1 | `claude-haha-web start` 后浏览器可 setup/登录 | 手动 + 冒烟 |
| S2 | 配置 Provider 后可流式对话 | 冒烟（无 Key 时 mock） |
| S3 | 会话列表、切换、历史、停止生成 | UI + contract |
| S4 | 权限审批可在 GUI 完成 | UI + WS |
| S5 | Diff 可在浏览器查看 | UI |
| S6 | Skills / MCP 配置入口可用 | API + UI |
| S7 | web 启动路径无 electron 依赖 | `scripts/check-no-electron.mjs` |
| S8 | `/health` 公开；能力 API 未登录 401 | 契约/集成 |
| S9 | Docker Compose 可起（有环境时） | 脚本/CI |
| S10 | 无宠物入口 | grep + 设置 |
| S11 | 强制登录；无 H5 Token UI/主路径 | 测试 |
| S12 | 控制面 SQLite `journal_mode=wal` | PRAGMA |
| S13 | 在线用户含 Web + IM，无踢人 | UI + API |
| S14 | IM 可由 server/cli 拉起 | 集成/mock |
| S15 | 客户端断开不立刻杀运行中任务 | 现有 grace 语义 |

---

## 4. 架构

```text
          ┌─────────────────┐     ┌──────────────────┐
          │  Browser SPA    │     │  IM 平台客户端    │
          │  强制 Admin 登录 │     │  微信/飞书/...    │
          └────────┬────────┘     └────────┬─────────┘
                   │ Cookie session         │ 平台协议
                   ▼                        ▼
          ┌────────────────────────────────────────────┐
          │  src/server（唯一宿主）                      │
          │  · SPA 静态 · /api · /ws · /proxy · /health │
          │  · Admin Session（唯一 Web 身份）           │
          │  · web-control SQLite（会话/在线登记）      │
          │  · adapters 子进程（IM）                    │
          └────────────────────┬───────────────────────┘
                               ▼
                        CLI 子进程（Agent）
```

### 4.1 目录策略

| 路径 | 处理 |
|------|------|
| `src/server/**` | 唯一宿主；增强 auth / presence / static / CLI |
| `desktop/src/**` | Web SPA 源码（目录名可保留） |
| `desktop/electron/**`、宠物、安装器脚本 | **删除** |
| `desktop/src-tauri/**` | **删除** |
| `adapters/**` | 保留；由 server/cli 拉起；Web 设置页配置 |
| `bin/claude-haha-web` | Web 产品 CLI |
| `packages/*` 四包 | **本轮不做**（ADR-1） |

### 4.2 浏览器边界

| 允许 | 禁止 |
|------|------|
| same-origin `/api` `/ws` `/proxy` | 直连 CLI / `/sdk/*` |
| Key 服务端存储 | API Key 进 localStorage |
| workDir 沙箱文件能力 | 任意读服务器整盘 |

### 4.3 desktopHost → web

| 桌面 | Web |
|------|-----|
| `window.desktopHost` IPC | 删除；`browserHost` + REST |
| 系统对话框 | workDir 浏览 / file input |
| 剪贴板 | `navigator.clipboard` |
| 通知 | toast（可选 Notification API） |
| 自动更新 | 文档升级 CLI/Docker |
| 宠物 / 窗口控件 / PTY | 删除或隐藏 |
| Server URL | same-origin 相对路径 |

---

## 5. 鉴权

### 5.1 模型

- **唯一 Admin**，首次 `POST /api/auth/setup` 设置**账号 + 密码**（bcrypt）；登录需同时校验 username 与 password。
- 日常 `login` / `logout`；Cookie：`HttpOnly` + `SameSite=Lax`（HTTPS 时 `Secure`）。
- **所有** `/api/*`（除公开 auth 探针）、`/ws/*`、`/proxy/*` **强制 session**。
- **无 H5 Token**；**不推荐**用模型 API Key 当登录口令。
- CLI：`claude-haha-web reset-password`。

### 5.2 公开端点

- `GET /health`
- `GET /api/auth/status`
- `POST /api/auth/setup`（仅 setupRequired）
- `POST /api/auth/login`
- SPA 静态资源（数据接口仍 401）

### 5.3 与旧模型关系

| 旧能力 | pure-web |
|--------|----------|
| H5 Token / 设置页 H5 访问 | 删除产品路径 |
| loopback 免认证 | **取消**；强制登录 |
| pet token | 随宠物删除 |
| `SERVER_AUTH_REQUIRED` | 被「始终强制登录」取代语义 |
| local access token（桌面 sidecar） | web 路径不依赖 |

---

## 6. 控制面 SQLite

路径：`<data-dir>/db/web-control-v1.sqlite`（与 localIndex 库分离）。

驱动：`bun:sqlite`。

### 6.1 高性能 PRAGMA（强制）

| PRAGMA | 值 |
|--------|-----|
| `journal_mode` | `WAL` |
| `synchronous` | `NORMAL` |
| `temp_store` | `MEMORY` |
| `mmap_size` | `268435456` |
| `cache_size` | `-65536` |
| `busy_timeout` | `5000` |
| `foreign_keys` | `ON` |
| `wal_autocheckpoint` | `1000` |
| `journal_size_limit` | `16MB` |

验收：`PRAGMA journal_mode` → `wal`。  
默认 **不用** `synchronous=OFF`（掉电风险）；如需极限吞吐可后续加 env，默认关。

### 6.2 表（最小）

- `admin_user`：password_hash, created_at, updated_at  
- `web_sessions`：id, token_hash, ip, user_agent, created_at, last_seen_at, expires_at  
- `presence_events` 或派生视图：source=`web`|`im`, platform?, identity, ip?, session_ref?, last_active_at, meta_json  

密码与 session token **只存哈希**；日志禁止明文。

---

## 7. 在线用户（只读）

系统管理页展示：

| 来源 | 字段 |
|------|------|
| Web | 类型、IP、UA 摘要、登录时间、最后活跃、状态（在线/空闲） |
| IM | 类型、平台、绑定用户标识、最近消息时间、关联会话/项目、状态（活跃/空闲） |

阈值（默认可配）：

- Web 在线：有效 session 且 lastSeen ≤ 5 分钟，或存在活跃 WS  
- IM 活跃：adapter 在跑且该用户 ≤ 15 分钟有消息  

**无踢人 / 无吊销按钮 / 无 kick API。**  
Session 超时自动失效属于安全策略，可实现，但不暴露为「踢人」运营功能。

---

## 8. IM

- 由 `claude-haha-web` / Server 拉起 `adapters` 子进程（无 Electron）。
- 设置 → IM 接入（登录后）：配对、平台凭证、默认项目。
- IM 鉴权走平台配对；**不**用 admin cookie。
- IM 活跃写入控制面，供在线用户列表。
- 不做：IM 用户升级为 Web 管理员。

---

## 9. API 边界

优先保持：

- `GET /health`
- `/api/*` REST
- `WS /ws/:sessionId`
- `/proxy/*`

新增：

- `/api/auth/*`（status, setup, login, logout, me）
- `/api/system/online-users`（只读）
- IM 拉起/状态 API（对齐或演进现有 adapters API）

错误体渐进收敛：

```ts
type ApiErrorBody = {
  code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'VALIDATION' | 'RATE_LIMITED' | 'INTERNAL'
  message: string
  details?: unknown
}
```

WS 客户端忽略未知字段。

---

## 10. 安全默认

| 项 | 默认 |
|----|------|
| 监听 | `127.0.0.1:3456` |
| Docker | 文档要求 `0.0.0.0` + 反代 HTTPS |
| 登录 | 强制 |
| CORS | same-origin 为主 |
| 路径 | workDir 沙箱 |
| `/sdk/*` | 不对公网 |
| 登录失败 | 限流 |
| 日志 | 无密码/cookie/API Key |

---

## 11. 交付

### CLI

```bash
claude-haha-web start [--host] [--port] [--data-dir] [--work-dir] [--dist]
claude-haha-web stop
claude-haha-web status
claude-haha-web reset-password
```

### Docker

- 镜像服务 `cc-haha-web`
- 卷：`/data`、`/workspace`
- env：`SERVER_HOST`、`SERVER_PORT`、data/work 路径

### 开发

```bash
# 依赖：默认 pnpm（packageManager = pnpm@11.17.0）
pnpm install
cd desktop && pnpm install && pnpm run build && cd ..

# 运行时：Bun（Server / CLI）
pnpm run web:start
# 或 bun run src/server/index.ts（需 CC_HAHA_WEB_AUTH=1）
```

---

## 12. ADR

### ADR-1：不拆 packages 四包

- **背景**：AionUi 四包清晰，但 cc-haha 已有可用 Server/UI 路径。  
- **决策**：渐进保留 `desktop/src` + `src/server`。  
- **后果**：目录名仍含 desktop；文档与 AGENTS 标明 pure-web 语义。

### ADR-2：强制 Admin Cookie，废弃 H5 Token

- **背景**：产品即 Web UI，不需要附属 H5 远程。  
- **决策**：唯一管理员 + 强制登录；删除 H5 Token 产品路径。  
- **后果**：与 main 桌面 H5 行为分叉；web 分支独立产品语义。

### ADR-3：控制面独立 SQLite + 高性能 PRAGMA

- **背景**：需持久化 admin/session/presence；localIndex 库职责不同。  
- **决策**：`web-control-v1.sqlite` + WAL 等性能 PRAGMA。  
- **后果**：多一个库文件；迁移版本需单独管理。

### ADR-4：在线用户只读且含 IM

- **背景**：运维可见性；不需要会话强制下线。  
- **决策**：Web + IM 列表只读，无 kick。  
- **后果**：多端登录只能等超时或改密重置（reset-password）。

### ADR-5：删除 Electron 而非保留 legacy

- **背景**：用户要求 web 分支彻底删除。  
- **决策**：删除 electron/pet/tauri 产品路径。  
- **后果**：与 main 回并成本高；web 为产品分叉分支。

---

## 13. 分期摘要

见 `implementation-plan.md`。概要：

- **P0** 骨架：删壳、CLI、SQLite、SPA+health、Docker 草稿、no-electron  
- **P1** 强制登录 + Provider + 流式对话  
- **P2** 工作台清理 + 在线用户只读  
- **P3** IM 宿主 + 定时任务/用量 + 契约  
