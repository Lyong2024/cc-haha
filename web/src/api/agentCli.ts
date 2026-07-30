import { api } from './client'

export type AgentCliId =
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'kimi'
  | 'grok'
  | 'mistral'
  | 'opencode'
  | 'pi'

export type AgentCliMaturity = 'full' | 'beta' | 'manage-only'

export type ToolInstallRow = {
  path: string
  version: string | null
  source: string
  isPathDefault: boolean
  runnable: boolean
  error?: string
}

export type ProbeReport = {
  id: AgentCliId
  displayName: string
  installed: boolean
  runnable: boolean
  localVersion: string | null
  latestVersion: string | null
  installedButBroken: boolean
  installs: ToolInstallRow[]
  hasConflict: boolean
  maturity: AgentCliMaturity
  npmPackage: string | null
  upgradeAvailable: boolean
  error: string | null
  probedAt: string
}

export type AgentCliListResponse = {
  tools: ProbeReport[]
  activeId: AgentCliId
  defaultId: AgentCliId
  anyInstalled: boolean
  anyRunnable: boolean
  generatedAt: string
}

export type AgentCliJob = {
  id: string
  cliId: AgentCliId
  action: 'install' | 'upgrade'
  scope: 'user' | 'system'
  version: string | null
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  log: string
  error: string | null
  createdAt: string
  updatedAt: string
}

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
  workspaceState: string
  agentCliId: AgentCliId
  status: string
  maturity: AgentCliMaturity
  supportsStreamingChat: boolean
}

export type AgentCliMessage = {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
}

export type AgentCliChatResult = {
  sessionId: string
  mode: 'exec' | 'host-terminal' | 'manage-only'
  userMessageId: string
  assistantMessageId: string | null
  content: string
  maturity: AgentCliMaturity
}

export type AgentCliLaunchResult = {
  ok: true
  sessionId: string
  launcher: string
  cwd: string
  command: string
  message: string
}

const ACTIVE_STORAGE_KEY = 'haha-active-agent-cli'

export function readLocalActiveAgentCli(): AgentCliId | null {
  try {
    const value = sessionStorage.getItem(ACTIVE_STORAGE_KEY)
    if (!value) return null
    return value as AgentCliId
  } catch {
    return null
  }
}

export function writeLocalActiveAgentCli(id: AgentCliId): void {
  try {
    sessionStorage.setItem(ACTIVE_STORAGE_KEY, id)
  } catch {
    // ignore
  }
}

export const agentCliApi = {
  list(skipLatest = false) {
    const q = skipLatest ? '?skipLatest=1' : ''
    return api.get<AgentCliListResponse>(`/api/system/agent-cli${q}`)
  },
  get(id: AgentCliId) {
    return api.get<ProbeReport>(`/api/system/agent-cli/${id}`)
  },
  probe(id: AgentCliId) {
    return api.post<ProbeReport>(`/api/system/agent-cli/${id}/probe`, {})
  },
  setActive(id: AgentCliId) {
    writeLocalActiveAgentCli(id)
    return api.post<{ activeId: AgentCliId }>('/api/system/agent-cli/active', { id })
  },
  setDefault(id: AgentCliId) {
    return api.post<{ defaultId: AgentCliId }>('/api/system/agent-cli/default', { id })
  },
  install(id: AgentCliId, opts?: {
    scope?: 'user' | 'system'
    version?: string | null
    confirmSystem?: boolean
  }) {
    return api.post<{ jobId: string; job: AgentCliJob; manualCommand?: string | null }>(
      `/api/system/agent-cli/${id}/install`,
      {
        scope: opts?.scope ?? 'user',
        version: opts?.version ?? 'latest',
        confirmSystem: opts?.confirmSystem,
      },
    )
  },
  upgrade(id: AgentCliId, opts?: {
    scope?: 'user' | 'system'
    version?: string | null
    confirmSystem?: boolean
  }) {
    return api.post<{ jobId: string; job: AgentCliJob; manualCommand?: string | null }>(
      `/api/system/agent-cli/${id}/upgrade`,
      {
        scope: opts?.scope ?? 'user',
        version: opts?.version ?? 'latest',
        confirmSystem: opts?.confirmSystem,
      },
    )
  },
  getJob(jobId: string) {
    return api.get<AgentCliJob>(`/api/system/agent-cli/jobs/${jobId}`)
  },
  listSessions(id: AgentCliId, params?: { limit?: number; offset?: number }) {
    const q = new URLSearchParams()
    if (params?.limit != null) q.set('limit', String(params.limit))
    if (params?.offset != null) q.set('offset', String(params.offset))
    const qs = q.toString()
    return api.get<{ sessions: AgentCliSessionListItem[]; total: number }>(
      `/api/system/agent-cli/${id}/sessions${qs ? `?${qs}` : ''}`,
    )
  },
  createSession(id: AgentCliId, body?: { workDir?: string | null; title?: string | null }) {
    return api.post<{ sessionId: string; workDir: string }>(
      `/api/system/agent-cli/${id}/sessions`,
      body ?? {},
    )
  },
  deleteSession(id: AgentCliId, sessionId: string) {
    return api.delete<{ ok: boolean }>(`/api/system/agent-cli/${id}/sessions/${sessionId}`)
  },
  getMessages(id: AgentCliId, sessionId: string) {
    return api.get<{ messages: AgentCliMessage[] }>(
      `/api/system/agent-cli/${id}/sessions/${sessionId}/messages`,
    )
  },
  launch(id: AgentCliId, body?: { sessionId?: string; workDir?: string | null }) {
    return api.post<AgentCliLaunchResult>(`/api/system/agent-cli/${id}/launch`, body ?? {})
  },
  chat(id: AgentCliId, body: {
    sessionId?: string
    workDir?: string | null
    prompt: string
  }) {
    return api.post<AgentCliChatResult>(`/api/system/agent-cli/${id}/chat`, body)
  },
}
