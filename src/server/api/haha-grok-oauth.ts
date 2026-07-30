import {
  GROK_OAUTH_SUCCESS_HTML,
  hahaGrokOAuthService,
} from '../services/hahaGrokOAuthService.js'
import { errorResponse } from '../middleware/errorHandler.js'

export async function handleHahaGrokOAuthApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const action = segments[2]
    if (action === 'start' && req.method === 'POST') {
      const session = await hahaGrokOAuthService.startSession()
      return Response.json({
        authorizeUrl: session.authorizeUrl,
        state: session.state,
      })
    }

    if (action === 'success' && req.method === 'GET') {
      return new Response(GROK_OAUTH_SUCCESS_HTML, {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/html; charset=utf-8',
        },
      })
    }

    if (action === undefined && req.method === 'GET') {
      // Phase B: logged-in if pool has any account (or legacy single tokens).
      try {
        const { grokAccountPoolService } = await import('../services/grokAccountPoolService.js')
        const pool = await grokAccountPoolService.loadPool()
        if (pool.accounts.length > 0) {
          const tokens = await hahaGrokOAuthService.ensureFreshTokens()
          const preferred = pool.preferredAccountId
            ? pool.accounts.find((a) => a.id === pool.preferredAccountId)
            : null
          return Response.json({
            loggedIn: true,
            expiresAt: tokens?.expiresAt ?? null,
            email: tokens?.email ?? preferred?.email ?? pool.accounts[0]?.email ?? null,
            accountCount: pool.accounts.length,
            preferredAccountId: pool.preferredAccountId,
            strategy: pool.preferredAccountId ? 'preferred' : 'round_robin',
          })
        }
      } catch {
        // fall through
      }
      const tokens = await hahaGrokOAuthService.ensureFreshTokens()
      if (!tokens) return Response.json({ loggedIn: false })
      return Response.json({
        loggedIn: true,
        expiresAt: tokens.expiresAt,
        email: tokens.email,
        accountCount: 1,
        preferredAccountId: null,
        strategy: 'round_robin',
      })
    }

    if (action === undefined && req.method === 'DELETE') {
      hahaGrokOAuthService.dispose()
      await hahaGrokOAuthService.deleteTokens()
      return Response.json({ ok: true })
    }

    return Response.json({ error: 'Not Found' }, { status: 404 })
  } catch (error) {
    return errorResponse(error)
  }
}
