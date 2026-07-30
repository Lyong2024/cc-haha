/**
 * **Grok Official only** multi-account pool (Phase B).
 *
 * Scope: exclusively backs the `grok-official` provider shell.
 * Not used by Claude Official, ChatGPT Official, or any custom API provider.
 *
 * Storage: grok-account-pool.json under HAHA data dir.
 * Legacy: migrates single grok-oauth.json into a one-entry pool on first load.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  HAHA_DIR_NAME,
  LEGACY_HAHA_DIR_NAME,
  resolveHahaDataDir,
  resolveHahaOAuthFile,
} from './ccHahaPaths.js'
import type { ProviderQuotaSnapshot } from '../types/provider.js'
import type { StoredGrokOAuthTokens } from './hahaGrokOAuthService.js'

export type GrokPoolAccount = {
  id: string
  email: string | null
  displayName: string | null
  accountType: string
  enabled: boolean
  createdAt: string
  updatedAt: string
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  idToken?: string | null
  clientId?: string | null
  quotaSnapshot?: ProviderQuotaSnapshot | null
  consecutiveFailures: number
  lastOkAt: string | null
  lastErrorAt: string | null
}

export type GrokAccountPool = {
  schemaVersion: 1
  /** sticky preferred account; when set and healthy, always used */
  preferredAccountId: string | null
  /** round-robin cursor among enabled healthy accounts when no preferred */
  rrIndex: number
  accounts: GrokPoolAccount[]
  updatedAt: string
}

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

const POOL_FILE = 'grok-account-pool.json'
const LEGACY_OAUTH_FILE = 'grok-oauth.json'

function nowIso(): string {
  return new Date().toISOString()
}

function emptyPool(): GrokAccountPool {
  return {
    schemaVersion: 1,
    preferredAccountId: null,
    rrIndex: 0,
    accounts: [],
    updatedAt: nowIso(),
  }
}

export function getGrokAccountPoolPath(): string {
  return resolveHahaOAuthFile(POOL_FILE)
}

export function getLegacyGrokOAuthPath(): string {
  return resolveHahaOAuthFile(LEGACY_OAUTH_FILE)
}

function tokensFromAccount(acc: GrokPoolAccount): StoredGrokOAuthTokens {
  return {
    accessToken: acc.accessToken,
    refreshToken: acc.refreshToken,
    expiresAt: acc.expiresAt,
    idToken: acc.idToken ?? null,
    email: acc.email,
    clientId: acc.clientId ?? null,
    displayName: acc.displayName,
    createdAt: acc.createdAt,
  }
}

function accountFromTokens(
  tokens: StoredGrokOAuthTokens,
  id?: string,
): GrokPoolAccount {
  const t = nowIso()
  return {
    id: id ?? randomUUID(),
    email: tokens.email ?? null,
    displayName: tokens.displayName ?? null,
    accountType: 'oauth/grok',
    enabled: true,
    createdAt: tokens.createdAt ?? t,
    updatedAt: t,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    idToken: tokens.idToken ?? null,
    clientId: tokens.clientId ?? null,
    quotaSnapshot: null,
    consecutiveFailures: 0,
    lastOkAt: null,
    lastErrorAt: null,
  }
}

function isHealthy(acc: GrokPoolAccount): boolean {
  if (!acc.enabled) return false
  if (!acc.accessToken && !acc.refreshToken) return false
  if (acc.quotaSnapshot?.status === 'error' && acc.consecutiveFailures >= 3) return false
  return true
}

export class GrokAccountPoolService {
  private writeChain: Promise<void> = Promise.resolve()

  getPoolPath(): string {
    return getGrokAccountPoolPath()
  }

