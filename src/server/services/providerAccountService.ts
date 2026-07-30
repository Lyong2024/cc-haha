/**
 * Provider account metadata, credential export, and quota sync.
 * UX patterns inspired by chenyme/grok2api account cards
 * (quota windows, billing snapshot, credential renewal).
 */

import type {
  ProviderAccountInfo,
  ProviderCredentialExport,
  ProviderQuotaSnapshot,
  SavedProvider,
} from '../types/provider.js'
import {
  getNetworkProxyFetchOptions,
  loadNetworkSettings,
} from './networkSettings.js'
import { hahaGrokOAuthService } from './hahaGrokOAuthService.js'
import { hahaOpenAIOAuthService } from './hahaOpenAIOAuthService.js'
import { isGrokOfficialProviderId } from './grokOfficialProvider.js'
import { isOpenAIOfficialProviderId } from './openaiOfficialProvider.js'
import type { ProviderAuthStrategy } from '../types/provider.js'
import {
  buildGrokIdentityHeaders,
  GROK_CLI_BASE_URL,
} from '../../services/grokAuth/fetch.js'

function buildAnthropicAuthHeaders(
  apiKey: string,
  authStrategy: ProviderAuthStrategy,
): Record<string, string> {
  switch (authStrategy) {
    case 'auth_token':
    case 'auth_token_empty_api_key':
      return { Authorization: `Bearer ${apiKey}` }
    case 'dual_same_token':
    case 'dual_dummy':
      return { 'x-api-key': apiKey, Authorization: `Bearer ${apiKey}` }
    case 'api_key':
    default:
      return { 'x-api-key': apiKey }
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function parseNumberHeader(value: string | null): number | null {
  if (!value) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function headerGet(headers: Headers, names: string[]): string | null {
  for (const name of names) {
    const v = headers.get(name)
    if (v != null && v !== '') return v
  }
  return null
}

/** Parse common rate-limit / quota headers from provider responses. */
export function parseQuotaHeaders(headers: Headers): Partial<ProviderQuotaSnapshot> {
  const remaining = parseNumberHeader(
    headerGet(headers, [
      'x-ratelimit-remaining',
      'x-ratelimit-remaining-requests',
      'anthropic-ratelimit-requests-remaining',
      'x-ratelimit-remaining-tokens',
      'anthropic-ratelimit-tokens-remaining',
    ]),
  )
  const limit = parseNumberHeader(
    headerGet(headers, [
      'x-ratelimit-limit',
      'x-ratelimit-limit-requests',
      'anthropic-ratelimit-requests-limit',
      'x-ratelimit-limit-tokens',
      'anthropic-ratelimit-tokens-limit',
    ]),
  )
  const resetRaw = headerGet(headers, [
    'x-ratelimit-reset',
    'x-ratelimit-reset-requests',
    'anthropic-ratelimit-requests-reset',
    'x-ratelimit-reset-tokens',
  ])
  let resetAt: string | null = null
  if (resetRaw) {
    const asNum = Number(resetRaw)
    if (Number.isFinite(asNum) && asNum > 1_000_000_000) {
      // unix seconds or ms
      resetAt = new Date(asNum > 1e12 ? asNum : asNum * 1000).toISOString()
    } else {
      const parsed = Date.parse(resetRaw)
      if (!Number.isNaN(parsed)) resetAt = new Date(parsed).toISOString()
    }
  }

  const weeklyRemaining = parseNumberHeader(
    headerGet(headers, [
      'x-ratelimit-remaining-week',
      'x-quota-remaining-week',
      'x-weekly-remaining',
    ]),
  )
  const weeklyLimit = parseNumberHeader(
    headerGet(headers, [
      'x-ratelimit-limit-week',
      'x-quota-limit-week',
      'x-weekly-limit',
    ]),
  )
  const monthlyRemaining = parseNumberHeader(
    headerGet(headers, [
      'x-ratelimit-remaining-month',
      'x-quota-remaining-month',
      'x-monthly-remaining',
    ]),
  )
  const monthlyLimit = parseNumberHeader(
    headerGet(headers, [
      'x-ratelimit-limit-month',
      'x-quota-limit-month',
      'x-monthly-limit',
    ]),
  )

  let usagePercent: number | null = null
  if (remaining != null && limit != null && limit > 0) {
    usagePercent = Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100))
  }

  const used =
    remaining != null && limit != null && limit >= remaining
      ? limit - remaining
      : null

  return {
    remaining,
    limit,
    used,
    usagePercent,
    weeklyRemaining,
    weeklyLimit,
    monthlyRemaining,
    monthlyLimit,
    resetAt,
  }
}

export function resolveAccountType(provider: SavedProvider): string {
  if (provider.runtimeKind === 'grok_oauth') return 'oauth/grok'
  if (provider.runtimeKind === 'openai_oauth') return 'oauth/openai'
  if (provider.authStrategy) return provider.authStrategy
  if (provider.apiFormat === 'anthropic') return 'api_key'
  return provider.apiFormat || 'api_key'
}

export function maskApiKey(apiKey: string): string {
  const key = apiKey.trim()
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

export function buildCredentialExport(provider: SavedProvider): ProviderCredentialExport {
  return {
    exportedAt: nowIso(),
    version: 1,
    kind: 'api_key',
    filename: `provider-${provider.id}.json`,
    provider: {
      id: provider.id,
      presetId: provider.presetId,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiFormat: provider.apiFormat ?? 'anthropic',
      ...(provider.runtimeKind ? { runtimeKind: provider.runtimeKind } : {}),
      ...(provider.authStrategy ? { authStrategy: provider.authStrategy } : {}),
      apiKey: provider.apiKey,
      models: provider.models,
      ...(provider.model1mSupport ? { model1mSupport: provider.model1mSupport } : {}),
      ...(provider.notes ? { notes: provider.notes } : {}),
      ...(provider.createdAt ? { createdAt: provider.createdAt } : {}),
      ...(provider.updatedAt ? { updatedAt: provider.updatedAt } : {}),
      ...(provider.accountInfo ? { accountInfo: provider.accountInfo } : {}),
      ...(provider.quotaSnapshot ? { quotaSnapshot: provider.quotaSnapshot } : {}),
    },
  }
}

/** Grok official OAuth → auth.json style export (grok2api-compatible fields). */
export function buildGrokOAuthCredentialExport(
  provider: SavedProvider,
  tokens: {
    accessToken: string
    refreshToken: string | null
    expiresAt: number | null
    idToken?: string | null
    email: string | null
    clientId?: string | null
    displayName?: string | null
    createdAt?: string | null
  },
  filePath: string,
): ProviderCredentialExport {
  const auth = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    idToken: tokens.idToken ?? null,
    email: tokens.email,
    clientId: tokens.clientId ?? null,
    displayName: tokens.displayName ?? null,
    createdAt: tokens.createdAt ?? null,
  }
  return {
    exportedAt: nowIso(),
    version: 1,
    kind: 'grok_oauth',
    filename: 'auth.json',
    auth: {
      ...auth,
      sourcePath: filePath,
    },
    provider: {
      id: provider.id,
      presetId: provider.presetId,
      name: tokens.displayName?.trim() || provider.name,
      baseUrl: provider.baseUrl,
      apiFormat: provider.apiFormat ?? 'openai_chat',
      runtimeKind: 'grok_oauth',
      ...(provider.authStrategy ? { authStrategy: provider.authStrategy } : {}),
      // OAuth bearer is the credential surface (not a static API key).
      apiKey: tokens.accessToken,
      models: provider.models,
      ...(tokens.createdAt ? { createdAt: tokens.createdAt } : {}),
      accountInfo: {
        type: 'oauth/grok',
        email: tokens.email,
        accountLabel: tokens.displayName || tokens.email || 'Grok OAuth',
      },
    },
  }
}

/**
 * Grok CLI proxy (`cli-chat-proxy.grok.com`) does NOT put rate-limit headers on
 * GET /v1/models. Quota lives in GET /v1/billing?format=credits (aligned with
 * grok2api): monthly included budget + weekly creditUsagePercent / currentPeriod.
 * Account profile is GET /v1/user.
 */
export type GrokBillingQuota = {
  monthlyLimit: number | null
  used: number | null
  remaining: number | null
  usagePercent: number | null
  billingPeriodStart: string | null
  billingPeriodEnd: string | null
  onDemandCap: number | null
  /** 0–100 weekly credit usage from format=credits (grok2api CreditUsagePercent). */
  creditUsagePercent: number | null
  usagePeriodType: string | null
  usagePeriodStart: string | null
  usagePeriodEnd: string | null
  /**
   * Weekly window as percent pool (limit=100, remaining=100-creditUsagePercent),
   * matching grok2api BuildQuota for USAGE_PERIOD_TYPE_WEEKLY / unit "percent".
   */
  weeklyRemaining: number | null
  weeklyLimit: number | null
  planName: string | null
}

function readBillingNumber(
  source: Record<string, unknown>,
  key: string,
): number | null {
  const node = source[key]
  if (typeof node === 'number' && Number.isFinite(node)) return node
  if (typeof node === 'string' && node.trim() !== '' && Number.isFinite(Number(node))) {
    return Number(node)
  }
  if (node && typeof node === 'object' && 'val' in node) {
    const v = (node as { val?: unknown }).val
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  }
  return null
}

function firstBillingNumber(
  config: Record<string, unknown>,
  root: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const fromConfig = readBillingNumber(config, key)
    if (fromConfig != null) return fromConfig
    if (config !== root) {
      const fromRoot = readBillingNumber(root, key)
      if (fromRoot != null) return fromRoot
    }
  }
  return null
}

