# Claude Code Haha（`web` 分支 · 纯 Web 自托管）

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-horizontal-dark.png">
    <img src="docs/images/logo-horizontal.png" alt="Claude Code Haha" width="480">
  </picture>
</p>

<div align="center">

[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)
[![中文](https://img.shields.io/badge/🇨🇳_简体中文-当前-blue)](README.zh-CN.md)
[![English](https://img.shields.io/badge/🇺🇸_English-Available-green)](README.md)

[English](README.md) · **简体中文**

</div>

本仓库 **`web` 分支** 是 **纯 Web 自托管工作台**：浏览器 SPA + Bun Server + 单管理员登录。会话、模型服务商、Skills/MCP、IM 适配器、定时任务、Agent CLI 工具与系统管理均可在 **无 Electron** 环境下使用。

| 能力 | `web` 分支 |
|------|------------|
| 浏览器 SPA + Bun API / WebSocket | **支持** |
| 管理员初始化（账号 + 密码）+ Cookie 会话 | **支持** |
| 打开宿主机默认终端（服务进程用户权限） | **支持** |
| 多 Agent CLI（Claude / Codex / Gemini / Grok / …） | **支持** |
| Grok 官方多账号池 + 额度同步 | **支持** |
| 从 Claude Code / 桌面 `cc-haha` 导入服务商（用户勾选） | **支持** |
| Electron / Tauri 壳 | **已移除** |
| 桌面宠物 | **已移除** |
| H5 远程 Token | **已移除** |
| 浏览器内嵌 PTY 终端 | **不可用**（改为打开系统终端） |

> 需要桌面安装包产品线请使用 **`main` 分支** / [Releases](https://github.com/NanmiCoder/__KEEP_HAHA__/releases)。

---

## 快速开始

**环境：** Node（pnpm）、[Bun](https://bun.sh) 1.3+，Windows / macOS / Linux。

```bash
git checkout web
corepack enable && corepack prepare pnpm@11.17.0 --activate
pnpm install
cd web && pnpm install && cd ..
pnpm run web:build          # 构建 SPA → dist/
pnpm run dev                # http://127.0.0.1:3456
```

1. 打开 **http://127.0.0.1:3456**
2. **首次访问**：系统初始化 — 管理员 **账号 + 密码 + 确认密码**
3. 在 **设置 → 服务商** 中配置模型
4. 新建或打开会话（历史与 CLI 共用 `~/.claude/projects/...` 下 JSONL）

### 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm run dev` / `web:start` | 启动纯 Web 服务 |
| `pnpm run web:build` | 仅构建 SPA |
| `pnpm run web:dev` | 先构建 SPA 再启动 |
| `pnpm run web:status` | 查看服务状态 |
| `pnpm run check:no-electron` | 校验无 Electron 产品依赖 |
| `docker compose -f docker-compose.web.yml up --build -d` | 可选容器部署 |

CLI：

```bash
bun run ./bin/claude-haha-web.ts start --host 0.0.0.0 --port 3456
# 可选: --data-dir PATH
```

设计与部署：[docs/prds/web/deploy.md](docs/prds/web/deploy.md) · [纯 Web 设计](docs/prds/web/pure-web-design.md)

---

## 功能概览

- **工作台**：多会话、项目、工作区/Diff、权限审批、主题
- **模型服务商**：Claude / ChatGPT / Grok 官方 OAuth，第三方 Anthropic/OpenAI 兼容 API，本地网关
- **外部服务商导入（用户选择）**：可发现 Claude Code（`~/.claude/settings.json`）与桌面端 **`cc-haha`**（`~/.claude/cc-haha/providers.json`）；**由你勾选导入**。不会静默合并，也不会自动切换当前写入目录。重名时附加来源后缀（如 `DeepSeek (cc-haha)`）
- **Grok 官方账号池**：多账号列表、sticky「默认账号」、健康账号轮询、额度同步（**周限** `format=credits` + **月限** 包月额度）、凭据刷新、auth.json 风格导出
- **Agent CLI 管理**：切换当前 CLI 品牌（Claude Code、Codex、Gemini、Grok 等）、设为默认、打开宿主机 Shell
- **Agents / Skills / MCP / 插件**
- **IM 适配器**：Telegram / 飞书 / 微信 / 钉钉 / WhatsApp（由 Server 拉起，无需 Electron）
- **系统管理**：在线用户（Web + IM，只读）、IM 进程启停、退出登录
- **安全**：强制管理员登录；登录失败 10 次锁定 1 小时（浏览器指纹 + IP）；密码可见切换
- **宿主机终端 / Host Shell**：打开 **系统默认终端**，权限与 **Web Server 进程用户** 一致，工作目录优先当前会话项目路径

---

## 数据目录（重要）

服务商与纯 Web 控制面状态位于 **产品数据目录下的文件 / SQLite**，不是“仓库内某个数据库”。

| 路径 | 作用 |
|------|------|
| `HAHA_DATA_DIR`（或 `--data-dir`） | **当前进程的写入根目录**。纯 Web 默认：`~/.claude/haha-web` |
| `~/.claude/haha` / `~/.claude/cc-haha` | 品牌产品目录（桌面端常用 **`cc-haha`**） |
| `~/.claude/settings.json` | **Claude Code** 用户设置（`env` 中的 API Key / Base URL / 模型） |
| `~/.claude/projects/...` | 与 CLI 共享的会话 transcript（JSONL） |

**隔离规则：**

1. 运行中的实例只 **写入** 自己的活动数据目录（`HAHA_DATA_DIR` / 默认 `haha-web`）。
2. Claude Code 与桌面 `cc-haha` 仅用于 **发现**；导入在 **设置 → 服务商 → 外部设置来源** 中 **手动勾选**。
3. 同一系统用户下，`~/.claude/projects` 会话历史可与 CLI/桌面端共用。

需要完全隔离时：

```bash
export HAHA_DATA_DIR="$HOME/.claude/haha-web-dev"
pnpm run dev
```

---

## 架构简述

```text
浏览器 SPA (web/ → dist/)
        | Cookie 会话（管理员）
        v
Bun Server (src/server)
  |-- providers.json + settings（活动 HAHA_DATA_DIR）
  |-- 可选：从 Claude Code / cc-haha 导入（用户勾选）
  |-- Grok 账号池（仅 Grok 官方）
  |-- 会话 JSONL (~/.claude/projects)
  |-- web-control SQLite（管理员 / 在线）
  |-- 每会话 CLI / Agent CLI 子进程
  |-- 打开宿主机默认终端 / Host Shell
```

---

## 更多文档

| 主题 | 文档 |
|------|------|
| 部署 / Docker / 环境变量 | [docs/prds/web/deploy.md](docs/prds/web/deploy.md) |
| 产品设计 | [docs/prds/web/pure-web-design.md](docs/prds/web/pure-web-design.md) |
| CLI 环境变量 | [docs/cli/env.md](docs/cli/env.md) |
| IM | [docs/im/index.md](docs/im/index.md) |
| Server 内部 | [docs/internals/server.md](docs/internals/server.md) |
| 贡献与质量门 | [docs/internals/contributing.md](docs/internals/contributing.md) |

文档站（部分内容仍面向桌面 `main`）：<https://Haha.ai>

---

## 技术栈（`web`）

| 层级 | 技术 |
|------|------|
| SPA | React + Vite + TypeScript（`web/`） |
| 包管理 | **pnpm@11.17.0** |
| Server / CLI | **Bun**（`Bun.serve`、`bun:sqlite`） |
| 控制面 | SQLite WAL（`web-control`） |
| 登录设备指纹 | [@fingerprintjs/fingerprintjs](https://github.com/fingerprintjs/fingerprintjs)（开源） |

---

## 许可证

MIT — 见 [LICENSE](LICENSE)。
