/**
 * Client for **Grok Official only** multi-account pool.
 * Base path: `/api/providers/grok-official/accounts`
 * Do not reuse for Claude / OpenAI / custom providers.
 */
import { api } from './client'
import type { ProviderQuotaSnapshot } from '../types/provider'

export type GrokAccountPublic = {
  id: string
  email: string | null
  displayName: string | null
  accountType: string
  enabled: boolean
  createdAt: string
  updatedAt: string
  isPreferred: boolean
  isActivePick: boolean
  quotaSnapshot: ProviderQuotaSnapshot | null
  consecutiveFailures: number
  lastOkAt: string | null
  lastErrorAt: string | null
  hasRefreshToken: boolean
  expiresAt: number | null
}

export type GrokAccountsListResponse = {
  preferredAccountId: string | null
  strategy: 'preferred' | 'round_robin'
  accounts: GrokAccountPublic[]
}

const base = '/api/providers/grok-official/accounts'

export const grokAccountsApi = {
  list(): Promise<GrokAccountsListResponse> {
    return api.get<GrokAccountsListResponse>(base)
  },

  /** 额度同步：探测全部账号 billing / 周限 / 月限 */
  syncAll(): Promise<GrokAccountsListResponse & { results: Array<{ id: string; ok: boolean; error?: string }> }> {
    return api.post(`${base}/sync-all`, {})
  },

  /** 凭据刷新：对全部账号 force-refresh OAuth token */
  refreshAll(): Promise<
    GrokAccountsListResponse & {
      results: Array<{ id: string; ok: boolean; refreshed?: boolean; error?: string }>
      refreshedCount: number
    }
  > {
    return api.post(`${base}/refresh-all`, {})
  },

  syncOne(accountId: string): Promise<{ accounts: GrokAccountPublic[]; account?: GrokAccountPublic }> {
    return api.post(`${base}/${accountId}/sync-quota`, {})
  },

  refreshOne(accountId: string): Promise<{
    refreshed: boolean
    accounts: GrokAccountPublic[]
    account?: GrokAccountPublic
  }> {
    return api.post(`${base}/${accountId}/refresh`, {})
  },

  /** Set sticky default; pass clear:true to return to round-robin. */
  setPreferred(accountId: string, clear = false): Promise<GrokAccountsListResponse> {
    return api.post(`${base}/${accountId}/prefer`, { clear })
  },

  logout(accountId: string): Promise<{
    ok: boolean
    remaining: number
    accounts: GrokAccountPublic[]
    preferredAccountId: string | null
  }> {
    return api.post(`${base}/${accountId}/logout`, {})
  },

  rename(accountId: string, name: string): Promise<{ accounts: GrokAccountPublic[] }> {
    return api.post(`${base}/${accountId}/rename`, { name })
  },
}