function firstBillingString(
  config: Record<string, unknown>,
  root: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const c = config[key]
    if (typeof c === 'string' && c) return c
    if (config !== root) {
      const r = root[key]
      if (typeof r === 'string' && r) return r
    }
  }
  return null
}

function isWeeklyUsagePeriod(usagePeriodType: string | null): boolean {
  return typeof usagePeriodType === 'string'
    && usagePeriodType.toUpperCase().includes('WEEKLY')
}

/**
 * Map credits-format weekly usage into remaining/limit for UI progress bars.
 * grok2api presents weekly as a percent pool of 100 (not absolute credits).
 */
export function deriveWeeklyQuotaFromCredits(
  creditUsagePercent: number | null,
  usagePeriodType: string | null,
): { weeklyRemaining: number | null; weeklyLimit: number | null } {
  if (creditUsagePercent == null && !isWeeklyUsagePeriod(usagePeriodType)) {
    return { weeklyRemaining: null, weeklyLimit: null }
  }
  const usedPct = Math.max(0, Math.min(100, creditUsagePercent ?? 0))
  return {
    weeklyLimit: 100,
    weeklyRemaining: Math.max(0, 100 - usedPct),
  }
}

export function parseGrokBillingBody(body: unknown): GrokBillingQuota {
  const empty: GrokBillingQuota = {
    monthlyLimit: null,
    used: null,
    remaining: null,
    usagePercent: null,
    billingPeriodStart: null,
    billingPeriodEnd: null,
    onDemandCap: null,
    creditUsagePercent: null,
    usagePeriodType: null,
    usagePeriodStart: null,
    usagePeriodEnd: null,
    weeklyRemaining: null,
    weeklyLimit: null,
    planName: null,
  }
  if (!body || typeof body !== 'object') return empty
  const root = body as Record<string, unknown>
  const config =
    root.config && typeof root.config === 'object'
      ? (root.config as Record<string, unknown>)
      : root

  const monthlyLimit = firstBillingNumber(config, root, ['monthlyLimit', 'monthly_limit'])
  const used = firstBillingNumber(config, root, ['used', 'totalUsed', 'includedUsed'])
  const onDemandCap = firstBillingNumber(config, root, [
    'onDemandCap',
    'on_demand_cap',
    'maxAmountPerMonth',
  ])
  const billingPeriodStart = firstBillingString(config, root, [
    'billingPeriodStart',
    'billing_period_start',
  ])
  const billingPeriodEnd = firstBillingString(config, root, [
    'billingPeriodEnd',
    'billing_period_end',
  ])

  // format=credits: weekly window lives on currentPeriod + creditUsagePercent
  // (see temp/grok2api/.../cli/billing.go parseBilling).
  const creditUsagePercent = firstBillingNumber(config, root, [
    'creditUsagePercent',
    'credit_usage_percent',
  ])
  let usagePeriodType: string | null = null
  let usagePeriodStart: string | null = null
  let usagePeriodEnd: string | null = null
  const currentPeriodRaw = config.currentPeriod ?? root.currentPeriod
  if (currentPeriodRaw && typeof currentPeriodRaw === 'object') {
    const period = currentPeriodRaw as Record<string, unknown>
    usagePeriodType = typeof period.type === 'string' ? period.type : null
    usagePeriodStart = typeof period.start === 'string' ? period.start : null
    usagePeriodEnd = typeof period.end === 'string' ? period.end : null
  }

  // Prefer explicit remaining when present (grok2api Billing.Remaining / stored DTO).
  const remainingFromBody = firstBillingNumber(config, root, ['remaining'])
  let remaining: number | null = remainingFromBody
  let usagePercent: number | null = null
  if (monthlyLimit != null && used != null) {
    if (remaining == null) {
      remaining = Math.max(0, monthlyLimit - used)
    }
    if (monthlyLimit > 0) {
      usagePercent = Math.max(0, Math.min(100, (used / monthlyLimit) * 100))
    }
  } else if (monthlyLimit != null && monthlyLimit > 0 && remaining != null) {
    usagePercent = Math.max(
      0,
      Math.min(100, ((monthlyLimit - remaining) / monthlyLimit) * 100),
    )
  }

  const { weeklyRemaining, weeklyLimit } = deriveWeeklyQuotaFromCredits(
    creditUsagePercent,
    usagePeriodType,
  )

  const planName =
    firstBillingString(config, root, [
      'planName',
      'plan_name',
      'subscriptionName',
      'subscription_name',
      'subscriptionTier',
      'subscription_tier',
    ])
    || (() => {
      const sub = root.subscription ?? config.subscription
      if (sub && typeof sub === 'object') {
        const s = sub as Record<string, unknown>
        if (typeof s.name === 'string' && s.name) return s.name
      }
      return null
    })()

  return {
    monthlyLimit,
    used,
    remaining,
    usagePercent,
    billingPeriodStart,
    billingPeriodEnd,
    onDemandCap,
    creditUsagePercent,
    usagePeriodType,
    usagePeriodStart,
    usagePeriodEnd,
    weeklyRemaining,
    weeklyLimit,
    planName,
  }
}

