import { describe, expect, test } from 'bun:test'
import {
  buildCredentialExport,
  buildGrokOAuthCredentialExport,
  deriveWeeklyQuotaFromCredits,
  hasMonthlyBillingPool,
  maskApiKey,
  mergeGrokBillingQuotas,
  parseGrokBillingBody,
  parseGrokUserBody,
  parseQuotaHeaders,
  resolveAccountType,
} from '../services/providerAccountService.js'
import type { SavedProvider } from '../types/provider.js'

function makeProvider(partial?: Partial<SavedProvider>): SavedProvider {
  return {
    id: 'p1',
    presetId: 'custom',
    name: 'Test',
    apiKey: 'sk-test-abcdef1234567890',
    baseUrl: 'https://api.example.com',
    apiFormat: 'anthropic',
    runtimeKind: 'anthropic_compatible',
    models: { main: 'm', haiku: 'm', sonnet: 'm', opus: 'm' },
    ...partial,
  }
}

describe('provider account helpers', () => {
  test('maskApiKey hides middle of key', () => {
    expect(maskApiKey('sk-abcdefghij')).toMatch(/^sk-a…/)
    expect(maskApiKey('short')).toBe('••••')
  })

  test('resolveAccountType prefers runtime and auth strategy', () => {
    expect(resolveAccountType(makeProvider({ runtimeKind: 'grok_oauth' }))).toBe('oauth/grok')
    expect(resolveAccountType(makeProvider({ authStrategy: 'auth_token' }))).toBe('auth_token')
    expect(resolveAccountType(makeProvider({}))).toBe('api_key')
  })

  test('parseQuotaHeaders reads remaining/limit and weekly/monthly', () => {
    const headers = new Headers({
      'x-ratelimit-remaining': '42',
      'x-ratelimit-limit': '100',
      'x-weekly-remaining': '10',
      'x-weekly-limit': '50',
      'x-monthly-remaining': '100',
      'x-monthly-limit': '1000',
    })
    const q = parseQuotaHeaders(headers)
    expect(q.remaining).toBe(42)
    expect(q.limit).toBe(100)
    expect(q.used).toBe(58)
    expect(q.usagePercent).toBeCloseTo(58)
    expect(q.weeklyRemaining).toBe(10)
    expect(q.weeklyLimit).toBe(50)
    expect(q.monthlyLimit).toBe(1000)
  })

  test('buildCredentialExport includes secret and metadata', () => {
    const provider = makeProvider({
      createdAt: '2026-01-01T00:00:00.000Z',
      accountInfo: { type: 'api_key', accountLabel: 'sk-t…7890' },
    })
    const exp = buildCredentialExport(provider)
    expect(exp.version).toBe(1)
    expect(exp.kind).toBe('api_key')
    expect(exp.provider.apiKey).toBe(provider.apiKey)
    expect(exp.provider.name).toBe('Test')
    expect(exp.provider.accountInfo?.type).toBe('api_key')
    expect(exp.exportedAt).toBeTruthy()
  })

  test('parseGrokBillingBody maps monthly included budget', () => {
    const q = parseGrokBillingBody({
      config: {
        monthlyLimit: { val: 150000 },
        used: { val: 59376 },
        onDemandCap: { val: 0 },
        billingPeriodStart: '2026-07-01T00:00:00+00:00',
        billingPeriodEnd: '2026-08-01T00:00:00+00:00',
      },
    })
    expect(q.monthlyLimit).toBe(150000)
    expect(q.used).toBe(59376)
    expect(q.remaining).toBe(150000 - 59376)
    expect(q.usagePercent).toBeCloseTo((59376 / 150000) * 100, 1)
    expect(q.billingPeriodEnd).toBe('2026-08-01T00:00:00+00:00')
    // No credits weekly fields → weekly stays null
    expect(q.weeklyRemaining).toBeNull()
    expect(q.weeklyLimit).toBeNull()
    expect(q.creditUsagePercent).toBeNull()
  })

  test('parseGrokBillingBody maps format=credits weekly period (grok2api)', () => {
    // Fixture mirrors temp/grok2api billing_test.go credits sample
    const q = parseGrokBillingBody({
      onDemandEnabled: false,
      subscriptionTier: 'SuperGrok Heavy',
      config: {
        creditUsagePercent: 42.5,
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-07-08T00:00:00+00:00',
          end: '2026-07-15T00:00:00+00:00',
        },
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
        isUnifiedBillingUser: true,
        prepaidBalance: { val: 0 },
      },
    })
    expect(q.creditUsagePercent).toBe(42.5)
    expect(q.usagePeriodType).toBe('USAGE_PERIOD_TYPE_WEEKLY')
    expect(q.usagePeriodStart).toBe('2026-07-08T00:00:00+00:00')
    expect(q.usagePeriodEnd).toBe('2026-07-15T00:00:00+00:00')
    expect(q.weeklyLimit).toBe(100)
    expect(q.weeklyRemaining).toBe(57.5)
    expect(q.planName).toBe('SuperGrok Heavy')
    expect(q.monthlyLimit).toBeNull()
  })

  test('parseGrokBillingBody weekly zero usage still exposes full pool', () => {
    const q = parseGrokBillingBody({
      config: {
        creditUsagePercent: 0,
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-07-01T00:00:00Z',
          end: '2026-07-08T00:00:00Z',
        },
      },
    })
    expect(q.weeklyLimit).toBe(100)
    expect(q.weeklyRemaining).toBe(100)
  })

  test('deriveWeeklyQuotaFromCredits only activates for weekly/credits signals', () => {
    expect(deriveWeeklyQuotaFromCredits(null, null)).toEqual({
      weeklyRemaining: null,
      weeklyLimit: null,
    })
    expect(deriveWeeklyQuotaFromCredits(17, null)).toEqual({
      weeklyRemaining: 83,
      weeklyLimit: 100,
    })
    expect(deriveWeeklyQuotaFromCredits(null, 'USAGE_PERIOD_TYPE_WEEKLY')).toEqual({
      weeklyRemaining: 100,
      weeklyLimit: 100,
    })
  })

  test('mergeGrokBillingQuotas keeps weekly + monthly like grok2api list DTO', () => {
    // credits-only shape (no monthlyLimit) + default monthly shape
    const credits = parseGrokBillingBody({
      config: {
        creditUsagePercent: 19,
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-07-29T06:24:49.591346+00:00',
          end: '2026-08-05T06:24:49.591346+00:00',
        },
        isUnifiedBillingUser: true,
      },
    })
    const monthly = parseGrokBillingBody({
      config: {
        monthlyLimit: { val: 150000 },
        used: { val: 62011 },
        onDemandCap: { val: 0 },
        billingPeriodStart: '2026-07-01T00:00:00+00:00',
        billingPeriodEnd: '2026-08-01T00:00:00+00:00',
      },
    })
    const merged = mergeGrokBillingQuotas(credits, monthly)
    expect(hasMonthlyBillingPool(merged)).toBe(true)
    expect(merged.monthlyLimit).toBe(150000)
    expect(merged.used).toBe(62011)
    expect(merged.remaining).toBe(87989)
    expect(merged.usagePercent).toBeCloseTo(41.340666666666664, 5)
    expect(merged.creditUsagePercent).toBe(19)
    expect(merged.weeklyLimit).toBe(100)
    expect(merged.weeklyRemaining).toBe(81)
    expect(merged.billingPeriodEnd).toBe('2026-08-01T00:00:00+00:00')
    expect(merged.usagePeriodType).toBe('USAGE_PERIOD_TYPE_WEEKLY')
  })

  test('mergeGrokBillingQuotas keeps both when credits body already has monthly', () => {
    // Single body with both pools (user's grok2api stored billing shape)
    const both = parseGrokBillingBody({
      monthlyLimit: 150000,
      used: 62011,
      remaining: 87989,
      creditUsagePercent: 19,
      usagePeriodType: 'USAGE_PERIOD_TYPE_WEEKLY',
      usagePeriodStart: '2026-07-29T06:24:49.591346+00:00',
      usagePeriodEnd: '2026-08-05T06:24:49.591346+00:00',
      billingPeriodStart: '2026-07-01T00:00:00+00:00',
      billingPeriodEnd: '2026-08-01T00:00:00+00:00',
      config: {
        monthlyLimit: 150000,
        used: 62011,
        remaining: 87989,
        creditUsagePercent: 19,
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-07-29T06:24:49.591346+00:00',
          end: '2026-08-05T06:24:49.591346+00:00',
        },
        billingPeriodStart: '2026-07-01T00:00:00+00:00',
        billingPeriodEnd: '2026-08-01T00:00:00+00:00',
      },
    })
    expect(both.monthlyLimit).toBe(150000)
    expect(both.weeklyRemaining).toBe(81)
    const merged = mergeGrokBillingQuotas(both, null)
    expect(merged.monthlyLimit).toBe(150000)
    expect(merged.remaining).toBe(87989)
    expect(merged.weeklyRemaining).toBe(81)
    expect(merged.usagePercent).toBeCloseTo((62011 / 150000) * 100, 5)
  })

  test('parseGrokUserBody extracts email and display name', () => {
    const u = parseGrokUserBody({
      userId: 'u-1',
      email: 'a@x.ai',
      firstName: 'Ada',
      lastName: 'Lovelace',
      hasGrokCodeAccess: true,
    })
    expect(u.email).toBe('a@x.ai')
    expect(u.accountId).toBe('u-1')
    expect(u.displayName).toBe('Ada Lovelace')
    expect(u.hasGrokCodeAccess).toBe(true)
  })

  test('buildGrokOAuthCredentialExport emits auth.json style payload', () => {
    const provider = makeProvider({
      id: 'grok-official',
      name: 'Grok Official',
      runtimeKind: 'grok_oauth',
      apiFormat: 'openai_chat',
      baseUrl: 'https://cli-chat-proxy.grok.com/v1',
      apiKey: '',
    })
    const exp = buildGrokOAuthCredentialExport(
      provider,
      {
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        expiresAt: 1_700_000_000_000,
        email: 'user@x.ai',
        displayName: 'My Grok',
        createdAt: '2026-01-02T00:00:00.000Z',
        clientId: null,
        idToken: null,
      },
      'C:/tmp/grok-oauth.json',
    )
    expect(exp.kind).toBe('grok_oauth')
    expect(exp.filename).toBe('auth.json')
    expect(exp.auth?.accessToken).toBe('at-1')
    expect(exp.auth?.refreshToken).toBe('rt-1')
    expect(exp.provider.name).toBe('My Grok')
    expect(exp.provider.apiKey).toBe('at-1')
    expect(exp.provider.accountInfo?.email).toBe('user@x.ai')
  })
})
