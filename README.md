# Claude Code Haha (`web` branch · pure-web self-host)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-horizontal-dark.png">
    <img src="docs/images/logo-horizontal.png" alt="Claude Code Haha" width="480">
  </picture>
</p>

<div align="center">

[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)
[![English](https://img.shields.io/badge/🇺🇸_English-Current-blue)](README.md)
[![中文](https://img.shields.io/badge/🇨🇳_简体中文-Available-green)](README.zh-CN.md)

**English** · [简体中文](README.zh-CN.md)

</div>

Claude Code Haha on the **`web` branch** is a **self-hosted browser workbench**: SPA + Bun server + single-admin login. Sessions, model providers, Skills/MCP, IM adapters, scheduled tasks, Agent CLI tools, and system management run **without Electron**.

| Surface | Status on `web` |
|---------|-----------------|
| Browser SPA + Bun API / WebSocket | **Yes** |
| Admin setup (username + password) + cookie session | **Yes** |
| Host OS default terminal (server process user) | **Yes** |
| Multi Agent CLI (Claude / Codex / Gemini / Grok / …) | **Yes** |
| Grok Official multi-account pool + quota sync | **Yes** |
| Import providers from Claude Code / desktop `cc-haha` (opt-in) | **Yes** |
| Electron / Tauri shell | **Removed** |
| Desktop pets | **Removed** |
| H5 remote token | **Removed** |
| In-browser PTY terminal | **Not available** (opens host terminal instead) |

> Looking for the classic desktop installer product? Use the **`main`** branch / [Releases](https://github.com/NanmiCoder/__KEEP_HAHA__/releases).

---

## Quick start

**Requirements:** Node (for pnpm), [Bun](https://bun.sh) 1.3+, Windows / macOS / Linux.

```bash
git checkout web
corepack enable && corepack prepare pnpm@11.17.0 --activate
pnpm install
cd web && pnpm install && cd ..
pnpm run web:build          # SPA → dist/ (and web/dist during build)
pnpm run dev                # http://127.0.0.1:3456
```

1. Open **http://127.0.0.1:3456**
2. **First run:** system setup — admin **username + password + confirm**
3. Configure model providers in **Settings → Providers**
4. Create or resume sessions (history shares CLI JSONL under `~/.claude/projects/...`)

### Commands

| Command | Purpose |
|---------|---------|
| `pnpm run dev` / `web:start` | Start pure-web server |
| `pnpm run web:build` | Build SPA only |
| `pnpm run web:dev` | Build SPA then start |
| `pnpm run web:status` | Server status |
| `pnpm run check:no-electron` | Guard: no Electron product deps |
| `docker compose -f docker-compose.web.yml up --build -d` | Optional container |

CLI entry:

```bash
bun run ./bin/claude-haha-web.ts start --host 0.0.0.0 --port 3456
# optional: --data-dir PATH
```

Design & deploy: [docs/prds/web/deploy.md](docs/prds/web/deploy.md) · [pure-web design](docs/prds/web/pure-web-design.md)

---

## What you get

- **Workbench UI** — multi-session tabs, projects, workspace/diff, permissions, themes
- **Providers** — Claude / ChatGPT / Grok official OAuth, third-party Anthropic/OpenAI-compatible APIs, local gateways
- **External provider import (opt-in)** — discover Claude Code (`~/.claude/settings.json`) and desktop **`cc-haha`** (`~/.claude/cc-haha/providers.json`); **you choose what to import**. No silent merge, no automatic switch of the write directory. Name collisions get a source suffix (e.g. `DeepSeek (cc-haha)`)
- **Grok Official account pool** — multi-account list, sticky “default account”, round-robin among healthy accounts, quota sync (**weekly** via `format=credits` + **monthly** included budget), credential refresh, auth.json-style export
- **Agent CLI manager** — switch active CLI brand (Claude Code, Codex, Gemini, Grok, …), set default, open host shell
- **Agents / Skills / MCP / plugins**
- **IM adapters** — Telegram / Feishu / WeChat / DingTalk / WhatsApp (hosted by the server process, no Electron)
- **System admin** — online users (Web + IM, read-only), IM process start/stop, logout
- **Security** — forced admin login; lockout after 10 failed logins (browser fingerprint + IP, 1 hour); password show/hide on auth forms
- **Host terminal / host shell** — opens the **machine’s default terminal** as the **server OS user**; cwd prefers the current session project when available

---

## Data directories (important)

Providers and pure-web control state are **files / SQLite under a product data dir**, not “the monorepo database”.

| Path | Role |
|------|------|
| `HAHA_DATA_DIR` (or `--data-dir`) | **Active write root** for this process. Pure-web default: `~/.claude/haha-web` |
| `~/.claude/haha` / `~/.claude/cc-haha` | Brand product folders (desktop often uses **`cc-haha`**) |
| `~/.claude/settings.json` | **Claude Code** user settings (`env` API keys / base URL / models) |
| `~/.claude/projects/...` | Shared session transcripts (JSONL) |

**Isolation rules:**

1. The running instance only **writes** to its active data dir (`HAHA_DATA_DIR` / default `haha-web`).
2. Claude Code and desktop `cc-haha` are **read for discovery**; import is **manual** in Settings → Providers → **External settings sources**.
3. Session history under `~/.claude/projects` remains shared with the CLI/desktop when using the same machine user.

Set a dedicated dir when you need full isolation:

```bash
export HAHA_DATA_DIR="$HOME/.claude/haha-web-dev"
pnpm run dev
```

---

## Architecture (short)

```text
Browser SPA (web/ → dist/)
        | Cookie session (admin)
        v
Bun server (src/server)
  |-- providers.json + settings  (active HAHA_DATA_DIR)
  |-- optional import from Claude Code / cc-haha (user opt-in)
  |-- Grok account pool (Grok Official only)
  |-- sessions JSONL (~/.claude/projects)
  |-- web-control SQLite (admin / presence)
  |-- CLI / Agent CLI subprocess per chat
  |-- open host terminal / host shell
```

---

## More documentation

| Topic | Doc |
|-------|-----|
| Deploy / Docker / env | [docs/prds/web/deploy.md](docs/prds/web/deploy.md) |
| Product design | [docs/prds/web/pure-web-design.md](docs/prds/web/pure-web-design.md) |
| CLI env | [docs/en/cli/env.md](docs/en/cli/env.md) |
| IM | [docs/en/im/index.md](docs/en/im/index.md) |
| Server internals | [docs/en/internals/server.md](docs/en/internals/server.md) |
| Contributing | [docs/en/internals/contributing.md](docs/en/internals/contributing.md) |

Full site (desktop-oriented docs may still describe `main`): <https://Haha.ai>

---

## Tech stack (`web`)

| Layer | Stack |
|-------|--------|
| SPA | React + Vite + TypeScript (`web/`) |
| Package manager | **pnpm@11.17.0** |
| Server / CLI runtime | **Bun** (`Bun.serve`, `bun:sqlite`) |
| Control plane | SQLite WAL (`web-control`) |
| Device fingerprint (login lockout) | [@fingerprintjs/fingerprintjs](https://github.com/fingerprintjs/fingerprintjs) (open source) |

---

## License

MIT — see [LICENSE](LICENSE).
