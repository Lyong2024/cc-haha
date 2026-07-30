/**
 * Multi-Agent CLI management types (probe / install / upgrade / active).
 * Patterns adapted from farion1231/cc-switch tool lifecycle.
 */

export type AgentCliId =
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'kimi'
  | 'grok'
  | 'mistral'
  | 'opencode'
  | 'pi'

export type AgentCliMaturity = 'full' | 'beta' | 'manage-only'

export type InstallScope = 'user' | 'system'

export type InstallStrategy =
  | {
      kind: 'npm'
      packageName: string
      /** Prefer this when upgrading (avoid fake self-update CLIs like codex update). */
      preferReinstallOnUpgrade?: boolean
    }
  | {
      kind: 'shell'
      /** Official installer URL (curl/irm). Only allowlisted hosts. */
      url: string
      shell: 'bash' | 'powershell'
    }

export type AgentCliDefinition = {
  id: AgentCliId
  displayName: string
  /** Binary names to resolve on PATH (first match preferred for default). */
  binaries: string[]
  /** Flags tried in order for local version. */
  versionArgs: string[]
  installStrategies: InstallStrategy[]
  maturity: AgentCliMaturity
  /** Optional extra PATH-relative candidates (e.g. repo bin). */
  extraCandidates?: string[]
  homepage?: string
}

export type ToolInstallRow = {
  path: string
  version: string | null
  source: 'path' | 'extra' | 'npm-global' | 'unknown'
  isPathDefault: boolean
  runnable: boolean
  error?: string
}

export type ProbeReport = {
  id: AgentCliId
  displayName: string
  installed: boolean
  runnable: boolean
  localVersion: string | null
  latestVersion: string | null
  /** installed but version/run check failed */
  installedButBroken: boolean
  installs: ToolInstallRow[]
  hasConflict: boolean
  maturity: AgentCliMaturity
  npmPackage: string | null
  upgradeAvailable: boolean
  error: string | null
  probedAt: string
}

export type AgentCliJobStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export type AgentCliJob = {
  id: string
  cliId: AgentCliId
  action: 'install' | 'upgrade'
  scope: InstallScope
  version: string | null
  status: AgentCliJobStatus
  log: string
  error: string | null
  createdAt: string
  updatedAt: string
}

export type AgentCliListResponse = {
  tools: ProbeReport[]
  activeId: AgentCliId
  defaultId: AgentCliId
  anyInstalled: boolean
  anyRunnable: boolean
  generatedAt: string
}