/** True when billing exposes a real monthly included pool (not zero placeholders). */
export function hasMonthlyBillingPool(q: GrokBillingQuota): boolean {
  return (q.monthlyLimit != null && q.monthlyLimit > 0)
    || (q.used != null && q.monthlyLimit != null)
    || (q.remaining != null && q.monthlyLimit != null && q.monthlyLimit > 0)
}

/**
 * Merge format=credits (weekly) with default /billing (monthly).
 *
 * Observed upstream shapes:
 * - default /billing → monthlyLimit/used/billingPeriod*
 * - format=credits → creditUsagePercent + USAGE_PERIOD_TYPE_WEEKLY currentPeriod
 * - some accounts return both in one body (grok2api stores that full snapshot)
 *
 * Dual-fetch ensures the UI can show 周限 + 月限 together like grok2api.
 */
export function mergeGrokBillingQuotas(
  credits: GrokBillingQuota,
  monthly: GrokBillingQuota | null | undefined = null,
): GrokBillingQuota {
  const monthlySource = hasMonthlyBillingPool(credits)
    ? credits
    : (monthly && hasMonthlyBillingPool(monthly) ? monthly : credits)
  const fallback = monthly ?? emptyGrokBillingQuota()

  const monthlyLimit = monthlySource.monthlyLimit ?? credits.monthlyLimit ?? fallback.monthlyLimit
  const used = monthlySource.used ?? credits.used ?? fallback.used
  let remaining = monthlySource.remaining ?? credits.remaining ?? fallback.remaining
  let usagePercent = monthlySource.usagePercent ?? credits.usagePercent ?? fallback.usagePercent
  if (remaining == null && monthlyLimit != null && used != null) {
    remaining = Math.max(0, monthlyLimit - used)
  }
  if (usagePercent == null && monthlyLimit != null && monthlyLimit > 0 && used != null) {
    usagePercent = Math.max(0, Math.min(100, (used / monthlyLimit) * 100))
  }

  const creditUsagePercent =
    credits.creditUsagePercent ?? fallback.creditUsagePercent
  const usagePeriodType = credits.usagePeriodType ?? fallback.usagePeriodType
  const usagePeriodStart = credits.usagePeriodStart ?? fallback.usagePeriodStart
  const usagePeriodEnd = credits.usagePeriodEnd ?? fallback.usagePeriodEnd
  const weekly =
    credits.weeklyLimit != null || credits.weeklyRemaining != null
      ? { weeklyRemaining: credits.weeklyRemaining, weeklyLimit: credits.weeklyLimit }
      : deriveWeeklyQuotaFromCredits(creditUsagePercent, usagePeriodType)

  return {
    monthlyLimit,
    used,
    remaining,
    // Monthly percent only — never substitute weekly creditUsagePercent here.
    usagePercent,
    billingPeriodStart:
      monthlySource.billingPeriodStart
      ?? credits.billingPeriodStart
      ?? fallback.billingPeriodStart,
    billingPeriodEnd:
      monthlySource.billingPeriodEnd
      ?? credits.billingPeriodEnd
      ?? fallback.billingPeriodEnd,
    onDemandCap: credits.onDemandCap ?? fallback.onDemandCap,
    creditUsagePercent,
    usagePeriodType,
    usagePeriodStart,
    usagePeriodEnd,
    weeklyRemaining: weekly.weeklyRemaining,
    weeklyLimit: weekly.weeklyLimit,
    planName: credits.planName ?? fallback.planName,
  }
}

