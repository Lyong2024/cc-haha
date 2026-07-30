/**
 * SQLite-backed sessions for non-Claude Agent CLIs (S3/S4).
 * Claude sessions remain in ~/.claude/projects JSONL via sessionService.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { getWebControlDatabase } from '../webControlDb.js'
import type { AgentCliId } from './types.js'

export type AgentCliSessionRecord = {
  id: string
  cliId: AgentCliId
  title: string
  workDir: string
  createdAt: string
  modifiedAt: string
  messageCount: number
  status: 'idle' | 'running' | 'error'
  lastError: string | null
  metaJson: string | null
}

export type AgentCliMessageRecord = {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function resolveWorkDir(input?: string | null): string {
  const fallback = process.env.HAHA_DEFAULT_WORK_DIR?.trim() || process.cwd() || homedir()
  const absolute = resolve((input?.trim() || fallback).trim())
  if (!existsSync(absolute)) return fallback
  try {
    if (!statSync(absolute).isDirectory()) return fallback
  } catch {
    return fallback
  }
  return absolute
}

export function listAgentCliSessions(
  cliId: AgentCliId,
  options?: { limit?: number; offset?: number },
): { sessions: AgentCliSessionRecord[]; total: number } {
  const { db } = getWebControlDatabase()
  const limit = options?.limit ?? 100
  const offset = options?.offset ?? 0
  const totalRow = db
    .query<{ c: number }, [string]>(
      `SELECT COUNT(*) as c FROM agent_cli_sessions WHERE cli_id = ?`,
    )
    .get(cliId)
  const rows = db
    .query<
      {
        id: string
        cli_id: string
        title: string
        work_dir: string
        created_at: string
        modified_at: string
        message_count: number
        status: string
        last_error: string | null
        meta_json: string | null
      },
      [string, number, number]
    >(
      `SELECT id, cli_id, title, work_dir, created_at, modified_at, message_count, status, last_error, meta_json
       FROM agent_cli_sessions
       WHERE cli_id = ?
       ORDER BY modified_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(cliId, limit, offset)

  return {
    total: totalRow?.c ?? 0,
    sessions: rows.map((row) => ({
      id: row.id,
      cliId: row.cli_id as AgentCliId,
      title: row.title,
      workDir: row.work_dir,
      createdAt: row.created_at,
      modifiedAt: row.modified_at,
      messageCount: row.message_count,
      status: row.status as AgentCliSessionRecord['status'],
      lastError: row.last_error,
      metaJson: row.meta_json,
    })),
  }
}

export function getAgentCliSession(sessionId: string): AgentCliSessionRecord | null {
  const { db } = getWebControlDatabase()
  const row = db
    .query<
      {
        id: string
        cli_id: string
        title: string
        work_dir: string
        created_at: string
        modified_at: string
        message_count: number
        status: string
        last_error: string | null
        meta_json: string | null
      },
      [string]
    >(
      `SELECT id, cli_id, title, work_dir, created_at, modified_at, message_count, status, last_error, meta_json
       FROM agent_cli_sessions WHERE id = ?`,
    )
    .get(sessionId)
  if (!row) return null
  return {
    id: row.id,
    cliId: row.cli_id as AgentCliId,
    title: row.title,
    workDir: row.work_dir,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    messageCount: row.message_count,
    status: row.status as AgentCliSessionRecord['status'],
    lastError: row.last_error,
    metaJson: row.meta_json,
  }
}

export function createAgentCliSession(input: {
  cliId: AgentCliId
  workDir?: string | null
  title?: string | null
}): AgentCliSessionRecord {
  const { db } = getWebControlDatabase()
  const id = randomUUID()
  const ts = nowIso()
  const workDir = resolveWorkDir(input.workDir)
  const title = (input.title?.trim() || 'New Session').slice(0, 200)
  db.query(
    `INSERT INTO agent_cli_sessions
      (id, cli_id, title, work_dir, created_at, modified_at, message_count, status, last_error, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'idle', NULL, NULL)`,
  ).run(id, input.cliId, title, workDir, ts, ts)
  return {
    id,
    cliId: input.cliId,
    title,
    workDir,
    createdAt: ts,
    modifiedAt: ts,
    messageCount: 0,
    status: 'idle',
    lastError: null,
    metaJson: null,
  }
}

export function deleteAgentCliSession(sessionId: string): boolean {
  const { db } = getWebControlDatabase()
  db.query(`DELETE FROM agent_cli_messages WHERE session_id = ?`).run(sessionId)
  const result = db.query(`DELETE FROM agent_cli_sessions WHERE id = ?`).run(sessionId)
  return result.changes > 0
}

export function updateAgentCliSession(
  sessionId: string,
  patch: Partial<{
    title: string
    status: AgentCliSessionRecord['status']
    lastError: string | null
    messageCount: number
  }>,
): void {
  const existing = getAgentCliSession(sessionId)
  if (!existing) return
  const { db } = getWebControlDatabase()
  db.query(
    `UPDATE agent_cli_sessions
     SET title = ?, status = ?, last_error = ?, message_count = ?, modified_at = ?
     WHERE id = ?`,
  ).run(
    patch.title ?? existing.title,
    patch.status ?? existing.status,
    patch.lastError !== undefined ? patch.lastError : existing.lastError,
    patch.messageCount ?? existing.messageCount,
    nowIso(),
    sessionId,
  )
}

export function listAgentCliMessages(sessionId: string): AgentCliMessageRecord[] {
  const { db } = getWebControlDatabase()
  const rows = db
    .query<
      {
        id: string
        session_id: string
        role: string
        content: string
        timestamp: string
      },
      [string]
    >(
      `SELECT id, session_id, role, content, timestamp
       FROM agent_cli_messages
       WHERE session_id = ?
       ORDER BY timestamp ASC, rowid ASC`,
    )
    .all(sessionId)
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    role: row.role as AgentCliMessageRecord['role'],
    content: row.content,
    timestamp: row.timestamp,
  }))
}

export function appendAgentCliMessage(input: {
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
}): AgentCliMessageRecord {
  const { db } = getWebControlDatabase()
  const id = randomUUID()
  const ts = nowIso()
  db.query(
    `INSERT INTO agent_cli_messages (id, session_id, role, content, timestamp)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, input.sessionId, input.role, input.content, ts)
  const countRow = db
    .query<{ c: number }, [string]>(
      `SELECT COUNT(*) as c FROM agent_cli_messages WHERE session_id = ?`,
    )
    .get(input.sessionId)
  updateAgentCliSession(input.sessionId, {
    messageCount: countRow?.c ?? 0,
    status: 'idle',
  })
  // Auto-title from first user message
  const session = getAgentCliSession(input.sessionId)
  if (session && session.title === 'New Session' && input.role === 'user') {
    const title = input.content.trim().replace(/\s+/g, ' ').slice(0, 80)
    if (title) updateAgentCliSession(input.sessionId, { title })
  }
  return {
    id,
    sessionId: input.sessionId,
    role: input.role,
    content: input.content,
    timestamp: ts,
  }
}
