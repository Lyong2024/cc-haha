/**
 * Probe host PATH for Agent CLIs, local versions, multi-install conflicts,
 * and latest npm registry versions.
 *
 * Inspired by cc-switch:
 * - get_tool_versions: local + latest + installed_but_broken
 * - probe_tool_installations: multi-path + is_path_default + conflict
 * - Windows: careful with .cmd/.bat (shell: true when needed)
 */

import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  getAgentCliDefinition,
  listAgentCliDefinitions,
  primaryNpmPackage,
} from './registry.js'
import type {
  AgentCliDefinition,
  AgentCliId,
  ProbeReport,
  ToolInstallRow,
} from './types.js'

const execFileAsync = promisify(execFile)

const PROBE_TIMEOUT_MS = 6_000
const LATEST_CACHE_TTL_MS = 10 * 60 * 1000

const latestVersionCache = new Map<string, { version: string | null; at: number }>()

export function parseVersionFromOutput(text: string): string | null {
  const raw = (text ?? '').trim()
  if (!raw) return null
  // Prefer first semver-like token (handles "claude 1.2.3", "v1.2.3", multi-line banners).
  const match = raw.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)
  if (match?.[1]) return match[1]
  // Fallback: first non-empty line cleaned of prefixes.
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
  if (!line) return null
  const cleaned = line.replace(/^[^\d]*/, '').trim()
  return cleaned || line
}

/** Monorepo / workspace builds (e.g. package.json "999.0.0-local") are not release versions. */
export function isLocalDevVersion(version: string | null | undefined): boolean {
  if (!version) return false
  const v = version.trim().toLowerCase()
  return (
    v.includes('-local')
    || v.endsWith('.local')
    || /^999\./.test(v)
    || v === '0.0.0'
    || v === 'dev'
    || v === 'development'
  )
}

function isWorkspaceDevPath(path: string): boolean {
  const p = path.replace(/\\/g, '/').toLowerCase()
  return (
    p.includes('/bin/claude-haha')
    || p.endsWith('/claude-haha')
    || p.endsWith('/claude-haha.cmd')
    || p.endsWith('/claude-haha.ts')
    || p.includes('/haha/bin/')
  )
}

function isWindows(): boolean {
  return process.platform === 'win32'
}

