/**
 * Discover external provider/settings sources and import on user request.
 *
 * Sources (read-only until imported):
 * - Claude Code: ~/.claude/settings.json env (API key / base URL / models)
 * - cc-haha desktop: ~/.claude/cc-haha/providers.json
 * - haha brand folder: ~/.claude/haha/providers.json (when not the active data dir)
 *
 * Rules:
 * - Never auto-merge into the active store
 * - Never switch the active write root to an external dir
 * - User selects which candidates to import
 * - Name collisions get a source label suffix: "Name (cc-haha)"
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import type {
  ApiFormat,
  ProviderAuthStrategy,
  ProviderImportedFrom,
  ProvidersIndex,
  SavedProvider,
} from '../types/provider.js'
import {
  HAHA_DIR_NAME,
  LEGACY_HAHA_DIR_NAME,
  listSiblingHahaDataDirs,
  resolveClaudeConfigDir,
  resolveHahaDataDir,
} from './ccHahaPaths.js'
import { normalizeProvidersIndex, normalizeSavedProvider } from './providerRuntimeEnv.js'

export type ExternalSourceId = 'claude-code' | 'cc-haha' | 'haha'

export type ExternalSourceSummary = {
  id: ExternalSourceId
  label: string
  path: string
  kind: 'claude-settings' | 'providers-json'
  available: boolean
  candidateCount: number
  isActiveDataDir: boolean
}

export type ExternalProviderCandidate = {
  /** Stable key for import selection: sourceId:externalId */
  key: string
  sourceId: ExternalSourceId
  sourceLabel: string
  sourcePath: string
  externalId: string
  name: string
  /** Display name that would be used on import (may include source suffix). */
  proposedName: string
  nameConflict: boolean
  baseUrl: string
  presetId: string
  apiFormat: ApiFormat
  authStrategy?: ProviderAuthStrategy
  models: SavedProvider['models']
  toolSearchEnabled?: boolean
  notes?: string
  modelContextWindows?: SavedProvider['modelContextWindows']
  autoCompactWindow?: number
  maskedKey: string
  fingerprint: string
  alreadyImported: boolean
}

type CandidateWithSecret = ExternalProviderCandidate & { __apiKey: string }

export type ExternalImportResult = {
  imported: Array<{ key: string; id: string; name: string }>
  skipped: Array<{ key: string; reason: string }>
}

const SOURCE_LABELS: Record<ExternalSourceId, string> = {
  'claude-code': 'Claude Code',
  'cc-haha': 'cc-haha',
  haha: 'haha',
}

