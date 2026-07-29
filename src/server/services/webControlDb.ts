/**
 * Pure-web control-plane SQLite (admin, sessions, presence).
 * Separate from localIndex; tuned for single-node throughput (WAL + large cache).
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

export const WEB_CONTROL_SCHEMA_VERSION = 2
export const WEB_CONTROL_DB_FILENAME = 'web-control-v1.sqlite'

export type WebControlDatabase = {
  db: Database
  path: string
  close(): void
  pragmaJournalMode(): string
}

let singleton: WebControlDatabase | null = null

export function resolveWebControlDataDir(override?: string): string {
  if (override?.trim()) return override.trim()
  if (process.env.CC_HAHA_DATA_DIR?.trim()) return process.env.CC_HAHA_DATA_DIR.trim()
  return join(getClaudeConfigHomeDir(), 'cc-haha')
}

export function resolveWebControlDatabasePath(dataDir?: string): string {
  return join(resolveWebControlDataDir(dataDir), 'db', WEB_CONTROL_DB_FILENAME)
}

/** High-performance PRAGMA set required by pure-web design. */
export function applyWebControlPerformancePragmas(database: Database): void {
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = NORMAL')
  database.exec('PRAGMA temp_store = MEMORY')
  database.exec('PRAGMA mmap_size = 268435456')
  database.exec('PRAGMA cache_size = -65536')
  database.exec('PRAGMA busy_timeout = 5000')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA wal_autocheckpoint = 1000')
  database.exec(`PRAGMA journal_size_limit = ${16 * 1024 * 1024}`)
}

function adminUserHasColumn(database: Database, column: string): boolean {
  const columns = database
    .query<{ name: string }, []>('PRAGMA table_info(admin_user)')
    .all()
  return columns.some((row) => row.name === column)
}

function migrateWebControlSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_user (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS web_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      ip TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_web_sessions_last_seen
      ON web_sessions(last_seen_at);

    CREATE TABLE IF NOT EXISTS presence (
      id TEXT PRIMARY KEY NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('web', 'im')),
      platform TEXT,
      identity TEXT NOT NULL,
      ip TEXT,
      session_ref TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      last_active_at TEXT NOT NULL,
      meta_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_presence_source_active
      ON presence(source, last_active_at);
  `)

  // v1 → v2: password-only admin rows gain a username (default "admin").
  if (!adminUserHasColumn(database, 'username')) {
    database.exec(`ALTER TABLE admin_user ADD COLUMN username TEXT`)
    database.exec(`UPDATE admin_user SET username = 'admin' WHERE username IS NULL OR trim(username) = ''`)
  } else {
    database.exec(`UPDATE admin_user SET username = 'admin' WHERE username IS NULL OR trim(username) = ''`)
  }

  database
    .query(
      `INSERT INTO meta(key, value) VALUES('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(String(WEB_CONTROL_SCHEMA_VERSION))
}

export function openWebControlDatabase(options?: {
  path?: string
  dataDir?: string
}): WebControlDatabase {
  const databasePath = options?.path ?? resolveWebControlDatabasePath(options?.dataDir)
  mkdirSync(dirname(databasePath), { recursive: true })

  const db = new Database(databasePath, { create: true })
  applyWebControlPerformancePragmas(db)
  migrateWebControlSchema(db)

  return {
    db,
    path: databasePath,
    close() {
      db.close()
    },
    pragmaJournalMode() {
      const row = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()
      return (row?.journal_mode ?? '').toLowerCase()
    },
  }
}

export function getWebControlDatabase(options?: {
  path?: string
  dataDir?: string
}): WebControlDatabase {
  if (options?.path || options?.dataDir) {
    return openWebControlDatabase(options)
  }
  if (!singleton) {
    singleton = openWebControlDatabase()
  }
  return singleton
}

export function resetWebControlDatabaseSingletonForTests(): void {
  if (singleton) {
    try {
      singleton.close()
    } catch {
      // ignore
    }
    singleton = null
  }
}
