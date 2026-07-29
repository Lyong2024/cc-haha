/**
 * Single-admin session auth for pure-web product path.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { WebControlDatabase } from './webControlDb.js'
import { getWebControlDatabase } from './webControlDb.js'

export const WEB_SESSION_COOKIE = 'cc_haha_session'
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type WebAuthStatus = {
  setupRequired: boolean
  authenticated: boolean
  mode: 'web-admin'
  /** Present when admin exists (login form may show it as a soft hint). */
  username?: string | null
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

export class WebAuthService {
  constructor(private readonly database: WebControlDatabase = getWebControlDatabase()) {}

  getStatus(sessionToken?: string | null): WebAuthStatus {
    const setupRequired = !this.hasAdmin()
    const authenticated = !setupRequired && !!sessionToken && !!this.validateSession(sessionToken)
    return {
      setupRequired,
      authenticated,
      mode: 'web-admin',
      // Soft hint for the login form only; never a secret.
      username: setupRequired ? null : this.getAdminUsername(),
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
   */
  login(
    credentials: AdminCredentials | string,
    meta?: { ip?: string | null; userAgent?: string | null },
  ) {
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

    if (!username || !usernamesEqual(username, storedUsername)) {
      throw Object.assign(new Error('Invalid credentials'), { code: 'UNAUTHORIZED' as const })
    }
    if (!verifyPassword(password, row.password_hash)) {
      throw Object.assign(new Error('Invalid credentials'), { code: 'UNAUTHORIZED' as const })
    }
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
  const value = process.env.CC_HAHA_WEB_AUTH?.trim().toLowerCase()
  if (value === '0' || value === 'false' || value === 'off') return false
  if (value === '1' || value === 'true' || value === 'on') return true
  if (process.env.CC_HAHA_WEB_MODE === '1') return true
  // Pure-web branch product default: enforce admin session unless tests opt out.
  // Existing server unit tests set NODE_ENV=test or CC_HAHA_WEB_AUTH=0.
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
