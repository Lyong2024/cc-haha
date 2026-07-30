/**
 * Host launch + graded non-interactive chat for non-Claude Agent CLIs (S4/S6).
 *
 * Maturity:
 * - full: Claude (handled outside this module)
 * - beta: try non-interactive prompt exec; fallback open host terminal
 * - manage-only: open host terminal with CLI only
 */

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { openHostTerminal } from '../hostTerminalService.js'
import { getAgentCliDefinition } from './registry.js'
import { probeOne, resolveBinaryPaths } from './probeService.js'
import {
  appendAgentCliMessage,
  createAgentCliSession,
  getAgentCliSession,
  listAgentCliMessages,
  listAgentCliSessions,
  updateAgentCliSession,
  type AgentCliSessionRecord,
} from './sessionStore.js'
import type { AgentCliId, AgentCliMaturity, ProbeReport } from './types.js'

const execFileAsync = promisify(execFile)
const CHAT_TIMEOUT_MS = 120_000

export type AgentCliSessionListItem = {
  id: string
  title: string
  createdAt: string
  modifiedAt: string
  messageCount: number
  projectPath: string
  projectRoot: string | null
  workDir: string | null
  workDirExists: boolean
  workspaceState: 'available' | 'missing'
  agentCliId: AgentCliId
  status: string
  maturity: AgentCliMaturity
  supportsStreamingChat: boolean
}

export type LaunchResult = {
  ok: true
  sessionId: string
  launcher: string
  cwd: string
  command: string
  message: string
}

export type ChatResult = {
  sessionId: string
  mode: 'exec' | 'host-terminal' | 'manage-only'
  userMessageId: string
  assistantMessageId: string | null
  content: string
  maturity: AgentCliMaturity
}

function isWindows(): boolean {
  return process.platform === 'win32'
}

function resolveDefaultBinary(cliId: AgentCliId): { binary: string; path: string | null } {
  const def = getAgentCliDefinition(cliId)
  if (!def) return { binary: cliId, path: null }
  for (const name of def.binaries) {
    const paths = resolveBinaryPaths(name)
    if (paths[0]) return { binary: name, path: paths[0] }
  }
  return { binary: def.binaries[0] ?? cliId, path: null }
}

/** Build argv for a non-interactive one-shot prompt when possible. */
export function buildNonInteractiveArgs(
  cliId: AgentCliId,
  prompt: string,
): string[] | null {
  // Keep allowlisted argv shapes only — no free-form shell.
  switch (cliId) {
    case 'codex':
      // codex exec "prompt" is the non-interactive path in recent CLIs
      return ['exec', '--skip-git-repo-check', prompt]
    case 'gemini':
      return ['-p', prompt]
    case 'opencode':
      return ['run', prompt]
    case 'kimi':
    case 'grok':
    case 'mistral':
    case 'pi':
      // No stable non-interactive contract assumed
      return null
    default:
      return null
  }
}

export function toSessionListItem(
  row: AgentCliSessionRecord,
  maturity: AgentCliMaturity,
): AgentCliSessionListItem {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt,
    messageCount: row.messageCount,
    projectPath: row.workDir,
    projectRoot: row.workDir,
    workDir: row.workDir,
    workDirExists: true,
    workspaceState: 'available',
    agentCliId: row.cliId,
    status: row.status,
    maturity,
    supportsStreamingChat: maturity === 'beta' || maturity === 'full',
  }
}

export async function listSessionsForCli(
  cliId: AgentCliId,
  options?: { limit?: number; offset?: number },
): Promise<{ sessions: AgentCliSessionListItem[]; total: number }> {
  const def = getAgentCliDefinition(cliId)
  const maturity = def?.maturity ?? 'manage-only'
  const page = listAgentCliSessions(cliId, options)
  return {
    total: page.total,
    sessions: page.sessions.map((s) => toSessionListItem(s, maturity)),
  }
}

export async function createSessionForCli(
  cliId: AgentCliId,
  workDir?: string | null,
  title?: string | null,
): Promise<AgentCliSessionListItem> {
  const def = getAgentCliDefinition(cliId)
  if (!def) throw new Error(`Unknown CLI: ${cliId}`)
  const row = createAgentCliSession({ cliId, workDir, title })
  return toSessionListItem(row, def.maturity)
}

