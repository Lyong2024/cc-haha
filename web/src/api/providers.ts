// web/src/api/providers.ts

import { api } from './client'
import type {
  SavedProvider,
  CreateProviderInput,
  UpdateProviderInput,
  TestProviderConfigInput,
  ProviderTestResult,
  ProviderCredentialExport,
  ProviderQuotaSnapshot,
  ProviderAccountInfo,
} from '../types/provider'

type ProvidersResponse = { providers: SavedProvider[]; activeId: string | null }
type ProvidersListResponse = ProvidersResponse & { providerOrder?: string[] }
type ProvidersReorderResponse = { providers: SavedProvider[]; providerOrder?: string[] }
type ProviderResponse = { provider: SavedProvider }
type TestResultResponse = { result: ProviderTestResult }
type AuthStatusResponse = {
  hasAuth: boolean
  source: 'haha-provider' | 'openai-oauth' | 'grok-oauth' | 'original-settings' | 'env' | 'none'
  activeProvider?: string
}

export type ExternalSourceSummary = {
  id: 'claude-code' | 'cc-haha' | 'haha'
  label: string
  path: string
  kind: 'claude-settings' | 'providers-json'
  available: boolean
  candidateCount: number
  isActiveDataDir: boolean
}

export type ExternalProviderCandidate = {
  key: string
  sourceId: ExternalSourceSummary['id']
  sourceLabel: string
  sourcePath: string
  externalId: string
  name: string
  proposedName: string
  nameConflict: boolean
  baseUrl: string
  presetId: string
  apiFormat: string
  maskedKey: string
  fingerprint: string
  alreadyImported: boolean
}

export type ExternalImportResult = {
  imported: Array<{ key: string; id: string; name: string }>
  skipped: Array<{ key: string; reason: string }>
}

export const providersApi = {
  list() {
    return api.get<ProvidersListResponse>('/api/providers')
  },

  authStatus() {
    return api.get<AuthStatusResponse>('/api/providers/auth-status')
  },

  /** Discover Claude Code / cc-haha / sibling haha (read-only). */
  listExternalSources() {
    return api.get<{ activeDataDir: string; sources: ExternalSourceSummary[] }>(
      '/api/providers/external-sources',
    )
  },

  listExternalCandidates() {
    return api.get<{ activeDataDir: string; candidates: ExternalProviderCandidate[] }>(
      '/api/providers/external-candidates',
    )
  },

  /** User opt-in import; conflicts get source-labeled names. */
  importExternal(keys: string[]) {
    return api.post<ExternalImportResult>('/api/providers/external-import', { keys })
  },

  getSettings() {
    return api.get<Record<string, unknown>>('/api/providers/settings')
  },

  updateSettings(settings: Record<string, unknown>) {
    return api.put<{ ok: true }>('/api/providers/settings', settings)
  },

  create(input: CreateProviderInput) {
    return api.post<ProviderResponse>('/api/providers', input)
  },

  update(id: string, input: UpdateProviderInput) {
    return api.put<ProviderResponse>(`/api/providers/${id}`, input)
  },

  delete(id: string) {
    return api.delete<{ ok: true }>(`/api/providers/${id}`)
  },

  activate(id: string) {
    return api.post<{ ok: true }>(`/api/providers/${id}/activate`)
  },

  activateOfficial() {
    return api.post<{ ok: true }>('/api/providers/official')
  },

  reorder(orderedIds: string[]) {
    return api.put<ProvidersReorderResponse>('/api/providers/reorder', { orderedIds })
  },

  test(id: string, overrides?: { baseUrl?: string; modelId?: string; apiFormat?: string; authStrategy?: string }) {
    return api.post<TestResultResponse>(`/api/providers/${id}/test`, overrides)
  },

  testConfig(input: TestProviderConfigInput) {
    return api.post<TestResultResponse>('/api/providers/test', input)
  },

  exportCredentials(id: string) {
    return api.get<ProviderCredentialExport>(`/api/providers/${id}/export`)
  },

  rename(id: string, name: string) {
    return api.post<{ provider: SavedProvider }>(`/api/providers/${id}/rename`, { name })
  },

  syncQuota(id: string) {
    return api.post<{
      provider: SavedProvider
      quotaSnapshot: ProviderQuotaSnapshot
      accountInfo: ProviderAccountInfo
    }>(`/api/providers/${id}/sync-quota`)
  },

  refreshCredential(id: string) {
    return api.post<{
      provider: SavedProvider
      quotaSnapshot: ProviderQuotaSnapshot
      accountInfo: ProviderAccountInfo
      refreshed: boolean
    }>(`/api/providers/${id}/refresh-credential`)
  },
}
