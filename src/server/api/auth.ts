/**
 * Pure-web admin auth API: status / setup / login / logout / me
 */

import {
  getWebAuthService,
  isWebAuthEnforced,
  readSessionTokenFromRequest,
  WEB_SESSION_COOKIE,
} from '../services/webAuthService.js'
import { getWebPresenceService } from '../services/webPresenceService.js'

function json(
  body: unknown,
  init?: { status?: number; headers?: HeadersInit },
): Response {
  return Response.json(body, {
    status: init?.status ?? 200,
    headers: {
      'Cache-Control': 'no-store',
      ...init?.headers,
    },
  })
}

function clientMeta(req: Request, clientAddress?: string | null) {
  return {
    ip: clientAddress ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: req.headers.get('user-agent'),
  }
}

function errorBody(code: string, message: string, status: number): Response {
  return json({ code, message, error: message }, { status })
}

export async function handleAuthApi(
  req: Request,
  url: URL,
  segments: string[],
  context?: { clientAddress?: string | null },
): Promise<Response> {
  const action = segments[2] ?? ''
  const auth = getWebAuthService()
  const secure = url.protocol === 'https:'

  if (action === 'status' && req.method === 'GET') {
    const token = readSessionTokenFromRequest(req)
    return json(auth.getStatus(token))
  }

  if (action === 'setup' && req.method === 'POST') {
    let body: { username?: string; password?: string; confirmPassword?: string }
    try {
      body = (await req.json()) as {
        username?: string
        password?: string
        confirmPassword?: string
      }
    } catch {
      return errorBody('VALIDATION', 'Invalid JSON body', 400)
    }
    if (
      typeof body.confirmPassword === 'string' &&
      body.confirmPassword !== (body.password ?? '')
    ) {
      return errorBody('VALIDATION', 'Passwords do not match', 400)
    }
    try {
      const result = auth.setupAdmin(
        {
          username: body.username ?? '',
          password: body.password ?? '',
        },
        clientMeta(req, context?.clientAddress),
      )
      getWebPresenceService().touchWebSession(result.session.id, {
        ip: result.session.ip,
        userAgent: result.session.userAgent,
        identity: auth.getAdminUsername() ?? body.username ?? 'admin',
      })
      return json(
        {
          ok: true,
          authenticated: true,
          username: auth.getAdminUsername(),
        },
        {
          headers: {
            'Set-Cookie': auth.buildSessionCookie(result.token, { secure }),
          },
        },
      )
    } catch (error) {
      const code = (error as { code?: string }).code
      const message = error instanceof Error ? error.message : 'Setup failed'
      if (code === 'CONFLICT') return errorBody('FORBIDDEN', message, 409)
      if (code === 'VALIDATION') return errorBody('VALIDATION', message, 400)
      return errorBody('INTERNAL', message, 500)
    }
  }

  if (action === 'login' && req.method === 'POST') {
    let body: { username?: string; password?: string }
    try {
      body = (await req.json()) as { username?: string; password?: string }
    } catch {
      return errorBody('VALIDATION', 'Invalid JSON body', 400)
    }
    try {
      const result = auth.login(
        {
          username: body.username ?? '',
          password: body.password ?? '',
        },
        clientMeta(req, context?.clientAddress),
      )
      getWebPresenceService().touchWebSession(result.session.id, {
        ip: result.session.ip,
        userAgent: result.session.userAgent,
        identity: auth.getAdminUsername() ?? body.username ?? 'admin',
      })
      return json(
        {
          ok: true,
          authenticated: true,
          username: auth.getAdminUsername(),
        },
        {
          headers: {
            'Set-Cookie': auth.buildSessionCookie(result.token, { secure }),
          },
        },
      )
    } catch (error) {
      const code = (error as { code?: string }).code
      const message = error instanceof Error ? error.message : 'Login failed'
      if (code === 'SETUP_REQUIRED') return errorBody('SETUP_REQUIRED', message, 409)
      if (code === 'UNAUTHORIZED') return errorBody('UNAUTHORIZED', message, 401)
      return errorBody('INTERNAL', message, 500)
    }
  }

  if (action === 'logout' && req.method === 'POST') {
    const token = readSessionTokenFromRequest(req)
    if (token) auth.logout(token)
    return json(
      { ok: true },
      {
        headers: {
          'Set-Cookie': auth.buildClearSessionCookie(),
        },
      },
    )
  }

  if (action === 'me' && req.method === 'GET') {
    const token = readSessionTokenFromRequest(req)
    const session = token ? auth.validateSession(token) : null
    if (!session) {
      return errorBody('UNAUTHORIZED', 'Not authenticated', 401)
    }
    const username = auth.getAdminUsername()
    getWebPresenceService().touchWebSession(session.id, {
      ip: session.ip,
      userAgent: session.userAgent,
      identity: username ?? 'admin',
    })
    return json({
      authenticated: true,
      role: 'admin',
      username,
      session: {
        id: session.id,
        ip: session.ip,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
      },
      webAuthEnforced: isWebAuthEnforced(),
      cookie: WEB_SESSION_COOKIE,
    })
  }

  return errorBody('NOT_FOUND', `Unknown auth route: ${action}`, 404)
}

/** Paths under /api/auth that stay public when web auth is enforced. */
export function isPublicAuthPath(pathname: string, method: string): boolean {
  if (!pathname.startsWith('/api/auth')) return false
  const action = pathname.split('/').filter(Boolean)[2] ?? ''
  if (action === 'status' && method === 'GET') return true
  if (action === 'setup' && method === 'POST') return true
  if (action === 'login' && method === 'POST') return true
  return false
}