export async function launchHostCli(input: {
  cliId: AgentCliId
  sessionId?: string
  workDir?: string | null
}): Promise<LaunchResult> {
  const def = getAgentCliDefinition(input.cliId)
  if (!def) throw new Error(`Unknown CLI: ${input.cliId}`)

  let session = input.sessionId ? getAgentCliSession(input.sessionId) : null
  if (!session) {
    session = createAgentCliSession({
      cliId: input.cliId,
      workDir: input.workDir,
    })
  }

  const { binary, path: binaryPath } = resolveDefaultBinary(input.cliId)
  const command = binaryPath || binary

  // Open host terminal at session workdir, then start CLI in a follow-up spawn window when possible.
  const term = await openHostTerminal({ cwd: session.workDir })

  // Best-effort: also spawn the CLI detached in that directory so user sees it quickly.
  try {
    const child = spawn(command, [], {
      cwd: session.workDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      shell: isWindows(),
      env: process.env,
    })
    child.unref()
  } catch {
    // Terminal alone is enough for "usable"
  }

  updateAgentCliSession(session.id, { status: 'running', lastError: null })
  appendAgentCliMessage({
    sessionId: session.id,
    role: 'system',
    content: `Launched host CLI \`${command}\` in ${session.workDir} via ${term.launcher}`,
  })

  return {
    ok: true,
    sessionId: session.id,
    launcher: term.launcher,
    cwd: session.workDir,
    command,
    message: `已在宿主机终端启动 ${def.displayName}（${command}）`,
  }
}

export async function chatWithCli(input: {
  cliId: AgentCliId
  sessionId?: string
  workDir?: string | null
  prompt: string
}): Promise<ChatResult> {
  const def = getAgentCliDefinition(input.cliId)
  if (!def) throw new Error(`Unknown CLI: ${input.cliId}`)
  const prompt = input.prompt.trim()
  if (!prompt) throw new Error('prompt is required')

  let session = input.sessionId ? getAgentCliSession(input.sessionId) : null
  if (!session) {
    session = createAgentCliSession({ cliId: input.cliId, workDir: input.workDir })
  }

  const userMsg = appendAgentCliMessage({
    sessionId: session.id,
    role: 'user',
    content: prompt,
  })

  // manage-only: open host terminal, no fake stream
  if (def.maturity === 'manage-only') {
    await launchHostCli({ cliId: input.cliId, sessionId: session.id })
    const assistant = appendAgentCliMessage({
      sessionId: session.id,
      role: 'assistant',
      content:
        '当前 CLI 成熟度为「仅管理」。已在宿主机打开终端并启动 CLI；请在终端中继续对话。Web 内流式协议未接入。',
    })
    return {
      sessionId: session.id,
      mode: 'manage-only',
      userMessageId: userMsg.id,
      assistantMessageId: assistant.id,
      content: assistant.content,
      maturity: def.maturity,
    }
  }

  const args = buildNonInteractiveArgs(input.cliId, prompt)
  const { binary, path: binaryPath } = resolveDefaultBinary(input.cliId)
  const executable = binaryPath || binary

  if (!args) {
    await launchHostCli({ cliId: input.cliId, sessionId: session.id })
    const assistant = appendAgentCliMessage({
      sessionId: session.id,
      role: 'assistant',
      content: '该 CLI 暂无稳定非交互协议，已打开宿主机终端。',
    })
    return {
      sessionId: session.id,
      mode: 'host-terminal',
      userMessageId: userMsg.id,
      assistantMessageId: assistant.id,
      content: assistant.content,
      maturity: def.maturity,
    }
  }

  updateAgentCliSession(session.id, { status: 'running', lastError: null })
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      cwd: session.workDir,
      timeout: CHAT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      shell: isWindows(),
      env: process.env,
    })
    const text = [stdout?.trim(), stderr?.trim()].filter(Boolean).join('\n\n') || '(empty output)'
    const assistant = appendAgentCliMessage({
      sessionId: session.id,
      role: 'assistant',
      content: text.slice(0, 100_000),
    })
    updateAgentCliSession(session.id, { status: 'idle' })
    return {
      sessionId: session.id,
      mode: 'exec',
      userMessageId: userMsg.id,
      assistantMessageId: assistant.id,
      content: assistant.content,
      maturity: def.maturity,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const any = err as { stdout?: string; stderr?: string }
    const partial = [any.stdout?.trim(), any.stderr?.trim()].filter(Boolean).join('\n\n')
    // Fallback to host terminal on exec failure
    try {
      await launchHostCli({ cliId: input.cliId, sessionId: session.id })
    } catch {
      // ignore secondary failure
    }
    const content =
      (partial ? `${partial}\n\n` : '') +
      `非交互执行失败（${message}）。已尝试打开宿主机终端。`
    const assistant = appendAgentCliMessage({
      sessionId: session.id,
      role: 'assistant',
      content: content.slice(0, 100_000),
    })
    updateAgentCliSession(session.id, { status: 'error', lastError: message })
    return {
      sessionId: session.id,
      mode: 'host-terminal',
      userMessageId: userMsg.id,
      assistantMessageId: assistant.id,
      content: assistant.content,
      maturity: def.maturity,
    }
  }
}

export function getSessionMessagesForCli(sessionId: string) {
  return listAgentCliMessages(sessionId)
}

export async function ensureRuntime(cliId: AgentCliId): Promise<ProbeReport> {
  return probeOne(cliId, { skipLatest: true })
}
