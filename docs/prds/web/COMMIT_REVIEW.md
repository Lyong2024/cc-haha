# `web` 分支提交前 Review 清单

> 供维护者审阅本地改动后再 `git push -u origin web`。  
> **未自动 commit / push** — 由你决定。

## 分支与远程

| 项 | 值 |
|----|-----|
| 当前分支 | `web`（基于 `main` @ `bd44d0a1`） |
| 建议远程 | `origin` → 推送到 `web`（非 `main`） |
| 包管理 | pnpm@11.17.0 + Bun runtime |

## 建议纳入版本库

### 新增（产品 / 基础设施）

- `bin/claude-haha-web`, `bin/claude-haha-web.ts`
- `Dockerfile.web`, `docker-compose.web.yml`
- `.npmrc`, `web/.npmrc`, `web/pnpm-workspace.yaml`
- `pnpm-lock.yaml`（根目录）
- `scripts/check-no-electron.mjs`
- `docs/prds/web/*`（设计 / 计划 / 部署 / 进度）
- `src/server/api/auth.ts`, `system.ts`, `adapterProcess.ts`
- `src/server/services/webAuthService.ts`, `webControlDb.ts`, `webPresenceService.ts`, `webAdapterHost.ts`
- `src/server/__tests__/web-control-db.test.ts`
- `web/src/components/auth/AdminAuthGate.tsx`
- `web/src/pages/SystemSettings.tsx`

### 修改

- `package.json`（`packageManager`、`web:*`、`claude-haha-web` bin）
- `web/package.json`（剥离 Electron 依赖）
- SPA：`App.tsx`, `main.tsx`, `AppShell`, `Settings`, `settingsStore`, `electronHost` stub 等
- Server：`index.ts`, `router.ts`, `middleware/auth|cors`, `api/adapters.ts`
- `README.md` / `README.zh-CN.md` / `AGENTS.md`
- `.gitignore`

### 删除（web 产品路径）

- 整个 `web/electron/**`
- 整个 `web/src-tauri/**`

## 勿提交（已 ignore）

| 路径 | 原因 |
|------|------|
| `node_modules/`, `web/node_modules/` | 依赖 |
| `dist/` | SPA 构建产物（仓库根） |
| `.codegraph/`, `.omc/`, `temp/` | 本地 agent / 草稿 |
| `pure-web-*.png`, 根目录 `/*.png` | 本地截图 |
| `.env` | 密钥 |

## 建议提交信息（Conventional）

```text
feat(web): pure-web self-host with admin account setup

Ship browser SPA + Bun server without Electron: forced admin
cookie auth (username+password setup), SQLite control plane,
online users (Web+IM read-only), IM process host API, Docker
and claude-haha-web CLI. Remove electron/tauri product paths.
```

## 推送前自检（建议）

```bash
node scripts/check-no-electron.mjs
bun test src/server/__tests__/web-control-db.test.ts
cd web && pnpm run build && cd ..
# 可选：pnpm run web:start → 浏览器 setup/login
git status --short
git diff --check
```

## 推送示例（review 通过后）

```bash
git add -A
git status   # 再确认无 temp/dist/node_modules
git commit -m "feat(web): pure-web self-host with admin account setup"
git push -u origin web
```

或开 PR：`web` → 你的 fork / 上游策略按团队约定。
