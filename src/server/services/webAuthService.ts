/**
 * Single-admin session auth for pure-web product path.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { WebControlDatabase } from './webControlDb.js'
import { getWebControlDatabase } from './webControlDb.js'

export const WEB_SESSION_COOKIE = 'HAHA_session'
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Failed logins before device/IP is locked. */
export const LOGIN_MAX_FAILURES = 10
/** Lock duration after max failures. */
export const LOGIN_LOCKOUT_MS = 60 * 60 * 1000

export type WebAuthStatus = {
  setupRequired: boolean
  authenticated: boolean
  mode: 'web-admin'
  /** Present when admin exists (login form may show it as a soft hint). */
  username?: string | null
  /** Brute-force lockout policy (always returned for UI). */
  lockoutPolicy?: {
    maxFailures: number
    lockDurationSeconds: number
  }
  /** Present when the calling client (fingerprint and/or IP) is locked. */
  lockout?: LoginLockoutState | null
}

export type WebSessionRecord = {
  id: string
  ip: string | null
  userAgent: string | null
  createdAt: string
  lastSeenAt: string
  expiresAt: string
}

export type AdminCredentials = {
  username: string
  password: string
}

export type AuthClientContext = {
  ip?: string | null
  userAgent?: string | null
  /** Browser fingerprint visitorId (FingerprintJS open-source). */
  fingerprint?: string | null
}

export type LoginLockoutState = {
  locked: boolean
  failCount: number
  remainingAttempts: number
  lockedUntil: string | null
  retryAfterSeconds: number
}

const USERNAME_MIN = 3
const USERNAME_MAX = 32
const PASSWORD_MIN = 8
/** Letters, digits, underscore, hyphen; must start with a letter or digit. */
const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

function nowIso(): string {
  return new Date().toISOString()
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function hashPassword(password: string): string {
  // bun password API when available; fallback to scrypt-like via Bun.password
  return Bun.password.hashSync(password, {
    algorithm: 'bcrypt',
    cost: 10,
  })
}

function verifyPassword(password: string, passwordHash: string): boolean {
  return Bun.password.verifySync(password, passwordHash)
}

function normalizeUsername(username: string): string {
  return username.trim()
}

export function validateUsername(username: string): string {
  const trimmed = normalizeUsername(username)
  if (trimmed.length < USERNAME_MIN || trimmed.length > USERNAME_MAX) {
    throw Object.assign(
      new Error(`Username must be ${USERNAME_MIN}–${USERNAME_MAX} characters`),
      { code: 'VALIDATION' as const },
    )
  }
  if (!USERNAME_PATTERN.test(trimmed)) {
    throw Object.assign(
      new Error('Username may only contain letters, digits, underscore and hyphen'),
      { code: 'VALIDATION' as const },
    )
  }
  return trimmed
}

export function validatePassword(password: string): string {
  const trimmed = password.trim()
  if (trimmed.length < PASSWORD_MIN) {
    throw Object.assign(
      new Error(`Password must be at least ${PASSWORD_MIN} characters`),
      { code: 'VALIDATION' as const },
    )
  }
  return trimmed
}

function usernamesEqual(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'base' }) === 0
}

function parseCookieHeader(header: string | null): Record<string, string> {
  if (!header) return {}
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key) out[key] = decodeURIComponent(value)
  }
  return out
}

export function readSessionTokenFromRequest(req: Request): string | null {
  const cookies = parseCookieHeader(req.headers.get('Cookie'))
  const fromCookie = cookies[WEB_SESSION_COOKIE]?.trim()
  if (fromCookie) return fromCookie

  const auth = req.headers.get('Authorization')
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim()
    // Only treat opaque session tokens (not empty)
    if (token && !token.startsWith('sk-')) return token
  }

  const url = new URL(req.url)
  const queryToken = url.searchParams.get('sessionToken')
  return queryToken?.trim() || null
}

function normalizeFingerprint(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim().slice(0, 128)
  if (!trimmed) return null
  // Allow alphanumeric + common fingerprint chars only.
  if (!/^[a-zA-Z0-9._:-]+$/.test(trimmed)) return null
  return trimmed
}

