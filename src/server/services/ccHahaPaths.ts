/**
 * Shared pure-web / desktop data directory resolution.
 *
 * Active product data root (write target):
 * 1. HAHA_DATA_DIR / CC_HAHA_DATA_DIR (explicit isolation, e.g. haha-web)
 * 2. else `~/.claude/haha` if present
 * 3. else legacy `~/.claude/cc-haha` if present
 * 4. else create/use `~/.claude/haha`
 *
 * External sources (Claude Code settings, sibling brand folders) are NOT
 * auto-selected as the write root. Discovery + user-opt-in import lives in
 * externalProviderSources.ts — no mechanical merge, no silent directory swap.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Current product data folder name under CLAUDE_CONFIG_DIR. */
export const HAHA_DIR_NAME = 'haha'
/** Pre-rename folder — still accepted for existing user data. */
export const LEGACY_HAHA_DIR_NAME = 'cc-haha'

/**
 * Mirror legacy `CC_HAHA_*` env vars onto `HAHA_*` when the new name is unset.
 * Also mirrors the reverse so mixed call sites keep working. Idempotent.
 */
export function applyLegacyHahaEnvAliases(): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('CC_HAHA_')) {
      const next = `HAHA_${key.slice('CC_HAHA_'.length)}`
      if (process.env[next] === undefined) process.env[next] = value
    } else if (key.startsWith('HAHA_') && !key.startsWith('HAHA_LEGACY_')) {
      const legacy = `CC_HAHA_${key.slice('HAHA_'.length)}`
      if (process.env[legacy] === undefined) process.env[legacy] = value
    }
  }
}

/** Claude Code user config home (`~/.claude` by default). */
export function resolveClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
}

/**
 * Active product data directory (current app instance write root).
 * Does not auto-hijack to a heavier sibling install — import is user-driven.
 */
export function resolveHahaDataDir(override?: string): string {
  applyLegacyHahaEnvAliases()
  if (override?.trim()) return override.trim()
  const fromEnv =
    process.env.HAHA_DATA_DIR?.trim()
    || process.env.CC_HAHA_DATA_DIR?.trim()
  if (fromEnv) return fromEnv
  const configDir = resolveClaudeConfigDir()
  const primary = join(configDir, HAHA_DIR_NAME)
  const legacy = join(configDir, LEGACY_HAHA_DIR_NAME)
  try {
    if (existsSync(primary)) return primary
    if (existsSync(legacy)) return legacy
  } catch {
    // fall through
  }
  return primary
}

/** Absolute paths that may hold external (importable) product data. */
export function listSiblingHahaDataDirs(activeDir?: string): {
  primary: string
  legacy: string
  active: string
} {
  const configDir = resolveClaudeConfigDir()
  const active = activeDir?.trim() || resolveHahaDataDir()
  return {
    primary: join(configDir, HAHA_DIR_NAME),
    legacy: join(configDir, LEGACY_HAHA_DIR_NAME),
    active,
  }
}

/** @deprecated Prefer resolveHahaDataDir */
export const resolveCcHahaDataDir = resolveHahaDataDir

export function resolveHahaOAuthFile(filename: string, override?: string): string {
  return join(resolveHahaDataDir(override), filename)
}

/** @deprecated Prefer resolveHahaOAuthFile */
export const resolveCcHahaOAuthFile = resolveHahaOAuthFile