function maskSecret(secret: string): string {
  const s = secret.trim()
  if (s.length <= 8) return '••••'
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

function fingerprintProvider(input: {
  baseUrl: string
  apiKey: string
  models: SavedProvider['models']
}): string {
  const body = [
    input.baseUrl.replace(/\/+$/, '').toLowerCase(),
    input.apiKey.trim(),
    input.models.main.trim(),
  ].join('|')
  return createHash('sha256').update(body).digest('hex').slice(0, 16)
}

/** Public for tests: build unique display name with source label on conflict. */
export function proposeProviderName(
  baseName: string,
  sourceLabel: string,
  existingNames: Iterable<string>,
): { name: string; conflict: boolean } {
  const taken = new Set(
    [...existingNames].map((n) => n.trim().toLowerCase()).filter(Boolean),
  )
  const base = baseName.trim() || 'Imported provider'
  if (!taken.has(base.toLowerCase())) {
    return { name: base, conflict: false }
  }
  const labeled = `${base} (${sourceLabel})`
  if (!taken.has(labeled.toLowerCase())) {
    return { name: labeled, conflict: true }
  }
  let i = 2
  while (taken.has(`${labeled} ${i}`.toLowerCase())) i += 1
  return { name: `${labeled} ${i}`, conflict: true }
}

function samePath(a: string, b: string): boolean {
  try {
    return normalize(resolve(a)).toLowerCase() === normalize(resolve(b)).toLowerCase()
  } catch {
    return a === b
  }
}

function readJsonFile(path: string): unknown | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

function claudeCodeSettingsPath(): string {
  return join(resolveClaudeConfigDir(), 'settings.json')
}

function parseClaudeCodeCandidate(
  activeProviders: SavedProvider[],
): CandidateWithSecret | null {
  const path = claudeCodeSettingsPath()
  const raw = readJsonFile(path)
  if (!raw || typeof raw !== 'object') return null
  const env =
    (raw as { env?: Record<string, unknown> }).env && typeof (raw as { env: unknown }).env === 'object'
      ? ((raw as { env: Record<string, unknown> }).env)
      : null
  if (!env) return null

  const apiKey =
    (typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN.trim())
    || (typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.trim())
    || ''
  if (!apiKey) return null

  const authStrategy: ProviderAuthStrategy =
    typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN.trim()
      ? 'auth_token'
      : 'api_key'
  const baseUrl =
    typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL.trim()
      ? env.ANTHROPIC_BASE_URL.trim()
      : 'https://api.anthropic.com'
  const main =
    (typeof env.ANTHROPIC_MODEL === 'string' && env.ANTHROPIC_MODEL.trim())
    || 'claude-sonnet-4-20250514'
  const models: SavedProvider['models'] = {
    main,
    haiku:
      (typeof env.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'string' && env.ANTHROPIC_DEFAULT_HAIKU_MODEL.trim())
      || main,
    sonnet:
      (typeof env.ANTHROPIC_DEFAULT_SONNET_MODEL === 'string' && env.ANTHROPIC_DEFAULT_SONNET_MODEL.trim())
      || main,
    opus:
      (typeof env.ANTHROPIC_DEFAULT_OPUS_MODEL === 'string' && env.ANTHROPIC_DEFAULT_OPUS_MODEL.trim())
      || main,
    ...(typeof env.ANTHROPIC_DEFAULT_FABLE_MODEL === 'string' && env.ANTHROPIC_DEFAULT_FABLE_MODEL.trim()
      ? { fable: env.ANTHROPIC_DEFAULT_FABLE_MODEL.trim() }
      : {}),
  }

  const sourceId: ExternalSourceId = 'claude-code'
  const sourceLabel = SOURCE_LABELS[sourceId]
  const externalId = 'settings-env'
  const name = 'Claude Code'
  const fp = fingerprintProvider({ baseUrl, apiKey, models })
  const alreadyImported = activeProviders.some(
    (p) =>
      p.importedFrom?.sourceId === sourceId
      && (p.importedFrom.externalId === externalId || p.importedFrom.fingerprint === fp),
  )
  const { name: proposedName, conflict } = proposeProviderName(
    name,
    sourceLabel,
    activeProviders.map((p) => p.name),
  )

  return {
    key: `${sourceId}:${externalId}`,
    sourceId,
    sourceLabel,
    sourcePath: path,
    externalId,
    name,
    proposedName,
    nameConflict: conflict,
    baseUrl,
    presetId: 'claude',
    apiFormat: 'anthropic',
    authStrategy,
    models,
    maskedKey: maskSecret(apiKey),
    fingerprint: fp,
    alreadyImported,
    __apiKey: apiKey,
  }
}

function providersFromJsonFile(
  sourceId: ExternalSourceId,
  filePath: string,
  activeProviders: SavedProvider[],
  activeDir: string,
): CandidateWithSecret[] {
  if (!existsSync(filePath)) return []
  // Skip if this file is the active product index (already local).
  const activeIndex = join(activeDir, 'providers.json')
  if (samePath(filePath, activeIndex)) return []

  const parsed = readJsonFile(filePath)
  const index = normalizeProvidersIndex(parsed)
  if (!index) return []

  const sourceLabel = SOURCE_LABELS[sourceId]
  const existingNames = activeProviders.map((p) => p.name)
  const out: CandidateWithSecret[] = []

  for (const provider of index.providers) {
    const normalized = normalizeSavedProvider(provider)
    if (!normalized.apiKey?.trim()) continue
    const fp = fingerprintProvider({
      baseUrl: normalized.baseUrl,
      apiKey: normalized.apiKey,
      models: normalized.models,
    })
    const alreadyImported = activeProviders.some(
      (p) =>
        (p.importedFrom?.sourceId === sourceId && p.importedFrom.externalId === normalized.id)
        || p.importedFrom?.fingerprint === fp
        || (
          p.baseUrl.replace(/\/+$/, '').toLowerCase() === normalized.baseUrl.replace(/\/+$/, '').toLowerCase()
          && p.apiKey === normalized.apiKey
        ),
    )
    const { name: proposedName, conflict } = proposeProviderName(
      normalized.name,
      sourceLabel,
      existingNames,
    )
    // Reserve proposed name for subsequent candidates in same batch.
    existingNames.push(proposedName)

    out.push({
      key: `${sourceId}:${normalized.id}`,
      sourceId,
      sourceLabel,
      sourcePath: filePath,
      externalId: normalized.id,
      name: normalized.name,
      proposedName,
      nameConflict: conflict,
      baseUrl: normalized.baseUrl,
      presetId: normalized.presetId,
      apiFormat: normalized.apiFormat ?? 'anthropic',
      authStrategy: normalized.authStrategy,
      models: normalized.models,
      maskedKey: maskSecret(normalized.apiKey),
      fingerprint: fp,
      alreadyImported,
      __apiKey: normalized.apiKey,
      ...(normalized.toolSearchEnabled !== undefined
        ? { toolSearchEnabled: normalized.toolSearchEnabled }
        : {}),
      ...(normalized.notes ? { notes: normalized.notes } : {}),
      ...(normalized.modelContextWindows
        ? { modelContextWindows: normalized.modelContextWindows }
        : {}),
      ...(normalized.autoCompactWindow != null
        ? { autoCompactWindow: normalized.autoCompactWindow }
        : {}),
    })
  }
  return out
}

function collectAllCandidates(activeProviders: SavedProvider[]): CandidateWithSecret[] {
  const activeDir = resolveHahaDataDir()
  const siblings = listSiblingHahaDataDirs(activeDir)
  const list: CandidateWithSecret[] = []

  const claude = parseClaudeCodeCandidate(activeProviders)
  if (claude) list.push(claude)

  list.push(
    ...providersFromJsonFile(
      'cc-haha',
      join(siblings.legacy, 'providers.json'),
      activeProviders,
      activeDir,
    ),
  )
  list.push(
    ...providersFromJsonFile(
      'haha',
      join(siblings.primary, 'providers.json'),
      activeProviders,
      activeDir,
    ),
  )

  return list
}

function toPublicCandidate(c: CandidateWithSecret): ExternalProviderCandidate {
  const { __apiKey: _secret, ...rest } = c
  return rest
}

export function listExternalSources(activeProviders: SavedProvider[]): ExternalSourceSummary[] {
  const activeDir = resolveHahaDataDir()
  const siblings = listSiblingHahaDataDirs(activeDir)
  const candidates = collectAllCandidates(activeProviders)

  const count = (id: ExternalSourceId) => candidates.filter((c) => c.sourceId === id).length

  return [
    {
      id: 'claude-code',
      label: SOURCE_LABELS['claude-code'],
      path: claudeCodeSettingsPath(),
      kind: 'claude-settings',
      available: existsSync(claudeCodeSettingsPath()),
      candidateCount: count('claude-code'),
      isActiveDataDir: false,
    },
    {
      id: 'cc-haha',
      label: SOURCE_LABELS['cc-haha'],
      path: join(siblings.legacy, 'providers.json'),
      kind: 'providers-json',
      available: existsSync(join(siblings.legacy, 'providers.json')),
      candidateCount: count('cc-haha'),
      isActiveDataDir: samePath(siblings.legacy, activeDir),
    },
    {
      id: 'haha',
      label: SOURCE_LABELS.haha,
      path: join(siblings.primary, 'providers.json'),
      kind: 'providers-json',
      available: existsSync(join(siblings.primary, 'providers.json')),
      candidateCount: count('haha'),
      isActiveDataDir: samePath(siblings.primary, activeDir),
    },
  ]
}

export function listExternalProviderCandidates(
  activeProviders: SavedProvider[],
): ExternalProviderCandidate[] {
  return collectAllCandidates(activeProviders).map(toPublicCandidate)
}

export function buildImportedProvider(
  candidate: CandidateWithSecret,
  nowIso: string,
): SavedProvider {
  const importedFrom: ProviderImportedFrom = {
    sourceId: candidate.sourceId,
    sourceLabel: candidate.sourceLabel,
    sourcePath: candidate.sourcePath,
    externalId: candidate.externalId,
    fingerprint: candidate.fingerprint,
    importedAt: nowIso,
  }

  return normalizeSavedProvider({
    id: randomUUID(),
    presetId: candidate.presetId || 'custom',
    name: candidate.proposedName,
    apiKey: candidate.__apiKey,
    authStrategy: candidate.authStrategy,
    baseUrl: candidate.baseUrl,
    apiFormat: candidate.apiFormat ?? 'anthropic',
    runtimeKind: 'anthropic_compatible',
    models: candidate.models,
    ...(candidate.toolSearchEnabled !== undefined
      ? { toolSearchEnabled: candidate.toolSearchEnabled }
      : {}),
    ...(candidate.notes ? { notes: candidate.notes } : {}),
    ...(candidate.modelContextWindows
      ? { modelContextWindows: candidate.modelContextWindows }
      : {}),
    ...(candidate.autoCompactWindow != null
      ? { autoCompactWindow: candidate.autoCompactWindow }
      : {}),
    createdAt: nowIso,
    updatedAt: nowIso,
    importedFrom,
    accountInfo: {
      type: 'imported',
      accountLabel: candidate.sourceLabel,
    },
  })
}

/**
 * Import selected external keys into the given index (does not write disk).
 * Caller persists the returned index.
 */
export function importExternalProvidersIntoIndex(
  index: ProvidersIndex,
  keys: string[],
): { index: ProvidersIndex; result: ExternalImportResult } {
  const wanted = new Set(keys.map((k) => k.trim()).filter(Boolean))
  const candidates = collectAllCandidates(index.providers)
  const byKey = new Map(candidates.map((c) => [c.key, c]))
  const imported: ExternalImportResult['imported'] = []
  const skipped: ExternalImportResult['skipped'] = []
  const nextProviders = [...index.providers]
  const nextOrder = [...index.providerOrder]
  const now = new Date().toISOString()
  const names = nextProviders.map((p) => p.name)

  for (const key of wanted) {
    const candidate = byKey.get(key)
    if (!candidate) {
      skipped.push({ key, reason: '候选不存在或源文件不可读' })
      continue
    }
    if (candidate.alreadyImported) {
      skipped.push({ key, reason: '已导入过（同源或相同凭据指纹）' })
      continue
    }
    // Recompute name against latest names in this batch
    const { name: proposedName, conflict } = proposeProviderName(
      candidate.name,
      candidate.sourceLabel,
      names,
    )
    const toImport = {
      ...candidate,
      proposedName,
      nameConflict: conflict,
    }
    const saved = buildImportedProvider(toImport, now)
    nextProviders.push(saved)
    nextOrder.push(saved.id)
    names.push(saved.name)
    imported.push({ key, id: saved.id, name: saved.name })
  }

  return {
    index: {
      ...index,
      providers: nextProviders,
      providerOrder: nextOrder,
    },
    result: { imported, skipped },
  }
}

/** Re-export labels for UI tests */
export const EXTERNAL_SOURCE_LABELS = SOURCE_LABELS
export { HAHA_DIR_NAME, LEGACY_HAHA_DIR_NAME }
