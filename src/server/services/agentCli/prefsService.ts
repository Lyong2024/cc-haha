/**
 * Persist default / active Agent CLI preference in web-control SQLite.
 */

import { getWebControlDatabase } from '../webControlDb.js'
import { DEFAULT_AGENT_CLI_ID, isAgentCliId } from './registry.js'
import type { AgentCliId } from './types.js'

const KEY_DEFAULT = 'default_agent_cli_id'
const KEY_ACTIVE = 'active_agent_cli_id'

function getPref(key: string): string | null {
  try {
    const { db } = getWebControlDatabase()
    const row = db
      .query<{ value: string }, [string]>(
        `SELECT value FROM agent_cli_prefs WHERE key = ?`,
      )
      .get(key)
    return row?.value ?? null
  } catch {
    return null
  }
}

function setPref(key: string, value: string): void {
  const { db } = getWebControlDatabase()
  db.query(
    `INSERT INTO agent_cli_prefs(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value)
}

/** Map legacy registry ids after renames (e.g. groq-code → grok). */
function normalizeAgentCliId(value: string | null): AgentCliId | null {
  if (!value) return null
  if (value === 'groq-code') return 'grok'
  if (isAgentCliId(value)) return value
  return null
}

export function getDefaultAgentCliId(): AgentCliId {
  const value = normalizeAgentCliId(getPref(KEY_DEFAULT))
  if (value) return value
  return DEFAULT_AGENT_CLI_ID
}

export function setDefaultAgentCliId(id: AgentCliId): void {
  if (!isAgentCliId(id)) throw new Error(`Invalid agent CLI id: ${id}`)
  setPref(KEY_DEFAULT, id)
}

export function getActiveAgentCliId(): AgentCliId {
  const value = normalizeAgentCliId(getPref(KEY_ACTIVE))
  if (value) return value
  return getDefaultAgentCliId()
}

export function setActiveAgentCliId(id: AgentCliId): void {
  if (!isAgentCliId(id)) throw new Error(`Invalid agent CLI id: ${id}`)
  setPref(KEY_ACTIVE, id)
}
