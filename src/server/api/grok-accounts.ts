/**
 * Grok account pool API (Phase B).
 * Routes under /api/providers/grok-official/accounts[...]
 */

import { grokAccountPoolService } from '../services/grokAccountPoolService.js'
import { hahaGrokOAuthService } from '../services/hahaGrokOAuthService.js'
import { probeProviderQuota } from '../services/providerAccountService.js'
import { GROK_OFFICIAL_PROVIDER } from '../services/grokOfficialProvider.js'
import { errorResponse } from '../middleware/errorHandler.js'
import { ApiError } from '../middleware/errorHandler.js'

async function parseJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

export async function handleGrokAccountsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    // Full path segments from router: ['api', 'providers', 'grok-official', 'accounts', id?, action?]
    // Index 3 is always the literal "accounts" — account id starts at index 4.
    const accountId = segments[4]
    const action = segments[5]

    // GET /api/providers/grok-official/accounts
    if (!accountId && req.method === 'GET') {
      // Ensures desktop cc-haha/grok-oauth.json is imported into the pool when empty.
      const pool = await grokAccountPoolService.loadPool()
      return Response.json({
        preferredAccountId: pool.preferredAccountId,
        strategy: pool.preferredAccountId ? 'preferred' : 'round_robin',
        accounts: grokAccountPoolService.toPublicList(pool),
      }, { headers: { 'Cache-Control': 'no-store' } })
    }

    // POST /api/providers/grok-official/accounts/sync-all  (额度同步)
    if (accountId === 'sync-all' && req.method === 'POST') {
      const pool = await grokAccountPoolService.loadPool()
      const prevPreferred = pool.preferredAccountId
      const results: Array<{ id: string; ok: boolean; error?: string }> = []
      for (const acc of pool.accounts) {
        if (!acc.enabled) {
          results.push({ id: acc.id, ok: false, error: 'disabled' })
          continue
        }
        try {
          // Temporarily sticky this account so probeProviderQuota reads its tokens
          await grokAccountPoolService.setPreferred(acc.id)
          const probed = await probeProviderQuota(GROK_OFFICIAL_PROVIDER)
          await grokAccountPoolService.updateQuota(acc.id, probed.quotaSnapshot)
          if (probed.accountInfo.email || probed.accountInfo.accountLabel) {
            await grokAccountPoolService.updateAccountTokens(acc.id, {
              email: probed.accountInfo.email ?? acc.email,
              displayName: probed.accountInfo.accountLabel ?? acc.displayName,
            })
          }
          results.push({ id: acc.id, ok: true })
        } catch (err) {
          results.push({
            id: acc.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      await grokAccountPoolService.setPreferred(prevPreferred)
      const next = await grokAccountPoolService.loadPool()
      return Response.json({
        results,
        preferredAccountId: next.preferredAccountId,
        strategy: next.preferredAccountId ? 'preferred' : 'round_robin',
        accounts: grokAccountPoolService.toPublicList(next),
      })
    }

    // POST /api/providers/grok-official/accounts/refresh-all  (凭据刷新)
    if (accountId === 'refresh-all' && req.method === 'POST') {
      const pool = await grokAccountPoolService.loadPool()
      const prevPreferred = pool.preferredAccountId
      const results: Array<{ id: string; ok: boolean; refreshed?: boolean; error?: string }> = []
      for (const acc of pool.accounts) {
        if (!acc.enabled) {
          results.push({ id: acc.id, ok: false, error: 'disabled' })
          continue
        }
        if (!acc.refreshToken) {
          results.push({ id: acc.id, ok: false, error: 'missing refresh_token' })
          continue
        }
        try {
          await grokAccountPoolService.setPreferred(acc.id)
          const refreshed = await hahaGrokOAuthService.forceRefreshTokens()
          await grokAccountPoolService.updateAccountTokens(acc.id, {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAt,
            idToken: refreshed.idToken,
            email: refreshed.email ?? acc.email,
            clientId: refreshed.clientId,
            displayName: refreshed.displayName ?? acc.displayName,
          })
          results.push({ id: acc.id, ok: true, refreshed: true })
        } catch (err) {
          results.push({
            id: acc.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      await grokAccountPoolService.setPreferred(prevPreferred)
      const next = await grokAccountPoolService.loadPool()
      const okCount = results.filter((r) => r.ok).length
      return Response.json({
        results,
        refreshedCount: okCount,
        preferredAccountId: next.preferredAccountId,
        strategy: next.preferredAccountId ? 'preferred' : 'round_robin',
        accounts: grokAccountPoolService.toPublicList(next),
      })
    }

    // POST /api/providers/grok-official/accounts/:id/refresh  (单账号凭据刷新)
    // handled below after accountId guard

    if (!accountId) {
      return Response.json({ error: 'Not Found' }, { status: 404 })
    }

    // POST /api/providers/grok-official/accounts/:id/prefer
    if (action === 'prefer' && req.method === 'POST') {
      const body = await parseJsonBody(req)
      const clear =
        body && typeof body === 'object' && 'clear' in body
          ? Boolean((body as { clear?: unknown }).clear)
          : false
      const pool = await grokAccountPoolService.setPreferred(clear ? null : accountId)
      return Response.json({
        preferredAccountId: pool.preferredAccountId,
        strategy: pool.preferredAccountId ? 'preferred' : 'round_robin',
        accounts: grokAccountPoolService.toPublicList(pool),
      })
    }

    // POST /api/providers/grok-official/accounts/:id/refresh
    if (action === 'refresh' && req.method === 'POST') {
      const pool = await grokAccountPoolService.loadPool()
      const acc = pool.accounts.find((a) => a.id === accountId)
      if (!acc) throw ApiError.notFound('账号不存在')
      if (!acc.refreshToken) throw ApiError.badRequest('缺少 refresh_token，请重新登录该账号')
      const prevPreferred = pool.preferredAccountId
      await grokAccountPoolService.setPreferred(accountId)
      try {
        const refreshed = await hahaGrokOAuthService.forceRefreshTokens()
        await grokAccountPoolService.updateAccountTokens(accountId, {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: refreshed.expiresAt,
          idToken: refreshed.idToken,
          email: refreshed.email ?? acc.email,
          clientId: refreshed.clientId,
          displayName: refreshed.displayName ?? acc.displayName,
        })
      } finally {
        await grokAccountPoolService.setPreferred(prevPreferred)
      }
      const next = await grokAccountPoolService.loadPool()
      return Response.json({
        refreshed: true,
        accounts: grokAccountPoolService.toPublicList(next),
        account: grokAccountPoolService.toPublicList(next).find((a) => a.id === accountId),
      })
    }

    // POST /api/providers/grok-official/accounts/:id/sync-quota
    if (action === 'sync-quota' && req.method === 'POST') {
      const pool = await grokAccountPoolService.loadPool()
      const acc = pool.accounts.find((a) => a.id === accountId)
      if (!acc) throw ApiError.notFound('账号不存在')
      const prevPreferred = pool.preferredAccountId
      await grokAccountPoolService.setPreferred(accountId)
      try {
        const probed = await probeProviderQuota(GROK_OFFICIAL_PROVIDER)
        await grokAccountPoolService.updateQuota(accountId, probed.quotaSnapshot)
        if (probed.accountInfo.email) {
          await grokAccountPoolService.updateAccountTokens(accountId, {
            email: probed.accountInfo.email,
            displayName: probed.accountInfo.accountLabel ?? acc.displayName,
          })
        }
      } finally {
        await grokAccountPoolService.setPreferred(prevPreferred)
      }
      const next = await grokAccountPoolService.loadPool()
      return Response.json({
        accounts: grokAccountPoolService.toPublicList(next),
        account: grokAccountPoolService.toPublicList(next).find((a) => a.id === accountId),
      })
    }

    // POST /api/providers/grok-official/accounts/:id/logout  (remove one account)
    if ((action === 'logout' || action === 'remove') && req.method === 'POST') {
      const { remaining } = await grokAccountPoolService.removeAccount(accountId)
      if (remaining === 0) {
        hahaGrokOAuthService.dispose()
      }
      const pool = await grokAccountPoolService.loadPool()
      return Response.json({
        ok: true,
        remaining,
        accounts: grokAccountPoolService.toPublicList(pool),
        preferredAccountId: pool.preferredAccountId,
      })
    }

    // POST /api/providers/grok-official/accounts/:id/rename { name }
    if (action === 'rename' && req.method === 'POST') {
      const body = await parseJsonBody(req)
      const name =
        body && typeof body === 'object' && 'name' in body
          ? String((body as { name?: unknown }).name ?? '')
          : ''
      const acc = await grokAccountPoolService.renameAccount(accountId, name)
      const pool = await grokAccountPoolService.loadPool()
      return Response.json({
        account: grokAccountPoolService.toPublicList(pool).find((a) => a.id === acc.id),
        accounts: grokAccountPoolService.toPublicList(pool),
      })
    }

    // DELETE /api/providers/grok-official/accounts/:id
    if (!action && req.method === 'DELETE') {
      const { remaining } = await grokAccountPoolService.removeAccount(accountId)
      if (remaining === 0) hahaGrokOAuthService.dispose()
      const pool = await grokAccountPoolService.loadPool()
      return Response.json({
        ok: true,
        remaining,
        accounts: grokAccountPoolService.toPublicList(pool),
      })
    }

    return Response.json({ error: 'Not Found' }, { status: 404 })
  } catch (error) {
    return errorResponse(error)
  }
}
