/**
 * Read-only online presence: Web sessions + IM active identities.
 * No kick / revoke operations.
 */

import type { WebControlDatabase } from './webControlDb.js'
import { getWebControlDatabase } from './webControlDb.js'

export const WEB_ONLINE_THRESHOLD_MS = 5 * 60 * 1000
export const IM_ACTIVE_THRESHOLD_MS = 15 * 60 * 1000

export type OnlineUserRow = {
  id: string
  source: 'web' | 'im'
  platform: string | null
  identity: string
  ip: string | null
  userAgent: string | null
  sessionRef: string | null
  status: 'online' | 'idle' | 'active'
  loginAt: string | null
  lastActiveAt: string
}

function nowIso(): string {
  return new Date().toISOString()
}

export class WebPresenceService {
  constructor(private readonly database: WebControlDatabase = getWebControlDatabase()) {}

  touchWebSession(sessionId: string, meta?: {
    ip?: string | null
    userAgent?: string | null
    identity?: string
  }): void {
    const ts = nowIso()
    const id = `web:${sessionId}`
    this.database.db
      .query(
        `INSERT INTO presence(id, source, platform, identity, ip, session_ref, status, last_active_at, meta_json, created_at)
         VALUES (?, 'web', NULL, ?, ?, ?, 'online', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           identity = excluded.identity,
           ip = COALESCE(excluded.ip, presence.ip),
           last_active_at = excluded.last_active_at,
           status = 'online',
           meta_json = COALESCE(excluded.meta_json, presence.meta_json)`,
      )
      .run(
        id,
        meta?.identity ?? 'admin',
        meta?.ip ?? null,
        sessionId,
        ts,
        meta?.userAgent ? JSON.stringify({ userAgent: meta.userAgent }) : null,
        ts,
      )
  }

  touchImActivity(input: {
    platform: string
    identity: string
    sessionRef?: string | null
    meta?: Record<string, unknown>
  }): void {
    const ts = nowIso()
    const id = `im:${input.platform}:${input.identity}`
    this.database.db
      .query(
        `INSERT INTO presence(id, source, platform, identity, ip, session_ref, status, last_active_at, meta_json, created_at)
         VALUES (?, 'im', ?, ?, NULL, ?, 'active', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           session_ref = COALESCE(excluded.session_ref, presence.session_ref),
           last_active_at = excluded.last_active_at,
           status = 'active',
           meta_json = COALESCE(excluded.meta_json, presence.meta_json)`,
      )
      .run(
        id,
        input.platform,
        input.identity,
        input.sessionRef ?? null,
        ts,
        input.meta ? JSON.stringify(input.meta) : null,
        ts,
      )
  }

  listOnlineUsers(now = Date.now()): OnlineUserRow[] {
    const rows: OnlineUserRow[] = []

    // Read from this control DB so tests and multi-instance data-dirs stay consistent.
    const webSessions = this.database.db
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
      .filter((session) => Date.parse(session.expires_at) > now)

    for (const session of webSessions) {
      const age = now - Date.parse(session.last_seen_at)
      const presenceId = `web:${session.id}`
      const presence = this.database.db
        .query<{ identity: string }, [string]>(
          'SELECT identity FROM presence WHERE id = ?',
        )
        .get(presenceId)
      rows.push({
        id: presenceId,
        source: 'web',
        platform: null,
        identity: presence?.identity?.trim() || 'admin',
        ip: session.ip,
        userAgent: session.user_agent,
        sessionRef: session.id,
        status: age <= WEB_ONLINE_THRESHOLD_MS ? 'online' : 'idle',
        loginAt: session.created_at,
        lastActiveAt: session.last_seen_at,
      })
    }

    const presenceRows = this.database.db
      .query<
        {
          id: string
          source: string
          platform: string | null
          identity: string
          ip: string | null
          session_ref: string | null
          last_active_at: string
          meta_json: string | null
          created_at: string
        },
        []
      >(
        `SELECT id, source, platform, identity, ip, session_ref, last_active_at, meta_json, created_at
         FROM presence
         WHERE source = 'im'
         ORDER BY last_active_at DESC
         LIMIT 200`,
      )
      .all()

    for (const row of presenceRows) {
      const age = now - Date.parse(row.last_active_at)
      if (age > 24 * 60 * 60 * 1000) continue
      let userAgent: string | null = null
      if (row.meta_json) {
        try {
          userAgent = (JSON.parse(row.meta_json) as { userAgent?: string }).userAgent ?? null
        } catch {
          userAgent = null
        }
      }
      rows.push({
        id: row.id,
        source: 'im',
        platform: row.platform,
        identity: row.identity,
        ip: row.ip,
        userAgent,
        sessionRef: row.session_ref,
        status: age <= IM_ACTIVE_THRESHOLD_MS ? 'active' : 'idle',
        loginAt: row.created_at,
        lastActiveAt: row.last_active_at,
      })
    }

    return rows
  }
}

let defaultPresence: WebPresenceService | null = null

export function getWebPresenceService(): WebPresenceService {
  if (!defaultPresence) defaultPresence = new WebPresenceService()
  return defaultPresence
}

export function resetWebPresenceServiceForTests(): void {
  defaultPresence = null
}
