/**
 * Provider types — preset-based provider configuration.
 *
 * Providers are stored in ~/.claude/haha/providers.json as a lightweight index.
 * The active provider's env vars are written to ~/.claude/settings.json.
 */

import { z } from 'zod'

export const CLAUDE_OFFICIAL_PROVIDER_ID = 'claude-official'
export const OPENAI_OFFICIAL_PROVIDER_ID = 'openai-official'
export const GROK_OFFICIAL_PROVIDER_ID = 'grok-official'
export const BUILT_IN_PROVIDER_IDS = [
  CLAUDE_OFFICIAL_PROVIDER_ID,
  OPENAI_OFFICIAL_PROVIDER_ID,
  GROK_OFFICIAL_PROVIDER_ID,
] as const

export function isBuiltInProviderId(id: string | null | undefined): boolean {
  return !!id && (BUILT_IN_PROVIDER_IDS as readonly string[]).includes(id)
}

export const ApiFormatSchema = z.enum([
  'anthropic',         // Native Anthropic Messages API (passthrough, no proxy)
  'openai_chat',       // OpenAI Chat Completions /v1/chat/completions
  'openai_responses',  // OpenAI Responses API /v1/responses
])
export type ApiFormat = z.infer<typeof ApiFormatSchema>

export const ProviderAuthStrategySchema = z.enum([
  'api_key',
  'auth_token',
  'auth_token_empty_api_key',
  'dual_same_token',
  'dual_dummy',
])
export type ProviderAuthStrategy = z.infer<typeof ProviderAuthStrategySchema>

export const ProviderRuntimeKindSchema = z.enum([
  'anthropic_compatible',
  'openai_oauth',
  'grok_oauth',
])
export type ProviderRuntimeKind = z.infer<typeof ProviderRuntimeKindSchema>

export const ModelMappingSchema = z.object({
  main: z.string(),
  fable: z.string().optional(),
  haiku: z.string(),
  sonnet: z.string(),
  opus: z.string(),
})

export const Model1mSupportSchema = z.object({
  main: z.boolean(),
  haiku: z.boolean(),
  sonnet: z.boolean(),
  opus: z.boolean(),
})

export const AutoCompactWindowSchema = z.number().int().min(16000).max(10000000)
export const ModelContextWindowsSchema = z.record(
  z.string().min(1),
  z.number().int().min(16000).max(10000000),
)
export const ToolSearchEnabledSchema = z.boolean()
export const DisableExperimentalBetasSchema = z.boolean()

/** Account identity / billing snapshot (inspired by chenyme/grok2api account cards). */
export const ProviderAccountInfoSchema = z.object({
  email: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
  accountLabel: z.string().nullable().optional(),
  /** Human type label: api_key | oauth | auth_token | dual_token | ... */
  type: z.string().optional(),
})

export const ProviderQuotaSnapshotSchema = z.object({
  syncedAt: z.string(),
  source: z.enum(['headers', 'upstream', 'oauth', 'unavailable', 'error']),
  remaining: z.number().nullable().optional(),
  limit: z.number().nullable().optional(),
  used: z.number().nullable().optional(),
  usagePercent: z.number().nullable().optional(),
  weeklyRemaining: z.number().nullable().optional(),
  weeklyLimit: z.number().nullable().optional(),
  monthlyRemaining: z.number().nullable().optional(),
  monthlyLimit: z.number().nullable().optional(),
  resetAt: z.string().nullable().optional(),
  credentialExpiresAt: z.string().nullable().optional(),
  lastRefreshAt: z.string().nullable().optional(),
  status: z.enum(['ok', 'limited', 'error', 'unknown']).optional(),
  message: z.string().nullable().optional(),
})

/** Provenance when a provider was imported from an external source (user opt-in). */
export const ProviderImportedFromSchema = z.object({
  sourceId: z.string(),
  sourceLabel: z.string(),
  sourcePath: z.string().optional(),
  externalId: z.string(),
  fingerprint: z.string().optional(),
  importedAt: z.string(),
})
export type ProviderImportedFrom = z.infer<typeof ProviderImportedFromSchema>

export const SavedProviderSchema = z.object({
  id: z.string(),
  presetId: z.string(),
  name: z.string().min(1),
  apiKey: z.string(),
  authStrategy: ProviderAuthStrategySchema.optional(),
  baseUrl: z.string(),
  apiFormat: ApiFormatSchema.default('anthropic'),
  runtimeKind: ProviderRuntimeKindSchema.default('anthropic_compatible'),
  models: ModelMappingSchema,
  model1mSupport: Model1mSupportSchema.optional(),
  autoCompactWindow: AutoCompactWindowSchema.optional(),
  modelContextWindows: ModelContextWindowsSchema.optional(),
  toolSearchEnabled: ToolSearchEnabledSchema.optional(),
  disableExperimentalBetas: DisableExperimentalBetasSchema.optional(),
  notes: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  accountInfo: ProviderAccountInfoSchema.optional(),
  quotaSnapshot: ProviderQuotaSnapshotSchema.optional(),
  /** Set when user imported from Claude Code / cc-haha / sibling haha. */
  importedFrom: ProviderImportedFromSchema.optional(),
})