function clientKeys(ctx?: AuthClientContext | null): string[] {
  const keys: string[] = []
  const fp = normalizeFingerprint(ctx?.fingerprint)
  if (fp) keys.push(`fp:${fp}`)
  const ip = ctx?.ip?.trim()
  if (ip) keys.push(`ip:${ip}`)
  // Always have a fallback bucket when neither is available (tests / edge).
  if (keys.length === 0) keys.push('unknown:anonymous')
  return keys
}

export class WebAuthService {
  constructor(private readonly database: WebControlDatabase = getWebControlDatabase()) {}

  getStatus(sessionToken?: string | null, client?: AuthClientContext | null): WebAuthStatus {
    const setupRequired = !this.hasAdmin()
    const authenticated = !setupRequired && !!sessionToken && !!this.validateSession(sessionToken)
    const lockout = this.getLockoutState(client)
    return {
      setupRequired,
      authenticated,
      mode: 'web-admin',
      // Soft hint for the login form only; never a secret.
      username: setupRequired ? null : this.getAdminUsername(),
      lockoutPolicy: {
        maxFailures: LOGIN_MAX_FAILURES,
        lockDurationSeconds: Math.floor(LOGIN_LOCKOUT_MS / 1000),
      },
      lockout,
    }
  }

  getLockoutState(client?: AuthClientContext | null): LoginLockoutState {
    const now = Date.now()
    let failCount = 0
    let lockedUntilMs = 0

    for (const key of clientKeys(client)) {
      const row = this.database.db
        .query<
          { fail_count: number; locked_until: string | null },
          [string]
        >(
          'SELECT fail_count, locked_until FROM auth_lockout WHERE client_key = ?',
        )
        .get(key)
      if (!row) continue
      failCount = Math.max(failCount, row.fail_count)
      if (row.locked_until) {
        const until = Date.parse(row.locked_until)
        if (Number.isFinite(until) && until > lockedUntilMs) lockedUntilMs = until
      }
    }

    if (lockedUntilMs > now) {
      return {
        locked: true,
        failCount,
        remainingAttempts: 0,
        lockedUntil: new Date(lockedUntilMs).toISOString(),
        retryAfterSeconds: Math.max(1, Math.ceil((lockedUntilMs - now) / 1000)),
      }
    }

    // Expired lock: treat as unlocked; counters reset on next success or after lock expires + new attempt window.
    const effectiveFails = lockedUntilMs > 0 && lockedUntilMs <= now ? 0 : failCount
    return {
      locked: false,
      failCount: effectiveFails,
      remainingAttempts: Math.max(0, LOGIN_MAX_FAILURES - effectiveFails),
      lockedUntil: null,
      retryAfterSeconds: 0,
    }
  }

  assertNotLocked(client?: AuthClientContext | null): void {
    const state = this.getLockoutState(client)
    if (!state.locked) return
    throw Object.assign(
      new Error(
        `登录失败次数过多，已锁定 ${Math.ceil(state.retryAfterSeconds / 60)} 分钟。请在 ${state.lockedUntil} 后重试。`,
      ),
      {
        code: 'LOCKED' as const,
        lockout: state,
      },
    )
  }

  private recordLoginFailure(client?: AuthClientContext | null): LoginLockoutState {
    const ts = nowIso()
    const now = Date.now()
    let maxFails = 0
    let lockedUntilIso: string | null = null

    for (const key of clientKeys(client)) {
      const existing = this.database.db
        .query<
          { fail_count: number; locked_until: string | null },
          [string]
        >(
          'SELECT fail_count, locked_until FROM auth_lockout WHERE client_key = ?',
        )
        .get(key)

      let failCount = existing?.fail_count ?? 0
      const existingLock = existing?.locked_until ? Date.parse(existing.locked_until) : 0
      // Reset counter if previous lock fully expired.
      if (existingLock > 0 && existingLock <= now) {
        failCount = 0
      }
      failCount += 1

      let lockedUntil: string | null = null
      if (failCount >= LOGIN_MAX_FAILURES) {
        lockedUntil = new Date(now + LOGIN_LOCKOUT_MS).toISOString()
        lockedUntilIso = lockedUntil
      }

      this.database.db
        .query(
          `INSERT INTO auth_lockout(client_key, fail_count, locked_until, last_fail_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(client_key) DO UPDATE SET
             fail_count = excluded.fail_count,
             locked_until = excluded.locked_until,
             last_fail_at = excluded.last_fail_at,
             updated_at = excluded.updated_at`,
        )
        .run(key, failCount, lockedUntil, ts, ts, ts)

      maxFails = Math.max(maxFails, failCount)
    }

    if (lockedUntilIso) {
      return {
        locked: true,
        failCount: maxFails,
        remainingAttempts: 0,
        lockedUntil: lockedUntilIso,
        retryAfterSeconds: Math.floor(LOGIN_LOCKOUT_MS / 1000),
      }
    }

    return {
      locked: false,
      failCount: maxFails,
      remainingAttempts: Math.max(0, LOGIN_MAX_FAILURES - maxFails),
      lockedUntil: null,
      retryAfterSeconds: 0,
    }
  }