  private async readRaw(): Promise<GrokAccountPool | null> {
    try {
      const raw = await fs.readFile(this.getPoolPath(), 'utf-8')
      return JSON.parse(raw) as GrokAccountPool
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async writeRaw(pool: GrokAccountPool): Promise<void> {
    const filePath = this.getPoolPath()
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const temporaryPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
    let renamed = false
    const payload: GrokAccountPool = { ...pool, updatedAt: nowIso() }
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
      await fs.rename(temporaryPath, filePath)
      renamed = true
    } finally {
      if (!renamed) await fs.rm(temporaryPath, { force: true }).catch(() => {})
    }
  }

  private enqueueWrite(fn: () => Promise<void>): Promise<void> {
    this.writeChain = this.writeChain.then(fn, fn)
    return this.writeChain
  }

  /**
   * Candidate paths for desktop-compatible grok-oauth.json.
   * Scoped to resolveHahaDataDir() and its sibling brand folder under the same parent
   * (`…/haha` ↔ `…/cc-haha`) so HAHA_DATA_DIR isolation in tests stays airtight while
   * real installs still see both brand dirs.
   */
  private oauthTokenCandidatePaths(): string[] {
    const names = new Set<string>()
    try {
      const dataDir = resolveHahaDataDir()
      names.add(join(dataDir, LEGACY_OAUTH_FILE))
      const parent = path.dirname(dataDir)
      const base = path.basename(dataDir)
      if (base === HAHA_DIR_NAME || base === LEGACY_HAHA_DIR_NAME) {
        names.add(join(parent, HAHA_DIR_NAME, LEGACY_OAUTH_FILE))
        names.add(join(parent, LEGACY_HAHA_DIR_NAME, LEGACY_OAUTH_FILE))
      }
    } catch {
      names.add(getLegacyGrokOAuthPath())
    }
    return [...names]
  }

  private async readLegacyOAuthTokens(): Promise<StoredGrokOAuthTokens | null> {
    for (const filePath of this.oauthTokenCandidatePaths()) {
      try {
        if (!existsSync(filePath)) continue
        const raw = await fs.readFile(filePath, 'utf-8')
        const tokens = JSON.parse(raw) as StoredGrokOAuthTokens
        if (tokens?.accessToken) return tokens
      } catch {
        // try next path
      }
    }
    return null
  }

  /**
   * Import desktop/single-file oauth into pool only when no pool file exists yet
   * (or pool never had accounts written). If the pool file exists with an empty
   * accounts array, the user intentionally logged out of all entries — do not
   * re-import (except when the pool file itself is missing).
   */
  private async migrateFromLegacyOAuthIfNeeded(
    pool: GrokAccountPool,
    poolFileExists: boolean,
  ): Promise<GrokAccountPool> {
    if (pool.accounts.length > 0) return pool
    // User cleared the pool → keep empty; do not resurrect from oauth.
    if (poolFileExists) return pool
    const tokens = await this.readLegacyOAuthTokens()
    if (!tokens?.accessToken) return pool
    const acc = accountFromTokens(tokens)
    const next: GrokAccountPool = {
      schemaVersion: 1,
      preferredAccountId: null,
      rrIndex: 0,
      accounts: [acc],
      updatedAt: nowIso(),
    }
    await this.writeRaw(next)
    // Keep legacy grok-oauth.json for desktop / older pure-web readers.
    return next
  }

  /** Load pool; migrate desktop cc-haha / haha grok-oauth.json if pool missing. */
  async loadPool(): Promise<GrokAccountPool> {
    const existing = await this.readRaw()
    if (existing && Array.isArray(existing.accounts)) {
      const normalized: GrokAccountPool = {
        schemaVersion: 1,
        preferredAccountId: existing.preferredAccountId ?? null,
        rrIndex: typeof existing.rrIndex === 'number' ? existing.rrIndex : 0,
        accounts: existing.accounts,
        updatedAt: existing.updatedAt ?? nowIso(),
      }
      return this.migrateFromLegacyOAuthIfNeeded(normalized, true)
    }

    return this.migrateFromLegacyOAuthIfNeeded(emptyPool(), false)
  }

  async savePool(pool: GrokAccountPool): Promise<void> {
    await this.enqueueWrite(() => this.writeRaw(pool))
  }

  /**
   * Pick tokens for outbound API:
   * - preferred + healthy → sticky
   * - else round-robin among healthy
   */
  pickAccount(pool: GrokAccountPool): GrokPoolAccount | null {
    const healthy = pool.accounts.filter(isHealthy)
    if (healthy.length === 0) return null

    if (pool.preferredAccountId) {
      const pref = healthy.find((a) => a.id === pool.preferredAccountId)
      if (pref) return pref
    }

    const idx = Math.abs(pool.rrIndex) % healthy.length
    return healthy[idx] ?? healthy[0] ?? null
  }

  /** Advance RR cursor after a successful pick when not sticky-preferred. */
  async advanceRoundRobin(pickedId: string): Promise<void> {
    const pool = await this.loadPool()
    if (pool.preferredAccountId) {
      const pref = pool.accounts.find((a) => a.id === pool.preferredAccountId)
      if (pref && isHealthy(pref)) return // sticky — do not advance
    }
    const healthy = pool.accounts.filter(isHealthy)
    if (healthy.length <= 1) return
    const current = healthy.findIndex((a) => a.id === pickedId)
    pool.rrIndex = current >= 0 ? (current + 1) % healthy.length : (pool.rrIndex + 1) % healthy.length
    await this.savePool(pool)
  }

  async getActiveTokens(): Promise<StoredGrokOAuthTokens | null> {
    const pool = await this.loadPool()
    const acc = this.pickAccount(pool)
    if (!acc) return null
    return tokensFromAccount(acc)
  }

  /** Upsert after OAuth login: match by email, else append. */
  async upsertFromLogin(tokens: StoredGrokOAuthTokens): Promise<GrokPoolAccount> {
    const pool = await this.loadPool()
    const email = tokens.email?.toLowerCase() ?? null
    let acc = email
      ? pool.accounts.find((a) => a.email?.toLowerCase() === email)
      : undefined

    if (acc) {
      acc = {
        ...acc,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? acc.refreshToken,
        expiresAt: tokens.expiresAt,
        idToken: tokens.idToken ?? acc.idToken ?? null,
        clientId: tokens.clientId ?? acc.clientId ?? null,
        email: tokens.email ?? acc.email,
        displayName: tokens.displayName ?? acc.displayName,
        updatedAt: nowIso(),
        enabled: true,
        consecutiveFailures: 0,
      }
      pool.accounts = pool.accounts.map((a) => (a.id === acc!.id ? acc! : a))
    } else {
      acc = accountFromTokens(tokens)
      pool.accounts.push(acc)
    }

    // First account becomes available; keep preferred if still valid
    if (pool.preferredAccountId && !pool.accounts.some((a) => a.id === pool.preferredAccountId)) {
      pool.preferredAccountId = null
    }

    await this.savePool(pool)
    // Mirror active pick to legacy path for older readers
    await this.mirrorLegacy(tokensFromAccount(acc))
    return acc
  }

  async updateAccountTokens(
    accountId: string,
    tokens: Partial<StoredGrokOAuthTokens>,
  ): Promise<GrokPoolAccount | null> {
    const pool = await this.loadPool()
    const idx = pool.accounts.findIndex((a) => a.id === accountId)
    if (idx < 0) return null
    const prev = pool.accounts[idx]!
    const next: GrokPoolAccount = {
      ...prev,
      accessToken: tokens.accessToken ?? prev.accessToken,
      refreshToken: tokens.refreshToken !== undefined ? tokens.refreshToken : prev.refreshToken,
      expiresAt: tokens.expiresAt !== undefined ? tokens.expiresAt : prev.expiresAt,
      idToken: tokens.idToken !== undefined ? tokens.idToken : prev.idToken,
      email: tokens.email !== undefined ? tokens.email : prev.email,
      clientId: tokens.clientId !== undefined ? tokens.clientId : prev.clientId,
      displayName: tokens.displayName !== undefined ? tokens.displayName : prev.displayName,
      updatedAt: nowIso(),
      consecutiveFailures: 0,
      lastOkAt: nowIso(),
    }
    pool.accounts[idx] = next
    await this.savePool(pool)
    const active = this.pickAccount(pool)
    if (active?.id === accountId) await this.mirrorLegacy(tokensFromAccount(next))
    return next
  }

  async setPreferred(accountId: string | null): Promise<GrokAccountPool> {
    const pool = await this.loadPool()
    if (accountId != null && !pool.accounts.some((a) => a.id === accountId)) {
      throw new Error('账号不存在')
    }
    pool.preferredAccountId = accountId
    await this.savePool(pool)
    const active = this.pickAccount(pool)
    if (active) await this.mirrorLegacy(tokensFromAccount(active))
    return pool
  }

  async setEnabled(accountId: string, enabled: boolean): Promise<GrokPoolAccount> {
    const pool = await this.loadPool()
    const idx = pool.accounts.findIndex((a) => a.id === accountId)
    if (idx < 0) throw new Error('账号不存在')
    pool.accounts[idx] = { ...pool.accounts[idx]!, enabled, updatedAt: nowIso() }
    if (!enabled && pool.preferredAccountId === accountId) {
      pool.preferredAccountId = null
    }
    await this.savePool(pool)
    return pool.accounts[idx]!
  }

  async renameAccount(accountId: string, displayName: string): Promise<GrokPoolAccount> {
    const trimmed = displayName.trim()
    if (!trimmed) throw new Error('name is required')
    const pool = await this.loadPool()
    const idx = pool.accounts.findIndex((a) => a.id === accountId)
    if (idx < 0) throw new Error('账号不存在')
    pool.accounts[idx] = {
      ...pool.accounts[idx]!,
      displayName: trimmed,
      updatedAt: nowIso(),
    }
    await this.savePool(pool)
    return pool.accounts[idx]!
  }

  async updateQuota(
    accountId: string,
    quota: ProviderQuotaSnapshot,
  ): Promise<void> {
    const pool = await this.loadPool()
    const idx = pool.accounts.findIndex((a) => a.id === accountId)
    if (idx < 0) return
    pool.accounts[idx] = {
      ...pool.accounts[idx]!,
      quotaSnapshot: quota,
      updatedAt: nowIso(),
      lastOkAt: quota.status === 'error' ? pool.accounts[idx]!.lastOkAt : nowIso(),
      lastErrorAt: quota.status === 'error' ? nowIso() : pool.accounts[idx]!.lastErrorAt,
      consecutiveFailures:
        quota.status === 'error'
          ? pool.accounts[idx]!.consecutiveFailures + 1
          : 0,
    }
    await this.savePool(pool)
  }

  async removeAccount(accountId: string): Promise<{ remaining: number }> {
    const pool = await this.loadPool()
    pool.accounts = pool.accounts.filter((a) => a.id !== accountId)
    if (pool.preferredAccountId === accountId) pool.preferredAccountId = null
    await this.savePool(pool)
    if (pool.accounts.length === 0) {
      await fs.rm(getLegacyGrokOAuthPath(), { force: true }).catch(() => {})
    } else {
      const active = this.pickAccount(pool)
      if (active) await this.mirrorLegacy(tokensFromAccount(active))
    }
    return { remaining: pool.accounts.length }
  }

  async clearAll(): Promise<void> {
    await this.savePool(emptyPool())
    await fs.rm(getLegacyGrokOAuthPath(), { force: true }).catch(() => {})
  }

  toPublicList(pool: GrokAccountPool): GrokAccountPublic[] {
    const active = this.pickAccount(pool)
    return pool.accounts.map((a) => ({
      id: a.id,
      email: a.email,
      displayName: a.displayName,
      accountType: a.accountType,
      enabled: a.enabled,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      isPreferred: pool.preferredAccountId === a.id,
      isActivePick: active?.id === a.id,
      quotaSnapshot: a.quotaSnapshot ?? null,
      consecutiveFailures: a.consecutiveFailures,
      lastOkAt: a.lastOkAt,
      lastErrorAt: a.lastErrorAt,
      hasRefreshToken: !!a.refreshToken,
      expiresAt: a.expiresAt,
    }))
  }

  private async mirrorLegacy(tokens: StoredGrokOAuthTokens): Promise<void> {
    const filePath = getLegacyGrokOAuthPath()
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const temporaryPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
    let renamed = false
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 })
      await fs.rename(temporaryPath, filePath)
      renamed = true
    } finally {
      if (!renamed) await fs.rm(temporaryPath, { force: true }).catch(() => {})
    }
  }
}

export const grokAccountPoolService = new GrokAccountPoolService()
