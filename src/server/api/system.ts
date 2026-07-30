/**
 * System management API (online users + host terminal + Agent CLI management).
 */

import { getWebPresenceService } from '../services/webPresenceService.js'
import {
  getWebAuthService,
  readSessionTokenFromRequest,
} from '../services/webAuthService.js'
import { openHostTerminal } from '../services/hostTerminalService.js'
import {
  forceProbeAgentCli,
  getAgentCliAdapter,
  getAgentCliDetail,
  getAgentCliJob,
  isAgentCliId,
  listAgentCliStatus,
  setActiveAgentCli,
  setDefaultAgentCli,
  startInstall,
  startUpgrade,
  suggestManualInstallCommand,
  type AgentCliId,
  type InstallScope,
} from '../services/agentCli/index.js'
import { deleteAgentCliSession, getAgentCliSession } from '../services/agentCli/sessionStore.js'
import { chatWithCli, getSessionMessagesForCli, launchHostCli } from '../services/agentCli/runtimeService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

function unauthorized(): Response {
  return Response.json(
    { code: 'UNAUTHORIZED', message: 'Not authenticated', error: 'Unauthorized' },
    { status: 401 },
  )
}

function parseCliId(value: string | undefined): AgentCliId {
  if (!value || !isAgentCliId(value)) {
    throw ApiError.badRequest(`Unknown agent CLI id: ${value ?? ''}`)
  }
  return value
}

