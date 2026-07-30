# haha Pure Web 部署

## 前置

| 工具 | 用途 | 版本建议 |
|------|------|----------|
| **pnpm** | **默认**依赖安装 / SPA 构建 | `11.17.0`（`packageManager` 字段） |
| Bun | Server / CLI 运行时（`Bun.serve`、`bun:sqlite`） | 1.3+ |
| Docker | 可选容器部署 | Compose v2 |

启用 Corepack（推荐）：

```bash
corepack enable
corepack prepare pnpm@11.17.0 --activate
```

## CLI

```bash
# 安装依赖（默认 pnpm）
pnpm install
cd web && pnpm install && cd ..

# 构建 SPA
pnpm run web:build
# 或: cd web && pnpm run build && cd ..

# 启动（默认 127.0.0.1:3456；运行时仍用 Bun）
pnpm run dev
# 或: pnpm run web:start
# 或: bun run ./bin/claude-haha-web.ts start
# 或: ./bin/claude-haha-web start
# 一键构建 SPA 再启动: pnpm run web:dev

# 常用参数
#   --host 127.0.0.1
#   --port 3456
#   --data-dir <path>     # 控制面 DB、设置等
#   --work-dir <path>     # 默认工作区
#   --dist <path>         # SPA dist（默认仓库根 dist/）

pnpm run web:status
claude-haha-web stop
claude-haha-web reset-password
```

首次打开浏览器访问服务地址 → **系统初始化（账号 + 密码 + 确认密码）** → 登录使用。

重置管理员密码（已初始化后）：

```bash
bun run ./bin/claude-haha-web.ts reset-password
# 或交互式 / 参数视 CLI 帮助
```

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `SERVER_HOST` | 监听地址 | `127.0.0.1` |
| `SERVER_PORT` | 端口 | `3456` |
| `CLAUDE_H5_DIST_DIR` / `WEB_APP_DIST` | SPA 产物目录 | 仓库根 `dist/` |
| `HAHA_DATA_DIR` | 数据目录（含 web-control sqlite） | 平台默认 config 目录 |
| `CLAUDE_CLI_PATH` | CLI 可执行路径 | 自动解析 |
| `HAHA_WEB_MODE` / `HAHA_WEB_AUTH` | pure-web 强制管理员登录 | CLI start 时设为 `1` |

**安全**：公网务必反代 HTTPS；勿将管理员密码或 API Key 写入日志/镜像层。

## Docker

```bash
docker compose -f docker-compose.web.yml up --build -d
curl -sS http://127.0.0.1:3456/health
```

镜像构建阶段使用 **pnpm** 安装与构建 SPA；运行阶段使用 **Bun** 启动 `claude-haha-web`。

## 升级

1. 拉取 `web` 分支新版本  
2. `pnpm install`（根目录 + `web/`）  
3. `cd web && pnpm run build`  
4. 重启 `claude-haha-web` / `pnpm run web:start`  
5. 数据卷保留；关注 `web-control` / localIndex 迁移日志  

## 与桌面版关系

- `main`：Electron 桌面产品（历史路径可能仍见 bun 脚本）  
- `web`：**纯 Web 自托管**；依赖管理默认 **pnpm**，服务运行时仍为 Bun  