function emptyGrokBillingQuota(): GrokBillingQuota {
  return {
    monthlyLimit: null,
    used: null,
    remaining: null,
    usagePercent: null,
    billingPeriodStart: null,
    billingPeriodEnd: null,
    onDemandCap: null,
    creditUsagePercent: null,
    usagePeriodType: null,
    usagePeriodStart: null,
    usagePeriodEnd: null,
    weeklyRemaining: null,
    weeklyLimit: null,
    planName: null,
  }
}

export type GrokUserProfile = {
  email: string | null
  accountId: string | null
  displayName: string | null
  hasGrokCodeAccess: boolean | null
}

export function parseGrokUserBody(body: unknown): GrokUserProfile {
  if (!body || typeof body !== 'object') {
    return { email: null, accountId: null, displayName: null, hasGrokCodeAccess: null }
  }
  const r = body as Record<string, unknown>
  const email = typeof r.email === 'string' && r.email ? r.email : null
  const accountId =
    (typeof r.userId === 'string' && r.userId)
    || (typeof r.principalId === 'string' && r.principalId)
    || null
  const first = typeof r.firstName === 'string' ? r.firstName.trim() : ''
  const last = typeof r.lastName === 'string' ? r.lastName.trim() : ''
  const displayName = [first, last].filter(Boolean).join(' ') || null
  const hasGrokCodeAccess =
    typeof r.hasGrokCodeAccess === 'boolean' ? r.hasGrokCodeAccess : null
  return { email, accountId, displayName, hasGrokCodeAccess }
}

