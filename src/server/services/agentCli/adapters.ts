/**
 * Unified AgentCliAdapter interface (design §3.3).
 * Claude remains first-class via sessionService; others use SQLite + runtimeService.
 */

import type { MessageEntry } from '../sessionService.js'
import { getAgentCliDefinition } from './registry.js'
import { probeOne } from './probeService.js'
import {
  chatWithCli,
  createSessionForCli,
  getSessionMessagesForCli,
  launchHostCli,
  listSessionsForCli,
  type AgentCliSessionListItem,
  type ChatResult,
  type LaunchResult,
} from './runtimeService.js'
import type { AgentCliId, AgentCliMaturity, ProbeReport } from './types.js'
import { deleteAgentCliSession, getAgentCliSession } from './sessionStore.js'

export type AgentCliAdapter = {
  id: AgentCliId
  maturity: AgentCliMaturity
  supportsStreamingChat: boolean
  probe(): Promise<ProbeReport>
  listSessions(opts?: {
    limit?: number
    offset?: number
  }): Promise<{ sessions: AgentCliSessionListItem[]; total: number }>
  getMessages(sessionId: string): Promise<MessageEntry[]>
  createSession(opts?: {
    workDir?: string | null
    title?: string | null
  }): Promise<{ sessionId: string; workDir: string }>
  ensureRuntime(sessionId?: string): Promise<LaunchResult | { ok: true; note: string }>
  chat?(input: {
    sessionId?: string
    workDir?: string | null
    prompt: string
  }): Promise<ChatResult>
  deleteSession?(sessionId: string): Promise<boolean>
}

function externalMessagesToEntries(
  sessionId: string,
): MessageEntry[] {
  return getSessionMessagesForCli(sessionId).map((m) => ({
    id: m.id,
    type: m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'system',
    content: m.content,
    timestamp: m.timestamp,
  }))
}

function makeExternalAdapter(id: AgentCliId): AgentCliAdapter {
  const def = getAgentCliDefinition(id)
  const maturity = def?.maturity ?? 'manage-only'
  return {
    id,
    maturity,
    supportsStreamingChat: maturity === 'beta',
    async probe() {
      return probeOne(id)
    },
    async listSessions(opts) {
      return listSessionsForCli(id, opts)
    },
    async getMessages(sessionId) {
      const session = getAgentCliSession(sessionId)
      if (!session || session.cliId !== id) return []
      return externalMessagesToEntries(sessionId)
    },
    async createSession(opts) {
      const item = await createSessionForCli(id, opts?.workDir, opts?.title)
      return { sessionId: item.id, workDir: item.workDir ?? process.cwd() }
    },
    async ensureRuntime(sessionId) {
      return launchHostCli({ cliId: id, sessionId })
    },
    async chat(input) {
      return chatWithCli({
        cliId: id,
        sessionId: input.sessionId,
        workDir: input.workDir,
        prompt: input.prompt,
      })
    },
    async deleteSession(sessionId) {
      const session = getAgentCliSession(sessionId)
      if (!session || session.cliId !== id) return false
      return deleteAgentCliSession(sessionId)
    },
  }
}

/** Claude adapter: list/create/messages go through sessionService (caller wires). */
export function makeClaudeAdapter(): AgentCliAdapter {
  return {
    id: 'claude-code',
    maturity: 'full',
    supportsStreamingChat: true,
    async probe() {
      return probeOne('claude-code')
    },
    async listSessions() {
      // Claude sessions are served by /api/sessions with agentCliId filter.
      return { sessions: [], total: 0 }
    },
    async getMessages() {
      return []
    },
    async createSession() {
      throw new Error('Use /api/sessions for Claude session creation')
    },
    async ensureRuntime() {
      return { ok: true, note: 'Claude uses existing conversation WebSocket runtime' }
    },
  }
}

const adapterCache = new Map<AgentCliId, AgentCliAdapter>()

export function getAgentCliAdapter(id: AgentCliId): AgentCliAdapter {
  let adapter = adapterCache.get(id)
  if (adapter) return adapter
  adapter = id === 'claude-code' ? makeClaudeAdapter() : makeExternalAdapter(id)
  adapterCache.set(id, adapter)
  return adapter
}