/** Resolve all absolute paths for a binary name (multi-install). */
export function resolveBinaryPaths(binary: string): string[] {
  try {
    if (isWindows()) {
      const out = execFileSync('where.exe', [binary], {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    }
    // which -a lists all; fall back to which
    try {
      const out = execFileSync('which', ['-a', binary], {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    } catch {
      const out = execFileSync('which', [binary], {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    }
  } catch {
    return []
  }
}

async function runVersionCommand(
  executable: string,
  args: string[],
): Promise<{ ok: boolean; version: string | null; error?: string }> {
  try {
    // On Windows, .cmd/.bat need shell; cc-switch fixed quoting issues here.
    const needsShell =
      isWindows() &&
      (/\.(cmd|bat)$/i.test(executable) || !executable.includes('\\'))
    const { stdout, stderr } = await execFileAsync(executable, args, {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 256 * 1024,
      shell: needsShell,
      env: process.env,
    })
    const version = parseVersionFromOutput(`${stdout ?? ''}\n${stderr ?? ''}`)
    return { ok: true, version }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Some CLIs print version on non-zero exit — try to parse anyway.
    const any = err as { stdout?: string; stderr?: string }
    const version = parseVersionFromOutput(`${any.stdout ?? ''}\n${any.stderr ?? ''}`)
    if (version) return { ok: true, version }
    return { ok: false, version: null, error: message.slice(0, 300) }
  }
}

function resolveExtraCandidates(def: AgentCliDefinition): string[] {
  const roots = [
    process.cwd(),
    process.env.HAHA_REPO_ROOT?.trim() || '',
    join(homedir(), 'haha'),
  ].filter(Boolean)

  const found: string[] = []
  for (const rel of def.extraCandidates ?? []) {
    // Home-relative (~/.grok/bin/grok) and absolute paths (install roots).
    if (rel.startsWith('~/') || rel.startsWith('~\\')) {
      const abs = resolve(homedir(), rel.slice(2))
      if (existsSync(abs)) found.push(abs)
      continue
    }
    if (isAbsolute(rel)) {
      if (existsSync(rel)) found.push(rel)
      continue
    }
    for (const root of roots) {
      const abs = resolve(root, rel)
      if (existsSync(abs)) found.push(abs)
    }
  }
  return found
}

export async function fetchLatestNpmVersion(packageName: string): Promise<string | null> {
  const cached = latestVersionCache.get(packageName)
  if (cached && Date.now() - cached.at < LATEST_CACHE_TTL_MS) {
    return cached.version
  }
  try {
    const { stdout } = await execFileAsync(
      isWindows() ? 'npm.cmd' : 'npm',
      ['view', packageName, 'version', '--json'],
      {
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024,
        shell: isWindows(),
        env: process.env,
      },
    )
    let version: string | null = null
    const text = (stdout ?? '').trim()
    try {
      const parsed = JSON.parse(text) as string | { version?: string }
      version = typeof parsed === 'string' ? parsed : parsed.version ?? null
    } catch {
      version = parseVersionFromOutput(text)
    }
    latestVersionCache.set(packageName, { version, at: Date.now() })
    return version
  } catch {
    latestVersionCache.set(packageName, { version: null, at: Date.now() })
    return null
  }
}

/** Clear npm latest cache (tests). */
export function clearLatestVersionCacheForTests(): void {
  latestVersionCache.clear()
}

function compareSemverLoose(a: string | null, b: string | null): number {
  if (!a || !b) return 0
  const pa = a.replace(/^v/, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.replace(/^v/, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

export function isUpgradeAvailable(local: string | null, latest: string | null): boolean {
  if (!latest || !local) return false
  // Dev / monorepo shims (999.0.0-local) should always offer the published latest.
  if (isLocalDevVersion(local)) return true
  return compareSemverLoose(latest, local) > 0
}

/**
 * Pick the install row that best represents "what the user has installed"
 * for card summary — prefer PATH default, real npm releases over monorepo
 * 999.0.0-local shims, and official `claude` over workspace `claude-haha`.
 */
export function pickPrimaryInstall(installs: ToolInstallRow[]): ToolInstallRow | null {
  if (installs.length === 0) return null
  const score = (row: ToolInstallRow): number => {
    let s = 0
    if (row.runnable) s += 100
    if (row.isPathDefault) s += 40
    if (row.source === 'path') s += 20
    if (!isLocalDevVersion(row.version)) s += 50
    if (!isWorkspaceDevPath(row.path)) s += 30
    // Prefer official binary name over local alias when both exist.
    const base = row.path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
    if (base === 'claude' || base === 'claude.exe') s += 15
    if (base.startsWith('claude-haha')) s -= 10
    return s
  }
  return [...installs].sort((a, b) => score(b) - score(a))[0] ?? null
}

export async function probeOne(
  id: AgentCliId,
  options?: { skipLatest?: boolean },
): Promise<ProbeReport> {
  const def = getAgentCliDefinition(id)
  if (!def) {
    throw new Error(`Unknown agent CLI: ${id}`)
  }

  const installs: ToolInstallRow[] = []
  const seen = new Set<string>()

  for (const binary of def.binaries) {
    const paths = resolveBinaryPaths(binary)
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i]!
      if (seen.has(path.toLowerCase())) continue
      seen.add(path.toLowerCase())
      let version: string | null = null
      let runnable = false
      let error: string | undefined
      for (const flag of def.versionArgs) {
        const result = await runVersionCommand(path, [flag])
        if (result.ok) {
          version = result.version
          runnable = true
          break
        }
        error = result.error
      }
      installs.push({
        path,
        version,
        source: 'path',
        isPathDefault: installs.filter((r) => r.source === 'path').length === 0,
        runnable,
        error: runnable ? undefined : error,
      })
    }
  }

  for (const path of resolveExtraCandidates(def)) {
    if (seen.has(path.toLowerCase())) continue
    seen.add(path.toLowerCase())
    let version: string | null = null
    let runnable = false
    let error: string | undefined
    for (const flag of def.versionArgs) {
      const result = await runVersionCommand(path, [flag])
      if (result.ok) {
        version = result.version
        runnable = true
        break
      }
      error = result.error
    }
    installs.push({
      path,
      version,
      source: 'extra',
      isPathDefault: false,
      runnable,
      error: runnable ? undefined : error,
    })
  }

  const defaultInstall = pickPrimaryInstall(installs)

  const installed = installs.length > 0
  const runnable = installs.some((row) => row.runnable)
  // Prefer a real release version for the card summary when a monorepo
  // 999.0.0-local shim is also on PATH (common in haha dev).
  const releaseInstall =
    installs.find((row) => row.runnable && !isLocalDevVersion(row.version) && !isWorkspaceDevPath(row.path))
    ?? installs.find((row) => row.runnable && !isLocalDevVersion(row.version))
    ?? null
  const localVersion = releaseInstall?.version ?? defaultInstall?.version ?? null
  const installedButBroken = installed && !runnable

  const npmPackage = primaryNpmPackage(def)
  let latestVersion: string | null = null
  if (!options?.skipLatest && npmPackage) {
    latestVersion = await fetchLatestNpmVersion(npmPackage)
  }

  const releaseVersions = new Set(
    installs
      .map((r) => r.version)
      .filter((v): v is string => !!v && !isLocalDevVersion(v)),
  )
  const hasConflict =
    installs.filter((row) => row.source === 'path' && !isWorkspaceDevPath(row.path)).length > 1
    || releaseVersions.size > 1

  return {
    id: def.id,
    displayName: def.displayName,
    installed,
    runnable,
    localVersion,
    latestVersion,
    installedButBroken,
    installs,
    hasConflict,
    maturity: def.maturity,
    npmPackage,
    upgradeAvailable: isUpgradeAvailable(
      releaseInstall?.version ?? localVersion,
      latestVersion,
    ),
    error: installedButBroken
      ? defaultInstall?.error ?? 'Installed but not runnable'
      : null,
    probedAt: new Date().toISOString(),
  }
}

export async function probeAll(options?: {
  skipLatest?: boolean
}): Promise<ProbeReport[]> {
  const defs = listAgentCliDefinitions()
  // Parallel probe; each binary is short-lived.
  return Promise.all(defs.map((def) => probeOne(def.id, options)))
}
