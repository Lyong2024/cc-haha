/**
 * Public facade for multi-Agent CLI management.
 */

import { diagnosticsService } from '../diagnosticsService.js'
import { listAgentCliDefinitions, DEFAULT_AGENT_CLI_ID, isAgentCliId } from './registry.js'
import { probeAll, probeOne } from './probeService.js'
import {
  getAgentCliJob,
  startAgentCliLifecycle,
  suggestManualInstallCommand,
} from './lifecycleService.js'
import {
  getActiveAgentCliId,
  getDefaultAgentCliId,
  setActiveAgentCliId,
  setDefaultAgentCliId,
} from './prefsService.js'
import type {
  AgentCliId,
  AgentCliListResponse,
  InstallScope,
  ProbeReport,
} from './types.js'

export * from './types.js'
export {
  AGENT_CLI_REGISTRY,
  DEFAULT_AGENT_CLI_ID,
  getAgentCliDefinition,
  isAgentCliId,
  listAgentCliDefinitions,
} from './registry.js'
export {
  parseVersionFromOutput,
  isUpgradeAvailable,
  isLocalDevVersion,
  pickPrimaryInstall,
  clearLatestVersionCacheForTests,
} from './probeService.js'
export { resetAgentCliJobsForTests } from './lifecycleService.js'
export { getAgentCliAdapter } from './adapters.js'
export {
  listSessionsForCli,
  createSessionForCli,
  launchHostCli,
  chatWithCli,
  getSessionMessagesForCli,
  buildNonInteractiveArgs,
} from './runtimeService.js'

export async function listAgentCliStatus(options?: {
  skipLatest?: boolean
}): Promise<AgentCliListResponse> {
  const tools = await probeAll(options)
  let activeId = getActiveAgentCliId()
  const defaultId = getDefaultAgentCliId()
  // If stored active is not runnable, prefer default then first runnable CLI.
  const activeReport = tools.find((t) => t.id === activeId)
  if (!activeReport?.runnable) {
    const fallback =
      tools.find((t) => t.id === defaultId && t.runnable) ??
      tools.find((t) => t.runnable) ??
      null
    if (fallback) {
      activeId = fallback.id
      try {
        setActiveAgentCliId(activeId)
      } catch {
        // ignore persist failures in read path
      }
    }
  }
  return {
    tools,
    activeId,
    defaultId,
    anyInstalled: tools.some((t) => t.installed),
    anyRunnable: tools.some((t) => t.runnable),
    generatedAt: new Date().toISOString(),
  }
}

export async function getAgentCliDetail(
  id: AgentCliId,
  options?: { skipLatest?: boolean },
): Promise<ProbeReport> {
  return probeOne(id, options)
}

export async function forceProbeAgentCli(id: AgentCliId): Promise<ProbeReport> {
  console.info(`[AgentCLI] force probe → ${id}`)
  const report = await probeOne(id, { skipLatest: false })
  console.info(
    `[AgentCLI] probe result ${id}: installed=${report.installed} runnable=${report.runnable} version=${report.localVersion ?? 'n/a'}`,
  )
  void diagnosticsService.recordEvent({
    type: 'agent_cli.probe',
    severity: 'info',
    summary: `Probed Agent CLI ${id}`,
    details: {
      id,
      installed: report.installed,
      runnable: report.runnable,
      localVersion: report.localVersion,
      latestVersion: report.latestVersion,
    },
  })
  return report
}

export function setActiveAgentCli(id: AgentCliId): { activeId: AgentCliId } {
  setActiveAgentCliId(id)
  console.info(`[AgentCLI] set active → ${id}`)
  void diagnosticsService.recordEvent({
    type: 'agent_cli.set_active',
    severity: 'info',
    summary: `Active Agent CLI set to ${id}`,
    details: { id },
  })
  return { activeId: id }
}

export function setDefaultAgentCli(id: AgentCliId): { defaultId: AgentCliId } {
  setDefaultAgentCliId(id)
  console.info(`[AgentCLI] set default → ${id}`)
  void diagnosticsService.recordEvent({
    type: 'agent_cli.set_default',
    severity: 'info',
    summary: `Default Agent CLI set to ${id}`,
    details: { id },
  })
  return { defaultId: id }
}

export function startInstall(
  id: AgentCliId,
  opts: {
    scope?: InstallScope
    version?: string | null
    confirmSystem?: boolean
  } = {},
) {
  return startAgentCliLifecycle({
    cliId: id,
    action: 'install',
    scope: opts.scope,
    version: opts.version,
    confirmSystem: opts.confirmSystem,
  })
}

export function startUpgrade(
  id: AgentCliId,
  opts: {
    scope?: InstallScope
    version?: string | null
    confirmSystem?: boolean
  } = {},
) {
  return startAgentCliLifecycle({
    cliId: id,
    action: 'upgrade',
    scope: opts.scope,
    version: opts.version ?? 'latest',
    confirmSystem: opts.confirmSystem,
  })
}

export { getAgentCliJob, suggestManualInstallCommand, getActiveAgentCliId, getDefaultAgentCliId }

export function catalogSummary() {
  return listAgentCliDefinitions().map((d) => ({
    id: d.id,
    displayName: d.displayName,
    maturity: d.maturity,
    binaries: d.binaries,
  }))
}

// Ensure DEFAULT is always a valid id at load.
if (!isAgentCliId(DEFAULT_AGENT_CLI_ID)) {
  throw new Error('DEFAULT_AGENT_CLI_ID is invalid')
}
