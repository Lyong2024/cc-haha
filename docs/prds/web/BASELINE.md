# Pure Web 改造基线

| 字段 | 值 |
|------|-----|
| 分支 | `web`（自 `main` 创建） |
| Base SHA | `bd44d0a17d9846f2bd177c772ca4be88b93f0486` |
| Base 说明 | `fix(desktop): refine slash menu and launch warnings` |
| 日期 | 2026-07-29 |
| 上游参考 | https://github.com/Lyong2024/cc-haha |
| 对照改造 | AionUi pure-web（思想参考；运行时为 Server + CLI，非 aioncore） |

## 基线架构事实

- 本地 Server：`src/server`（Bun.serve），默认 `127.0.0.1:3456`
- UI：`desktop/src`（React + Vite + Zustand），已有 `browserHost`
- 桌面壳：`desktop/electron` + 宠物 +（遗留）`desktop/src-tauri`
- 运行时：Server 按会话拉起 CLI 子进程
- 已有 H5 静态托管与 H5 Token 远程模型（pure-web **废弃** H5 Token / remote 产品路径）

## 改造原则（已确认）

1. 渐进包结构：保留 `desktop/src` + `src/server`，不拆四包 monorepo
2. web 分支删除 Electron / 宠物 / Tauri 产品路径
3. 唯一 Admin + 强制登录 + session cookie；无 H5 Token；无 remote 模式产品开关
4. 控制面 SQLite 高性能配置；在线用户 = Web + IM（只读，不踢人）
5. IM 由 Server/CLI 拉起，作为移动端聊天控制通道
6. **默认包管理器 pnpm**（`packageManager: pnpm@11.17.0`）；Bun 仅用于 Server/CLI 运行时
