/**
 * System management API (read-only online users).
 */

import { getWebPresenceService } from '../services/webPresenceService.js'
import {
  getWebAuthService,
  readSessionTokenFromRequest,
} from '../services/webAuthService.js'

export async function handleSystemApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  const resource = segments[2] ?? ''

  const token = readSessionTokenFromRequest(req)
  const session = token ? getWebAuthService().validateSession(token) : null
  if (!session) {
    return Response.json(
      { code: 'UNAUTHORIZED', message: 'Not authenticated', error: 'Unauthorized' },
      { status: 401 },
    )
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

  return Response.json(
    { code: 'NOT_FOUND', message: `Unknown system route: ${resource}` },
    { status: 404 },
  )
}