export async function handleSystemApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const resource = segments[2] ?? ''
    const sub = segments[3]
    const action = segments[4]

    const token = readSessionTokenFromRequest(req)
    const session = token ? getWebAuthService().validateSession(token) : null
    if (!session) {
      return unauthorized()
    }

    if (resource === 'online-users' && req.method === 'GET') {
      try {
        const { refreshImPresenceFromConfig } = await import('../services/webAdapterHost.js')
        await refreshImPresenceFromConfig()
      } catch {
        // Presence enrichment is best-effort.
      }
      const users = getWebPresenceService().listOnlineUsers()
      return Response.json(
        {
          users,
          generatedAt: new Date().toISOString(),
          note: 'Read-only listing of Web sessions and IM activity. Kick is not supported.',
        },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }

    // Open the host OS default terminal (same user as the Bun server process).
    if (resource === 'open-terminal' && req.method === 'POST') {
      let body: { cwd?: string | null } = {}
      try {
        body = (await req.json()) as { cwd?: string | null }
      } catch {
        body = {}
      }
      const result = await openHostTerminal({ cwd: body.cwd })
      return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
    }

    // ── Agent CLI management (S1/S2) ──────────────────────────────────────
    // GET  /api/system/agent-cli
    // GET  /api/system/agent-cli/:id
    // POST /api/system/agent-cli/:id/probe
    // POST /api/system/agent-cli/:id/install
    // POST /api/system/agent-cli/:id/upgrade
    // POST /api/system/agent-cli/active
    // POST /api/system/agent-cli/default
    // GET  /api/system/agent-cli/jobs/:jobId

    if (resource === 'agent-cli') {
      // Jobs poll: /api/system/agent-cli/jobs/:jobId
      if (sub === 'jobs' && action && req.method === 'GET') {
        const job = getAgentCliJob(action)
        if (!job) {
          return Response.json(
            { code: 'NOT_FOUND', message: 'Job not found' },
            { status: 404 },
          )
        }
        return Response.json(job, { headers: { 'Cache-Control': 'no-store' } })
      }

      // Set active CLI
      if (sub === 'active' && req.method === 'POST') {
        let body: { id?: string } = {}
        try {
          body = (await req.json()) as { id?: string }
        } catch {
          body = {}
        }
        const id = parseCliId(body.id)
        const result = setActiveAgentCli(id)
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
      }

      // Set default CLI
      if (sub === 'default' && req.method === 'POST') {
        let body: { id?: string } = {}
        try {
          body = (await req.json()) as { id?: string }
        } catch {
          body = {}
        }
        const id = parseCliId(body.id)
        const result = setDefaultAgentCli(id)
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
      }

      // List all
      if (!sub && req.method === 'GET') {
        const skipLatest = _url.searchParams.get('skipLatest') === '1'
        const data = await listAgentCliStatus({ skipLatest })
        return Response.json(data, { headers: { 'Cache-Control': 'no-store' } })
      }

      // Per-CLI routes
      if (sub && sub !== 'jobs' && sub !== 'active' && sub !== 'default') {
        const id = parseCliId(sub)
        const nestedId = segments[5] // e.g. sessions/:sessionId
        const nestedAction = segments[6]

        if (!action && req.method === 'GET') {
          const detail = await getAgentCliDetail(id)
          return Response.json(detail, { headers: { 'Cache-Control': 'no-store' } })
        }

        if (action === 'probe' && req.method === 'POST') {
          const detail = await forceProbeAgentCli(id)
          return Response.json(detail, { headers: { 'Cache-Control': 'no-store' } })
        }

        // GET/POST /api/system/agent-cli/:id/sessions
        // GET/DELETE /api/system/agent-cli/:id/sessions/:sessionId
        // GET /api/system/agent-cli/:id/sessions/:sessionId/messages
        if (action === 'sessions') {
          if (id === 'claude-code') {
            return Response.json(
              {
                code: 'USE_SESSIONS_API',
                message: 'Claude sessions use /api/sessions?agentCliId=claude-code',
              },
              { status: 400 },
            )
          }
          const adapter = getAgentCliAdapter(id)

          if (!nestedId && req.method === 'GET') {
            const limit = parseInt(_url.searchParams.get('limit') || '100', 10)
            const offset = parseInt(_url.searchParams.get('offset') || '0', 10)
            const page = await adapter.listSessions({ limit, offset })
            return Response.json(page, { headers: { 'Cache-Control': 'no-store' } })
          }

          if (!nestedId && req.method === 'POST') {
            let body: { workDir?: string | null; title?: string | null } = {}
            try {
              body = (await req.json()) as typeof body
            } catch {
              body = {}
            }
            const created = await adapter.createSession({
              workDir: body.workDir,
              title: body.title,
            })
            return Response.json(created, {
              status: 201,
              headers: { 'Cache-Control': 'no-store' },
            })
          }

          if (nestedId && !nestedAction && req.method === 'GET') {
            const session = getAgentCliSession(nestedId)
            if (!session || session.cliId !== id) {
              return Response.json(
                { code: 'NOT_FOUND', message: 'Session not found' },
                { status: 404 },
              )
            }
            return Response.json(session, { headers: { 'Cache-Control': 'no-store' } })
          }

          if (nestedId && !nestedAction && req.method === 'DELETE') {
            const ok = deleteAgentCliSession(nestedId)
            if (!ok) {
              return Response.json(
                { code: 'NOT_FOUND', message: 'Session not found' },
                { status: 404 },
              )
            }
            return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
          }

          if (nestedId && nestedAction === 'messages' && req.method === 'GET') {
            const session = getAgentCliSession(nestedId)
            if (!session || session.cliId !== id) {
              return Response.json(
                { code: 'NOT_FOUND', message: 'Session not found' },
                { status: 404 },
              )
            }
            return Response.json(
              { messages: getSessionMessagesForCli(nestedId) },
              { headers: { 'Cache-Control': 'no-store' } },
            )
          }
        }

        // POST /api/system/agent-cli/:id/launch
        if (action === 'launch' && req.method === 'POST') {
          if (id === 'claude-code') {
            return Response.json(
              { code: 'NOT_SUPPORTED', message: 'Claude uses in-app chat runtime' },
              { status: 400 },
            )
          }
          let body: { sessionId?: string; workDir?: string | null } = {}
          try {
            body = (await req.json()) as typeof body
          } catch {
            body = {}
          }
          const result = await launchHostCli({
            cliId: id,
            sessionId: body.sessionId,
            workDir: body.workDir,
          })
          return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
        }

        // POST /api/system/agent-cli/:id/chat  (graded S6)
        if (action === 'chat' && req.method === 'POST') {
          if (id === 'claude-code') {
            return Response.json(
              { code: 'NOT_SUPPORTED', message: 'Claude uses /api/sessions chat WebSocket' },
              { status: 400 },
            )
          }
          let body: {
            sessionId?: string
            workDir?: string | null
            prompt?: string
          } = {}
          try {
            body = (await req.json()) as typeof body
          } catch {
            body = {}
          }
          if (!body.prompt?.trim()) {
            throw ApiError.badRequest('prompt is required')
          }
          const result = await chatWithCli({
            cliId: id,
            sessionId: body.sessionId,
            workDir: body.workDir,
            prompt: body.prompt,
          })
          return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
        }

        if ((action === 'install' || action === 'upgrade') && req.method === 'POST') {
          let body: {
            scope?: InstallScope
            version?: string | null
            confirmSystem?: boolean
          } = {}
          try {
            body = (await req.json()) as typeof body
          } catch {
            body = {}
          }
          const scope = body.scope === 'system' ? 'system' : 'user'
          if (scope === 'system' && !body.confirmSystem) {
            const manual = suggestManualInstallCommand(id, action, body.version)
            return Response.json(
              {
                code: 'CONFIRM_REQUIRED',
                message: 'System-scope install requires confirmSystem: true',
                manualCommand: manual,
                risk:
                  '系统级安装会写入全局 npm/系统目录，可能需要管理员权限。Windows 若无法静默 UAC，请在管理员终端执行 manualCommand。',
              },
              { status: 400 },
            )
          }
          const job =
            action === 'install'
              ? startInstall(id, {
                  scope,
                  version: body.version,
                  confirmSystem: body.confirmSystem,
                })
              : startUpgrade(id, {
                  scope,
                  version: body.version,
                  confirmSystem: body.confirmSystem,
                })
          return Response.json(
            { jobId: job.id, job, manualCommand: suggestManualInstallCommand(id, action, body.version) },
            { status: 202, headers: { 'Cache-Control': 'no-store' } },
          )
        }
      }

      return Response.json(
        { code: 'NOT_FOUND', message: `Unknown agent-cli route` },
        { status: 404 },
      )
    }

    return Response.json(
      { code: 'NOT_FOUND', message: `Unknown system route: ${resource}` },
      { status: 404 },
    )
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error)
    return errorResponse(error)
  }
}