export const ProvidersIndexSchema = z.object({
  schemaVersion: z.number().int().positive().optional(),
  activeId: z.string().nullable(),
  providers: z.array(SavedProviderSchema),
  providerOrder: z.array(z.string()).default([]),
})

export const CreateProviderSchema = z.object({
  presetId: z.string().min(1),
  name: z.string().min(1),
  apiKey: z.string(),
  authStrategy: ProviderAuthStrategySchema.optional(),
  baseUrl: z.string(),
  apiFormat: ApiFormatSchema.default('anthropic'),
  runtimeKind: ProviderRuntimeKindSchema.default('anthropic_compatible'),
  models: ModelMappingSchema,
  model1mSupport: Model1mSupportSchema.optional(),
  autoCompactWindow: AutoCompactWindowSchema.optional(),
  modelContextWindows: ModelContextWindowsSchema.optional(),
  toolSearchEnabled: ToolSearchEnabledSchema.optional(),
  disableExperimentalBetas: DisableExperimentalBetasSchema.optional(),
  notes: z.string().optional(),
})

export const UpdateProviderSchema = z.object({
  name: z.string().min(1).optional(),
  apiKey: z.string().optional(),
  authStrategy: ProviderAuthStrategySchema.optional(),
  baseUrl: z.string().optional(),
  apiFormat: ApiFormatSchema.optional(),
  runtimeKind: ProviderRuntimeKindSchema.optional(),
  models: ModelMappingSchema.optional(),
  model1mSupport: Model1mSupportSchema.nullable().optional(),
  autoCompactWindow: AutoCompactWindowSchema.nullable().optional(),
  modelContextWindows: ModelContextWindowsSchema.nullable().optional(),
  toolSearchEnabled: ToolSearchEnabledSchema.optional(),
  disableExperimentalBetas: DisableExperimentalBetasSchema.optional(),
  notes: z.string().optional(),
})

export const TestProviderSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  modelId: z.string().min(1),
  authStrategy: ProviderAuthStrategySchema.optional(),
  apiFormat: ApiFormatSchema.default('anthropic'),
})

export const ReorderProvidersSchema = z.object({
  // A permutation of the display provider ids, including built-in official providers.
  // The legacy saved-provider-only permutation is still accepted by ProviderService.
  orderedIds: z.array(z.string().min(1)).min(1),
})

// TypeScript types
export type ModelMapping = z.infer<typeof ModelMappingSchema>
export type Model1mSupport = z.infer<typeof Model1mSupportSchema>
export type ProviderAccountInfo = z.infer<typeof ProviderAccountInfoSchema>
export type ProviderQuotaSnapshot = z.infer<typeof ProviderQuotaSnapshotSchema>
export type SavedProvider = z.infer<typeof SavedProviderSchema>
export type ProvidersIndex = z.infer<typeof ProvidersIndexSchema>
export type CreateProviderInput = z.infer<typeof CreateProviderSchema>
export type UpdateProviderInput = z.infer<typeof UpdateProviderSchema>
export type TestProviderInput = z.infer<typeof TestProviderSchema>
export type ReorderProvidersInput = z.infer<typeof ReorderProvidersSchema>

export type ProviderCredentialExport = {
  exportedAt: string
  version: 1
  /** api_key (default) | grok_oauth | openai_oauth */
  kind?: 'api_key' | 'grok_oauth' | 'openai_oauth'
  /** Suggested download filename (e.g. auth.json for Grok OAuth). */
  filename?: string
  /** Raw OAuth token file payload when kind is *_oauth (auth.json style). */
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
    model1mSupport?: Model1mSupport
    notes?: string
    createdAt?: string
    updatedAt?: string
    accountInfo?: ProviderAccountInfo
    quotaSnapshot?: ProviderQuotaSnapshot
  }
}

export interface ProviderTestStepResult {
  success: boolean
  latencyMs: number
  error?: string
  modelUsed?: string
  httpStatus?: number
}

export interface ProviderTestResult {
  /** Step 1: Basic connectivity — API reachable, key valid, model exists */
  connectivity: ProviderTestStepResult
  /** Step 2: Proxy pipeline — full Anthropic→OpenAI→Anthropic round-trip (only for openai_* formats) */
  proxy?: ProviderTestStepResult
}