async function grokCliGetJson(
  path: string,
  accessToken: string,
): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  const base = GROK_CLI_BASE_URL.replace(/\/+$/, '')
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`
  const network = await loadNetworkSettings()
  const proxyOpts = getNetworkProxyFetchOptions(network, url)
  const headers = Object.fromEntries(buildGrokIdentityHeaders(accessToken).entries())
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      ...proxyOpts,
      signal: AbortSignal.timeout(20_000),
    })
    const text = await res.text()
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text) as unknown
      } catch {
        body = text
      }
    }
    return { ok: res.ok, status: res.status, body }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function probeWithBearer(
  provider: SavedProvider,
  accessToken: string,
): Promise<Partial<ProviderQuotaSnapshot> & { ok: boolean; httpStatus?: number; error?: string }> {
  if (!provider.baseUrl?.trim()) {
    return { ok: false, error: 'missing baseUrl' }
  }
  const network = await loadNetworkSettings()
  const url = buildProbeUrl(provider.baseUrl, provider.apiFormat ?? 'openai_chat')
  const proxyOpts = getNetworkProxyFetchOptions(network, url)
  // Grok official needs CLI identity headers; bare Bearer alone is insufficient for some routes.
  const isGrok =
    isGrokOfficialProviderId(provider.id) || provider.runtimeKind === 'grok_oauth'
  const headers = isGrok
    ? Object.fromEntries(buildGrokIdentityHeaders(accessToken).entries())
    : {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      }
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      ...proxyOpts,
      signal: AbortSignal.timeout(20_000),
    })
    const fromHeaders = parseQuotaHeaders(res.headers)
    return {
      ok: res.ok,
      httpStatus: res.status,
      ...fromHeaders,
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function buildProbeUrl(baseUrl: string, apiFormat: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (apiFormat === 'openai_chat' || apiFormat === 'openai_responses') {
    return `${base}/models`
  }
  // Anthropic-compatible: models list is widely supported; falls back to messages 404 still returns headers
  return `${base}/v1/models`
}

function buildProbeHeaders(
  provider: SavedProvider,
  apiKey: string,
): Record<string, string> {
  const format = provider.apiFormat ?? 'anthropic'
  if (format === 'openai_chat' || format === 'openai_responses') {
    return {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }
  }
  return {
    ...buildAnthropicAuthHeaders(apiKey, provider.authStrategy ?? 'api_key'),
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  }
}

export async function probeProviderQuota(
  provider: SavedProvider,
): Promise<{
  accountInfo: ProviderAccountInfo
  quotaSnapshot: ProviderQuotaSnapshot
}> {
  const type = resolveAccountType(provider)
  const accountInfo: ProviderAccountInfo = {
    ...(provider.accountInfo ?? {}),
    type,
    accountLabel:
      provider.accountInfo?.accountLabel
      || provider.accountInfo?.email
      || maskApiKey(provider.apiKey),
  }

  // Official Grok OAuth: billing API + user profile (not /models headers)
  if (isGrokOfficialProviderId(provider.id) || provider.runtimeKind === 'grok_oauth') {
    try {
      const tokens = await hahaGrokOAuthService.loadTokens()
      if (tokens) {
        const fresh = (await hahaGrokOAuthService.ensureFreshTokens()) ?? tokens
        accountInfo.email = fresh.email
        accountInfo.accountLabel =
          fresh.displayName?.trim()
          || fresh.email
          || 'Grok OAuth'
        accountInfo.type = 'oauth/grok'

        // Dual-fetch: format=credits for weekly + default /billing for monthly.
        // grok2api primary path is format=credits; some accounts only expose
        // monthlyLimit/used on the default shape — merge so both bars fill.
        const [creditsRes, monthlyRes, userRes] = await Promise.all([
          grokCliGetJson('/billing?format=credits', fresh.accessToken),
          grokCliGetJson('/billing', fresh.accessToken),
          grokCliGetJson('/user', fresh.accessToken),
        ])

        if (userRes.ok) {
          const profile = parseGrokUserBody(userRes.body)
          if (profile.email) accountInfo.email = profile.email
          if (profile.accountId) accountInfo.accountId = profile.accountId
          accountInfo.accountLabel =
            fresh.displayName?.trim()
            || profile.displayName
            || profile.email
            || accountInfo.accountLabel
            || 'Grok OAuth'
        }

        const billingOk = creditsRes.ok || monthlyRes.ok
        if (billingOk) {
          const creditsQuota = creditsRes.ok
            ? parseGrokBillingBody(creditsRes.body)
            : emptyGrokBillingQuota()
          const monthlyQuota = monthlyRes.ok
            ? parseGrokBillingBody(monthlyRes.body)
            : null
          // Prefer credits body as primary (weekly); fold in monthly from either.
          const billing = mergeGrokBillingQuotas(
            creditsRes.ok ? creditsQuota : (monthlyQuota ?? emptyGrokBillingQuota()),
            creditsRes.ok ? monthlyQuota : null,
          )
          const hasMonthly = hasMonthlyBillingPool(billing)
          const hasWeekly =
            billing.weeklyLimit != null
            || billing.weeklyRemaining != null
            || billing.creditUsagePercent != null
          const hasQuota = hasMonthly || hasWeekly
          const weeklyExhausted =
            hasWeekly
            && billing.weeklyRemaining != null
            && billing.weeklyRemaining <= 0
          const monthlyExhausted =
            hasMonthly
            && billing.remaining != null
            && billing.remaining <= 0
          const status: ProviderQuotaSnapshot['status'] =
            hasQuota && (weeklyExhausted || monthlyExhausted)
              ? 'limited'
              : hasQuota
                ? 'ok'
                : 'unknown'
          const email = accountInfo.email || fresh.email
          const usedLabel =
            billing.used != null && billing.monthlyLimit != null
              ? `${billing.used} / ${billing.monthlyLimit}${
                billing.usagePercent != null
                  ? ` (${billing.usagePercent.toFixed(2)}%)`
                  : ''
              }`
              : `${billing.used ?? '—'} / ${billing.monthlyLimit ?? '—'}`
          const weeklyLabel =
            billing.creditUsagePercent != null
              ? `周限已用 ${billing.creditUsagePercent.toFixed(1)}%`
              : hasWeekly && billing.weeklyRemaining != null && billing.weeklyLimit != null
                ? `周限剩余 ${billing.weeklyRemaining}/${billing.weeklyLimit}`
                : null
          const msgParts = [
            email ? `Grok 账号 ${email}` : null,
            hasMonthly ? `本月已用 ${usedLabel}` : null,
            weeklyLabel,
          ].filter(Boolean)
          return {
            accountInfo,
            quotaSnapshot: {
              syncedAt: nowIso(),
              source: hasQuota ? 'upstream' : 'oauth',
              status,
              // Monthly included budget → primary remaining/limit + 月限 columns
              remaining: billing.remaining,
              limit: billing.monthlyLimit,
              used: billing.used,
              // Keep primary usagePercent = monthly only (weekly is separate fields)
              usagePercent: billing.usagePercent,
              weeklyRemaining: billing.weeklyRemaining,
              weeklyLimit: billing.weeklyLimit,
              monthlyRemaining: billing.remaining,
              monthlyLimit: billing.monthlyLimit,
              // Monthly billing cycle end for 月限; weekly end is in message if needed
              resetAt: billing.billingPeriodEnd ?? billing.usagePeriodEnd,
              credentialExpiresAt: fresh.expiresAt
                ? new Date(fresh.expiresAt).toISOString()
                : null,
              lastRefreshAt: null,
              message: hasQuota
                ? (msgParts.join(' · ') || '额度已同步')
                : (email
                  ? `Grok 账号 ${email}（billing 无额度字段）`
                  : 'Grok OAuth 已登录（billing 无额度字段）'),
            },
          }
        }

        // Billing failed: fall back to connectivity probe (still usually no quota headers)
        const probed = await probeWithBearer(
          { ...provider, apiFormat: provider.apiFormat ?? 'openai_chat' },
          fresh.accessToken,
        )
        const hasHeaderQuota =
          probed.remaining != null
          || probed.limit != null
          || probed.weeklyLimit != null
          || probed.monthlyLimit != null
        const billingError =
          creditsRes.error
          || monthlyRes.error
          || (!creditsRes.ok && !monthlyRes.ok
            ? `billing HTTP ${creditsRes.status || monthlyRes.status}`
            : null)
        return {
          accountInfo,
          quotaSnapshot: {
            syncedAt: nowIso(),
            source: hasHeaderQuota ? 'headers' : billingError ? 'error' : 'oauth',
            status: hasHeaderQuota
              ? (probed.remaining === 0 ? 'limited' : 'ok')
              : billingError || !probed.ok
                ? 'error'
                : 'unknown',
            remaining: probed.remaining ?? null,
            limit: probed.limit ?? null,
            used: probed.used ?? null,
            usagePercent: probed.usagePercent ?? null,
            weeklyRemaining: probed.weeklyRemaining ?? null,
            weeklyLimit: probed.weeklyLimit ?? null,
            monthlyRemaining: probed.monthlyRemaining ?? null,
            monthlyLimit: probed.monthlyLimit ?? null,
            resetAt: probed.resetAt ?? null,
            credentialExpiresAt: fresh.expiresAt
              ? new Date(fresh.expiresAt).toISOString()
              : null,
            lastRefreshAt: null,
            message: hasHeaderQuota
              ? '额度来自响应头（billing 不可用）'
              : (billingError
                || probed.error
                || '无法读取 /v1/billing 额度'),
          },
        }
      }
      return {
        accountInfo: { type: 'oauth/grok', accountLabel: '未登录' },
        quotaSnapshot: {
          syncedAt: nowIso(),
          source: 'unavailable',
          status: 'unknown',
          message: 'Grok OAuth 未登录',
        },
      }
    } catch (err) {
      return {
        accountInfo: { type: 'oauth/grok', accountLabel: 'Grok OAuth' },
        quotaSnapshot: {
          syncedAt: nowIso(),
          source: 'error',
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }

  if (isOpenAIOfficialProviderId(provider.id) || provider.runtimeKind === 'openai_oauth') {
    try {
      const tokens = await hahaOpenAIOAuthService.loadTokens()
      if (tokens) {
        const email = (tokens as { email?: string | null }).email ?? null
        const expiresAt = (tokens as { expiresAt?: number | null }).expiresAt ?? null
        accountInfo.email = email
        accountInfo.accountLabel = email || 'OpenAI OAuth'
        accountInfo.type = 'oauth/openai'
        return {
          accountInfo,
          quotaSnapshot: {
            syncedAt: nowIso(),
            source: 'oauth',
            status: 'ok',
            credentialExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
            message: email
              ? `OpenAI 账号 ${email}`
              : 'OpenAI OAuth 已登录（额度请在 platform.openai.com 查看）',
          },
        }
      }
    } catch {
      // fall through
    }
  }

  if (!provider.apiKey?.trim() || !provider.baseUrl?.trim()) {
    return {
      accountInfo,
      quotaSnapshot: {
        syncedAt: nowIso(),
        source: 'unavailable',
        status: 'unknown',
        message: '缺少 baseUrl 或 apiKey，无法同步额度',
      },
    }
  }

  const network = await loadNetworkSettings()
  const url = buildProbeUrl(provider.baseUrl, provider.apiFormat ?? 'anthropic')
  const proxyOpts = getNetworkProxyFetchOptions(network, url)
  const headers = buildProbeHeaders(provider, provider.apiKey)

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      ...proxyOpts,
      signal: AbortSignal.timeout(20_000),
    })

    const fromHeaders = parseQuotaHeaders(res.headers)
    const hasQuota =
      fromHeaders.remaining != null
      || fromHeaders.limit != null
      || fromHeaders.weeklyLimit != null
      || fromHeaders.monthlyLimit != null

    let message: string | null = null
    if (!res.ok && !hasQuota) {
      message = `探测 HTTP ${res.status}；上游未返回可用额度头`
    } else if (!hasQuota) {
      message = '已连通；上游未暴露额度头（周/月限需厂商支持）'
    }

    const status: ProviderQuotaSnapshot['status'] =
      !res.ok && !hasQuota
        ? 'error'
        : fromHeaders.remaining === 0
          ? 'limited'
          : hasQuota
            ? 'ok'
            : 'unknown'

    return {
      accountInfo,
      quotaSnapshot: {
        syncedAt: nowIso(),
        source: hasQuota ? 'headers' : res.ok ? 'upstream' : 'error',
        status,
        message,
        remaining: fromHeaders.remaining ?? null,
        limit: fromHeaders.limit ?? null,
        used: fromHeaders.used ?? null,
        usagePercent: fromHeaders.usagePercent ?? null,
        weeklyRemaining: fromHeaders.weeklyRemaining ?? null,
        weeklyLimit: fromHeaders.weeklyLimit ?? null,
        monthlyRemaining: fromHeaders.monthlyRemaining ?? null,
        monthlyLimit: fromHeaders.monthlyLimit ?? null,
        resetAt: fromHeaders.resetAt ?? null,
        credentialExpiresAt: null,
      },
    }
  } catch (err) {
    return {
      accountInfo,
      quotaSnapshot: {
        syncedAt: nowIso(),
        source: 'error',
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      },
    }
  }
}

export async function refreshProviderCredentialMeta(
  provider: SavedProvider,
): Promise<{
  accountInfo: ProviderAccountInfo
  quotaSnapshot: ProviderQuotaSnapshot
  refreshed: boolean
}> {
  // Grok OAuth: user-initiated force refresh (not expiry-gated)
  if (isGrokOfficialProviderId(provider.id) || provider.runtimeKind === 'grok_oauth') {
    try {
      const refreshed = await hahaGrokOAuthService.forceRefreshTokens()
      const probed = await probeProviderQuota({
        ...provider,
        accountInfo: {
          type: 'oauth/grok',
          email: refreshed.email,
          accountLabel: refreshed.displayName || refreshed.email || 'Grok OAuth',
        },
      })
      return {
        refreshed: true,
        accountInfo: probed.accountInfo,
        quotaSnapshot: {
          ...probed.quotaSnapshot,
          lastRefreshAt: nowIso(),
          credentialExpiresAt: refreshed.expiresAt
            ? new Date(refreshed.expiresAt).toISOString()
            : probed.quotaSnapshot.credentialExpiresAt ?? null,
          message: 'Grok 凭据已强制刷新',
        },
      }
    } catch (err) {
      return {
        refreshed: false,
        accountInfo: { type: 'oauth/grok', accountLabel: 'Grok OAuth' },
        quotaSnapshot: {
          syncedAt: nowIso(),
          source: 'error',
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }

  // Default: re-probe connectivity + quota headers as "refresh"
  const probed = await probeProviderQuota(provider)
  return {
    refreshed: probed.quotaSnapshot.status !== 'error',
    accountInfo: probed.accountInfo,
    quotaSnapshot: {
      ...probed.quotaSnapshot,
      lastRefreshAt: nowIso(),
      message: probed.quotaSnapshot.message || '已重新校验凭据连通性',
    },
  }
}