  private clearLoginFailures(client?: AuthClientContext | null): void {
    for (const key of clientKeys(client)) {
      this.database.db.query('DELETE FROM auth_lockout WHERE client_key = ?').run(key)
    }
  }

  hasAdmin(): boolean {
    const row = this.database.db
      .query<{ id: number }, []>('SELECT id FROM admin_user WHERE id = 1')
      .get()
    return !!row
  }

  getAdminUsername(): string | null {
    const row = this.database.db
      .query<{ username: string | null }, []>(
        'SELECT username FROM admin_user WHERE id = 1',
      )
      .get()
    const username = row?.username?.trim()
    return username ? username : null
  }

  /**
   * First-boot initialization: create the single admin account + session cookie.
   * Accepts either `{ username, password }` or legacy `(password)` for tests.
   */
  setupAdmin(
    credentials: AdminCredentials | string,
    meta?: { ip?: string | null; userAgent?: string | null },
  ) {
    if (this.hasAdmin()) {
      throw Object.assign(new Error('Admin already configured'), { code: 'CONFLICT' as const })
    }
    const username = validateUsername(
      typeof credentials === 'string' ? 'admin' : credentials.username,
    )
    const password = validatePassword(
      typeof credentials === 'string' ? credentials : credentials.password,
    )
    const ts = nowIso()
    this.database.db
      .query(
        `INSERT INTO admin_user(id, username, password_hash, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?)`,
      )
      .run(username, hashPassword(password), ts, ts)

    return this.createSession(meta)
  }

  /**
   * Login with username + password. Accepts legacy string password only when
   * the stored username is the default "admin" (migrated v1 installs).
   * Enforces fingerprint/IP lockout after LOGIN_MAX_FAILURES failures.
   */
  login(
    credentials: AdminCredentials | string,
    meta?: AuthClientContext | null,
  ) {
    this.assertNotLocked(meta)

    const row = this.database.db
      .query<{ username: string | null; password_hash: string }, []>(
        'SELECT username, password_hash FROM admin_user WHERE id = 1',
      )
      .get()
    if (!row) {
      throw Object.assign(new Error('Setup required'), { code: 'SETUP_REQUIRED' as const })
    }

    const storedUsername = (row.username?.trim() || 'admin')
    let username: string
    let password: string
    if (typeof credentials === 'string') {
      username = storedUsername
      password = credentials
    } else {
      username = normalizeUsername(credentials.username)
      password = credentials.password
    }

    const usernameOk = !!username && usernamesEqual(username, storedUsername)
    const passwordOk = usernameOk && verifyPassword(password, row.password_hash)
    if (!passwordOk) {
      const lockout = this.recordLoginFailure(meta)
      if (lockout.locked) {
        throw Object.assign(
          new Error(
            `登录失败次数过多（${LOGIN_MAX_FAILURES} 次），本设备/IP 已锁定 1 小时。`,
          ),
          { code: 'LOCKED' as const, lockout },
        )
      }
      throw Object.assign(
        new Error(
          `账号或密码错误，还可尝试 ${lockout.remainingAttempts} 次（失败 ${LOGIN_MAX_FAILURES} 次将锁定 1 小时）`,
        ),
        {
          code: 'UNAUTHORIZED' as const,
          lockout,
        },
      )
    }

    this.clearLoginFailures(meta)
    return this.createSession(meta)
  }

