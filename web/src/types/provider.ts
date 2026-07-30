// web/src/types/provider.ts

export type ApiFormat = 'anthropic' | 'openai_chat' | 'openai_responses'

export type ProviderAuthStrategy =
  | 'api_key'
  | 'auth_token'
  | 'auth_token_empty_api_key'
  | 'dual_same_token'
  | 'dual_dummy'

export type ProviderRuntimeKind = 'anthropic_compatible' | 'openai_oauth' | 'grok_oauth'

export type ModelMapping = {
  main: string
  fable?: string
  haiku: string
  sonnet: string
  opus: string
}

export type Model1mSupport = {
  main: boolean
  haiku: boolean
  sonnet: boolean
  opus: boolean
}

export type ModelContextWindows = Record<string, number>

export type ProviderAccountInfo = {
  email?: string | null
  accountId?: string | null
  accountLabel?: string | null
  type?: string
}

export type ProviderQuotaSnapshot = {
  syncedAt: string
  source: 'headers' | 'upstream' | 'oauth' | 'unavailable' | 'error'
  remaining?: number | null
  limit?: number | null
  used?: number | null
  usagePercent?: number | null
  weeklyRemaining?: number | null
  weeklyLimit?: number | null
  monthlyRemaining?: number | null
  monthlyLimit?: number | null
  resetAt?: string | null
  credentialExpiresAt?: string | null
  lastRefreshAt?: string | null
  status?: 'ok' | 'limited' | 'error' | 'unknown'
  message?: string | null
}

export type SavedProvider = {
  id: string
  presetId: string
  name: string
  apiKey: string  // stored secret; UI should mask when displaying
  authStrategy?: ProviderAuthStrategy
  baseUrl: string
  apiFormat: ApiFormat
  runtimeKind?: ProviderRuntimeKind
  models: ModelMapping
  model1mSupport?: Model1mSupport
  autoCompactWindow?: number
  modelContextWindows?: ModelContextWindows
  toolSearchEnabled?: boolean
  disableExperimentalBetas?: boolean
  notes?: string
  createdAt?: string
  updatedAt?: string
  accountInfo?: ProviderAccountInfo
  quotaSnapshot?: ProviderQuotaSnapshot
}

export type ProviderCredentialExport = {
  exportedAt: string
  version: 1
  kind?: 'api_key' | 'grok_oauth' | 'openai_oauth'
  filename?: string
  auth?: Record<string, unknown>
  provider: {
    id: string
    presetId: string
    name: string
    baseUrl: string
    apiFormat: ApiFormat
    runtimeKind?: ProviderRuntimeKind
    authStrategy?: ProviderAuthStrategy
    apiKey: string
    models: ModelMapping
    notes?: string
    createdAt?: string
    updatedAt?: string
    accountInfo?: ProviderAccountInfo
    quotaSnapshot?: ProviderQuotaSnapshot
  }
}

export type CreateProviderInput = {
  presetId: string
  name: string
  apiKey: string
  authStrategy?: ProviderAuthStrategy
  baseUrl: string
  apiFormat?: ApiFormat
  runtimeKind?: ProviderRuntimeKind
  models: ModelMapping
  model1mSupport?: Model1mSupport
  autoCompactWindow?: number
  modelContextWindows?: ModelContextWindows
  toolSearchEnabled?: boolean
  disableExperimentalBetas?: boolean
  notes?: string
}

export type UpdateProviderInput = {
  name?: string
  apiKey?: string
  authStrategy?: ProviderAuthStrategy
  baseUrl?: string
  apiFormat?: ApiFormat
  runtimeKind?: ProviderRuntimeKind
  models?: ModelMapping
  model1mSupport?: Model1mSupport | null
  autoCompactWindow?: number | null
  modelContextWindows?: ModelContextWindows | null
  toolSearchEnabled?: boolean
  disableExperimentalBetas?: boolean
  notes?: string
}

export type TestProviderConfigInput = {
  baseUrl: string
  apiKey: string
  modelId: string
  authStrategy?: ProviderAuthStrategy
  apiFormat?: ApiFormat
}

export type ProviderTestStepResult = {
  success: boolean
  latencyMs: number
  error?: string
  modelUsed?: string
  httpStatus?: number
}

export type ProviderTestResult = {
  /** Step 1: Basic connectivity */
  connectivity: ProviderTestStepResult
  /** Step 2: Proxy pipeline (only for openai_* formats) */
  proxy?: ProviderTestStepResult
}
