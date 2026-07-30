# Agent CLI 管理与多运行时对话 — 设计文档

> **分支**: `web`  
> **日期**: 2026-07-30  
> **状态**: S1–S6 已落地（注册表/探测/安装升级/历史绑定/外部会话适配器/分级对话/门禁）  
> **参考**: [farion1231/cc-switch](https://github.com/farion1231/cc-switch)（检测/安装/升级/多安装冲突）

---

## 1. 背景与目标

在纯 Web 工作台 **系统管理** 中管理宿主机上的多款 Agent CLI，并在工作台内：

- 用 **Logo 切换**当前 CLI（**一个浏览器页面/SPA 会话只激活一个 CLI**）
- 按 CLI **隔离历史会话列表**
- **默认 Claude Code**
- **未安装任何 CLI → 禁止对话**，引导安装
- **检测本地版本 / 最新版本**，支持安装与升级（用户级默认，系统级需授权）

### 1.1 已确认决策

| 决策 | 选择 |
|------|------|
| 切换 CLI 后对话行为 | **完整切换运行时**（各自消息/流式/历史） |
| 一期范围 | **八个 CLI 全量**（检测+安装+升级+对话适配） |
| 默认 CLI | `claude-code` |
| 作用域 | 每「页面」= 浏览器标签页对应的 SPA 实例（`sessionStorage` + 服务端 cookie 会话绑定） |

### 1.2 参考 cc-switch 的可复用模式

cc-switch（Rust/Tauri + React）对「工具生命周期」的成熟做法：

| 模式 | cc-switch 实践 | 本项目映射 |
|------|----------------|------------|
| 探测安装 | `probe_tool_installations`：路径 + `version` + `runnable` + 多路径冲突 | `AgentCliProbeService.probe(id)` |
| 读版本 | `get_tool_versions`：本地 version + latest | `localVersion` + `latestVersion` |
| 生命周期 | `run_tool_lifecycle_action(install\|upgrade)` | `POST /api/system/agent-cli/:id/install\|upgrade` |
| 安装命令 | npm：`npm i -g @pkg@latest`；部分官方 shell installer（OpenCode/Grok/Hermes） | 注册表 `installStrategies[]` 按序尝试 |
| 升级陷阱 | Codex 避免裸 `codex update`（npm 装时假成功）；可跑通后 uninstall+reinstall | Codex/类似工具走 **可运行检测 + 重装自愈** |
| 多安装冲突 | 展示 source/path/version/is_path_default | UI 列出 installs[]，标 default |
| 权限 | 用户级 npm/官方脚本；系统级需提升 | `scope: 'user' \| 'system'`，system 需用户确认并走提权提示 |

> 注意：cc-switch 主打 **Provider 配置切换**，本项目主打 **Web 内对话运行时 + 安装管理**；配置预设可后续复用思路，**一期不做完整 provider 矩阵**。

---

## 2. 支持的 CLI 注册表

| id | 显示名 | 探测命令 | 安装策略（默认用户级） | 历史根（只读扫描） |
|----|--------|----------|------------------------|--------------------|
| `claude-code` | Claude Code | `claude` / `claude-haha` / 仓库 `bin/claude-haha` | npm `@anthropic-ai/claude-code`；或本仓库 `claude-haha` | `~/.claude/projects/**/*.jsonl` |
| `codex` | Codex CLI | `codex` | npm `@openai/codex@latest`（升级不走假 `codex update`） | Codex 会话目录（若存在则扫描） |
| `gemini` | Gemini CLI | `gemini` | npm `@google/gemini-cli` 或官方包名探测 | 厂商目录 / 可配置 |
| `kimi` | Kimi Code CLI | `kimi` | npm `@moonshot-ai/kimi-code` | 可配置 |
| `grok` | Grok CLI | `grok` / `~/.grok/bin/grok` | 本机原生安装探测（非 npm） | 可配置 |
| `mistral` | Mistral CLI | `mistral` | 官方/npm（注册表） | 可配置 |
| `opencode` | OpenCode CLI | `opencode` | 官方 `opencode.ai/install` 优先，npm `opencode-ai` 回退 | 可配置 |
| `pi` | Pi | `pi` | 官方/npm（注册表） | 可配置 |

- **Logo**：`web/public/cli-logos/{id}.svg`（缺失时用文字首字母）
- **版本最新**：优先 `npm view <pkg> version`；无 npm 包时用官方 release API 或 CLI 自带 `update --check`（若可非交互）

---

## 3. 架构

```text
┌─────────────────────────────────────────────────────────────┐
│ Browser SPA                                                 │
│  SystemSettings → AgentCliManagerPanel (install/upgrade)    │
│  Workbench chrome → CliLogoSwitcher (one active CLI/page)   │
│  chatStore / sessionStore → filter by agentCliId            │
└───────────────────────────┬─────────────────────────────────┘
                            │ REST + Cookie
┌───────────────────────────▼─────────────────────────────────┐
│ Bun Server                                                  │
│  /api/system/agent-cli/*   probe / install / upgrade /      │
│                            set-active / list-sessions       │
│  AgentCliRegistry (catalog)                                 │
│  AgentCliProbeService (PATH, version, multi-install)        │
│  AgentCliLifecycleService (user|system install/upgrade)     │
│  AgentCliRuntimeRouter → Adapter per CLI                    │
│     claude-code → existing conversationService + JSONL      │
│     others → AgentCliAdapter (spawn + stream bridge)        │
│  web-control SQLite: agent_cli_prefs, session_cli_binding   │
└─────────────────────────────────────────────────────────────┘
                            │
                    Host process (server OS user)
```

### 3.1 「一页一个 CLI」

- **前端**：`sessionStorage['haha-active-agent-cli']`  
- **服务端**：按 admin session 存 `activeAgentCliId`（刷新后仍一致）  
- 切换 Logo：更新 active → 会话列表重载为该 CLI 历史 → **新建会话**绑定该 CLI  
- **不**在同一 SPA 标签内同时跑两个 CLI 运行时

### 3.2 对话门禁

```text
on chat bootstrap:
  probes = probeAll()
  if none installed && none runnable:
    show InstallGate（禁止发消息，跳转系统管理）
  else if active CLI not installed:
    show banner + 切换已安装 CLI 或安装当前
```

### 3.3 运行时适配器接口

```ts
interface AgentCliAdapter {
  id: AgentCliId
  probe(): Promise<ProbeReport>
  listSessions(opts): Promise<SessionListItem[]>
  getMessages(sessionId): Promise<MessageEntry[]>
  createSession(opts): Promise<{ sessionId }>
  /** Start/stream chat — Claude uses existing WS path; others implement bridge */
  ensureRuntime(sessionId): Promise<void>
  supportsStreamingChat: boolean
}
```

**Claude Code**：保持现有 `conversationService` + `sessionService` JSONL。  
**其它 CLI（一期策略，务实落地）**：

1. **探测/安装/升级**：全量实现（对齐 cc-switch）。  
2. **历史**：若可定位会话文件则只读列表+消息映射；否则空列表 +「在宿主机 CLI 中查看」。  
3. **对话**：优先官方 **非交互/流式** 子进程协议；若无稳定协议，则：
   - 服务端 `spawn` 交互式 CLI 于项目目录（与 server 同用户）
   - 通过 **PTY 流**或「打开宿主机终端并启动该 CLI」保证「能用」
   - Web UI 统一显示连接状态与日志面板  

> 诚实边界：八家完整「像素级」流式协议对等 Claude 不现实；设计要求 **接口统一 + Claude 一等公民 + 其余可运行与可管理**，并在 UI 标明适配成熟度 `maturity: full | beta | manage-only`。

---

## 4. API 草案

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/system/agent-cli` | 列表 + probe 摘要 + activeId |
| GET | `/api/system/agent-cli/:id` | 详情 installs / versions |
| POST | `/api/system/agent-cli/:id/probe` | 强制重探测 |
| POST | `/api/system/agent-cli/:id/install` | `{ scope: 'user'\|'system', version?: string }` |
| POST | `/api/system/agent-cli/:id/upgrade` | `{ scope?, version?: 'latest'\|semver }` |
| POST | `/api/system/agent-cli/active` | `{ id }` 设置当前页/会话 active |
| GET | `/api/system/agent-cli/:id/sessions` | 该 CLI 历史会话（适配器） |

安装/升级为 **长任务**：返回 `{ jobId }`，轮询 `GET /api/system/agent-cli/jobs/:jobId` 日志流（或 SSE 后续）。

**鉴权**：与现有 system API 相同（admin cookie）。  
**system scope**：请求体 `confirmSystem: true`；Windows 可能仅提示「请以管理员终端执行返回的命令」若无法无感 UAC。

---

## 5. UI

### 5.1 系统管理 → Agent 管理

- 卡片网格：Logo、名称、installed/runnable、localVersion、latestVersion  
- 操作：安装 / 升级 / 指定版本 / 设为默认 / 刷新探测  
- 多路径冲突列表（cc-switch ToolInstallRow 风格）  
- 系统级安装二次确认对话框  

### 5.2 工作台 CLI Logo 切换条

- 顶栏或侧栏顶部：已注册 CLI 的 logo 按钮  
- 未安装：灰色 + badge  
- 当前 active：高亮环  
- 切换后：清空非绑定会话视图，加载该 CLI 历史  

---

## 6. 数据

### 6.1 SQLite（web-control）

```sql
-- schema v4
CREATE TABLE agent_cli_prefs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- keys: default_agent_cli_id, last_active_by_session{json}

CREATE TABLE agent_cli_jobs (
  id TEXT PRIMARY KEY,
  cli_id TEXT NOT NULL,
  action TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,
  log TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 6.2 会话绑定

- Claude JSONL 元数据 / 侧车索引增加 `agentCliId`（默认 `claude-code`）  
- 列表过滤：`listSessions({ agentCliId })`  

---

## 7. 安全

- 安装命令白名单：仅注册表允许的 npm 包名与官方 URL  
- 禁止任意 shell 用户输入  
- system 安装：明确风险文案 + 确认  
- 探测 `exec` 超时（3–8s），不阻塞主请求过久  
- 日志脱敏（token/环境）  

---

## 8. 分阶段实施（在「全量」目标下的工程切片）

| Slice | 交付 | 冒烟 |
|-------|------|------|
| **S1** | 注册表 + probe + API + 系统管理 UI + active 切换 + 无 CLI 门禁 | 列表 8 CLI；装/卸探测；门禁 |
| **S2** | install/upgrade user 级（npm + 官方脚本）+ 版本 latest | 对已装 CLI 升级提示 |
| **S3** | Claude 历史按 cli 绑定；默认 claude-code | 切换非 Claude 列表空/其它源 |
| **S4** | 非 Claude adapter：host 启动 CLI + 基础会话记录 | 点 Logo 可启动对应 CLI |
| **S5** | 系统级安装路径 + 指定版本 | 授权对话框 |
| **S6** | 尽可能接入流式对话适配（按 CLI 成熟度） | Claude 全功能；其它 beta |

一期「全量」定义为：**S1–S5 完成 + S6 按能力分级标注**，避免假流式。

---

## 9. 测试与冒烟

- 单元：probe 解析、版本比较、白名单命令构建  
- 集成：mock PATH 装/未装  
- 手动冒烟：  
  1. 无 claude → 禁止发消息  
  2. 安装 claude-code(user) → 可对话  
  3. Logo 切换 → 列表变化  
  4. 升级检测 latest  
  5. 打开另一浏览器标签可不同 active（sessionStorage 隔离）  

---

## 10. 非目标（一期）

- 复刻 cc-switch 的完整 Provider 预设矩阵  
- 在 Docker 无宿主机 CLI 的环境假装安装成功  
- 八家 CLI 与 Claude 完全等价的工具协议  

---

## 11. 成功标准

1. 系统管理可见 8 个 CLI 状态与 Logo  
2. 用户级安装/升级可跑通至少 Claude + 一个 npm CLI  
3. 默认 Claude；切换 CLI 后历史与「新建会话」绑定正确  
4. 零 CLI 时对话硬门禁 + 安装引导  
5. 冒烟清单全绿  

---

**下一步**：按 S1→S5 实施代码；S6 能接尽接。  