  resetPassword(password: string): void {
    const trimmed = validatePassword(password)
    const ts = nowIso()
    if (!this.hasAdmin()) {
      this.database.db
        .query(
          `INSERT INTO admin_user(id, username, password_hash, created_at, updated_at)
           VALUES (1, 'admin', ?, ?, ?)`,
        )
        .run(hashPassword(trimmed), ts, ts)
      return
    }
    this.database.db
      .query(
        `UPDATE admin_user SET password_hash = ?, updated_at = ? WHERE id = 1`,
      )
      .run(hashPassword(trimmed), ts)
    // Invalidate all sessions after password reset
    this.database.db.exec('DELETE FROM web_sessions')
  }

  createSession(meta?: { ip?: string | null; userAgent?: string | null }): {
    token: string
    session: WebSessionRecord
  } {
    const token = randomBytes(32).toString('base64url')
    const id = randomBytes(16).toString('hex')
    const createdAt = nowIso()
    const expiresAt = new Date(Date.now() + DEFAULT_SESSION_TTL_MS).toISOString()
    this.database.db
      .query(
        `INSERT INTO web_sessions(id, token_hash, ip, user_agent, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        hashToken(token),
        meta?.ip ?? null,
        meta?.userAgent ?? null,
        createdAt,
        createdAt,
        expiresAt,
      )

    return {
      token,
      session: {
        id,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
        createdAt,
        lastSeenAt: createdAt,
        expiresAt,
      },
    }
  }

  validateSession(token: string): WebSessionRecord | null {
    const row = this.database.db
      .query<
        {
          id: string
          ip: string | null
          user_agent: string | null
          created_at: string
          last_seen_at: string
          expires_at: string
        },
        [string]
      >(
        `SELECT id, ip, user_agent, created_at, last_seen_at, expires_at
         FROM web_sessions WHERE token_hash = ?`,
      )
      .get(hashToken(token))

    if (!row) return null
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.database.db.query('DELETE FROM web_sessions WHERE id = ?').run(row.id)
      return null
    }

    const lastSeenAt = nowIso()
    this.database.db
      .query('UPDATE web_sessions SET last_seen_at = ? WHERE id = ?')
      .run(lastSeenAt, row.id)

    return {
      id: row.id,
      ip: row.ip,
      userAgent: row.user_agent,
      createdAt: row.created_at,
      lastSeenAt,
      expiresAt: row.expires_at,
    }
  }

  logout(token: string): void {
    this.database.db.query('DELETE FROM web_sessions WHERE token_hash = ?').run(hashToken(token))
  }

  listWebSessions(): WebSessionRecord[] {
    const rows = this.database.db
      .query<
        {
          id: string
          ip: string | null
          user_agent: string | null
          created_at: string
          last_seen_at: string
          expires_at: string
        },
        []
      >(
        `SELECT id, ip, user_agent, created_at, last_seen_at, expires_at
         FROM web_sessions
         ORDER BY last_seen_at DESC`,
      )
      .all()

    const now = Date.now()
    return rows
      .filter((row) => Date.parse(row.expires_at) > now)
      .map((row) => ({
        id: row.id,
        ip: row.ip,
        userAgent: row.user_agent,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
      }))
  }

  buildSessionCookie(token: string, options?: { secure?: boolean }): string {
    const maxAge = Math.floor(DEFAULT_SESSION_TTL_MS / 1000)
    const parts = [
      `${WEB_SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAge}`,
    ]
    if (options?.secure) parts.push('Secure')
    return parts.join('; ')
  }

  buildClearSessionCookie(): string {
    return `${WEB_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  }
}

export function isWebAuthEnforced(): boolean {
  const value = process.env.HAHA_WEB_AUTH?.trim().toLowerCase()
  if (value === '0' || value === 'false' || value === 'off') return false
  if (value === '1' || value === 'true' || value === 'on') return true
  if (process.env.HAHA_WEB_MODE === '1') return true
  // Pure-web branch product default: enforce admin session unless tests opt out.
  // Existing server unit tests set NODE_ENV=test or HAHA_WEB_AUTH=0.
  if (process.env.NODE_ENV === 'test' || process.env.BUN_TEST === '1') {
    return false
  }
  return true
}

export function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

let defaultService: WebAuthService | null = null

export function getWebAuthService(): WebAuthService {
  if (!defaultService) defaultService = new WebAuthService()
  return defaultService
}

export function resetWebAuthServiceForTests(): void {
  defaultService = null
}
