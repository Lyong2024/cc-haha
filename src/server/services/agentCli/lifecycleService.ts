/**
 * Install / upgrade Agent CLIs via allowlisted strategies (npm + official shell).
 * Mirrors cc-switch run_tool_lifecycle_action:
 * - npm: npm i -g @pkg@latest (anchored where possible)
 * - Codex: reinstall via npm (never bare `codex update`)
 * - Jobs with append-only log for UI polling
 * - Server console + diagnostics for operator visibility
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { diagnosticsService } from '../diagnosticsService.js'
import { getWebControlDatabase } from '../webControlDb.js'
import { getAgentCliDefinition, primaryNpmPackage } from './registry.js'
import { probeOne } from './probeService.js'
import type {
  AgentCliId,
  AgentCliJob,
  AgentCliJobStatus,
  InstallScope,
  InstallStrategy,
} from './types.js'

const execFileAsync = promisify(execFile)
const JOB_TIMEOUT_MS = 10 * 60 * 1000

const memoryJobs = new Map<string, AgentCliJob>()

function isWindows(): boolean {
  return process.platform === 'win32'
}

function nowIso(): string {
  return new Date().toISOString()
}

function npmCommand(): string {
  return isWindows() ? 'npm.cmd' : 'npm'
}

function isAllowedInstallUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    const allow = ['opencode.ai', 'www.opencode.ai']
    return allow.some((h) => host === h || host.endsWith(`.${h}`))
  } catch {
    return false
  }
}

function rowToJob(row: {
  id: string
  cli_id: string
  action: string
  scope: string
  status: string
  log: string | null
  error: string | null
  created_at: string
  updated_at: string
  version: string | null
}): AgentCliJob {
  return {
    id: row.id,
    cliId: row.cli_id as AgentCliId,
    action: row.action as 'install' | 'upgrade',
    scope: row.scope as InstallScope,
    version: row.version,
    status: row.status as AgentCliJobStatus,
    log: row.log ?? '',
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function persistJob(job: AgentCliJob): void {
  memoryJobs.set(job.id, job)
  try {
    const { db } = getWebControlDatabase()
    db.query(
      `INSERT INTO agent_cli_jobs (id, cli_id, action, scope, status, log, error, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         log = excluded.log,
         error = excluded.error,
         updated_at = excluded.updated_at`,
    ).run(
      job.id,
      job.cliId,
      job.action,
      job.scope,
      job.status,
      job.log,
      job.error,
      job.version,
      job.createdAt,
      job.updatedAt,
    )
  } catch {
    // DB may not be available in unit tests without open — memory still works.
  }
}

function agentCliConsole(
  level: 'info' | 'warn' | 'error',
  message: string,
  details?: Record<string, unknown>,
): void {
  const prefix = `[AgentCLI]`
  const suffix = details ? ` ${JSON.stringify(details)}` : ''
  if (level === 'error') console.error(`${prefix} ${message}${suffix}`)
  else if (level === 'warn') console.warn(`${prefix} ${message}${suffix}`)
  else console.info(`${prefix} ${message}${suffix}`)
}

function recordAgentCliEvent(
  type: string,
  severity: 'info' | 'warn' | 'error',
  summary: string,
  details?: Record<string, unknown>,
): void {
  void diagnosticsService.recordEvent({
    type,
    severity,
    summary,
    details,
  })
}

function appendLog(job: AgentCliJob, line: string): AgentCliJob {
  const next: AgentCliJob = {
    ...job,
    log: job.log ? `${job.log}\n${line}` : line,
    updatedAt: nowIso(),
  }
  persistJob(next)
  // Stream every job log line to the server console for operators.
  agentCliConsole('info', `[job ${job.id.slice(0, 8)} ${job.cliId}] ${line}`)
  return next
}

export function getAgentCliJob(jobId: string): AgentCliJob | null {
  const mem = memoryJobs.get(jobId)
  if (mem) return mem
  try {
    const { db } = getWebControlDatabase()
    const row = db
      .query<
        {
          id: string
          cli_id: string
          action: string
          scope: string
          status: string
          log: string | null
          error: string | null
          created_at: string
          updated_at: string
          version: string | null
        },
        [string]
      >(
        `SELECT id, cli_id, action, scope, status, log, error, version, created_at, updated_at
         FROM agent_cli_jobs WHERE id = ?`,
      )
      .get(jobId)
    if (!row) return null
    const job = rowToJob(row)
    memoryJobs.set(job.id, job)
    return job
  } catch {
    return null
  }
}

async function runNpmInstall(
  packageName: string,
  version: string | null,
  scope: InstallScope,
  onLog: (line: string) => void,
): Promise<void> {
  const target = version && version !== 'latest'
    ? `${packageName}@${version}`
    : `${packageName}@latest`

  // User scope: prefer prefix under home when possible; system uses default global.
  const args = ['install', '-g', target, '--no-fund', '--no-audit']
  if (scope === 'user' && process.env.npm_config_prefix) {
    // honor existing user prefix
  }

  onLog(`$ ${npmCommand()} ${args.join(' ')}`)
  onLog(`scope=${scope} package=${target}`)

  const { stdout, stderr } = await execFileAsync(npmCommand(), args, {
    timeout: JOB_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    shell: isWindows(),
    env: {
      ...process.env,
      // Reduce interactive prompts.
      npm_config_yes: 'true',
    },
  })
  if (stdout?.trim()) onLog(stdout.trim().slice(0, 8_000))
  if (stderr?.trim()) onLog(stderr.trim().slice(0, 4_000))
}

async function runShellInstaller(
  strategy: Extract<InstallStrategy, { kind: 'shell' }>,
  onLog: (line: string) => void,
): Promise<void> {
  if (!isAllowedInstallUrl(strategy.url)) {
    throw new Error(`Installer URL not allowlisted: ${strategy.url}`)
  }
  if (strategy.shell === 'powershell' || isWindows()) {
    const cmd = `irm ${strategy.url} | iex`
    onLog(`$ ${cmd}`)
    const { stdout, stderr } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      {
        timeout: JOB_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
      },
    )
    if (stdout?.trim()) onLog(stdout.trim().slice(0, 8_000))
    if (stderr?.trim()) onLog(stderr.trim().slice(0, 4_000))
    return
  }
  const cmd = `curl -fsSL ${strategy.url} | bash`
  onLog(`$ ${cmd}`)
  const { stdout, stderr } = await execFileAsync('bash', ['-lc', cmd], {
    timeout: JOB_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  })
  if (stdout?.trim()) onLog(stdout.trim().slice(0, 8_000))
  if (stderr?.trim()) onLog(stderr.trim().slice(0, 4_000))
}

async function executeLifecycle(
  job: AgentCliJob,
  strategies: InstallStrategy[],
): Promise<void> {
  let current = job
  const onLog = (line: string) => {
    current = appendLog(current, line)
  }

  if (strategies.length === 0) {
    const message =
      'No automated install strategy for this CLI (native/manual install only). See homepage or manualCommand.'
    onLog(message)
    current = {
      ...current,
      status: 'failed',
      error: message,
      updatedAt: nowIso(),
    }
    persistJob(current)
    recordAgentCliEvent(
      'agent_cli.lifecycle.failed',
      'warn',
      `Agent CLI ${job.action} failed: ${job.cliId} (no strategy)`,
      { jobId: job.id, cliId: job.cliId, action: job.action, error: message },
    )
    return
  }

  let lastError: Error | null = null
  for (const strategy of strategies) {
    try {
      onLog(
        strategy.kind === 'npm'
          ? `Trying npm strategy: ${strategy.packageName}`
          : `Trying shell strategy: ${strategy.url}`,
      )
      if (strategy.kind === 'npm') {
        await runNpmInstall(strategy.packageName, job.version, job.scope, onLog)
        current = {
          ...current,
          status: 'succeeded',
          error: null,
          updatedAt: nowIso(),
        }
        persistJob(current)
        recordAgentCliEvent(
          'agent_cli.lifecycle.succeeded',
          'info',
          `Agent CLI ${job.action} succeeded: ${job.cliId}`,
          {
            jobId: job.id,
            cliId: job.cliId,
            action: job.action,
            scope: job.scope,
            version: job.version,
            strategy: strategy.kind,
            packageName: strategy.packageName,
          },
        )
        return
      }
      if (strategy.kind === 'shell') {
        await runShellInstaller(strategy, onLog)
        current = {
          ...current,
          status: 'succeeded',
          error: null,
          updatedAt: nowIso(),
        }
        persistJob(current)
        recordAgentCliEvent(
          'agent_cli.lifecycle.succeeded',
          'info',
          `Agent CLI ${job.action} succeeded: ${job.cliId}`,
          {
            jobId: job.id,
            cliId: job.cliId,
            action: job.action,
            scope: job.scope,
            version: job.version,
            strategy: strategy.kind,
            url: strategy.url,
          },
        )
        return
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      onLog(`strategy failed: ${lastError.message}`)
      agentCliConsole('warn', `strategy failed for ${job.cliId}`, {
        jobId: job.id,
        error: lastError.message.slice(0, 500),
      })
    }
  }

  const failMessage = lastError?.message ?? 'All install strategies failed'
  current = {
    ...current,
    status: 'failed',
    error: failMessage,
    updatedAt: nowIso(),
  }
  persistJob(current)
  recordAgentCliEvent(
    'agent_cli.lifecycle.failed',
    'error',
    `Agent CLI ${job.action} failed: ${job.cliId}`,
    {
      jobId: job.id,
      cliId: job.cliId,
      action: job.action,
      scope: job.scope,
      version: job.version,
      error: failMessage.slice(0, 1500),
    },
  )
}

export type StartLifecycleOptions = {
  cliId: AgentCliId
  action: 'install' | 'upgrade'
  scope?: InstallScope
  version?: string | null
  confirmSystem?: boolean
}

export function startAgentCliLifecycle(options: StartLifecycleOptions): AgentCliJob {
  const def = getAgentCliDefinition(options.cliId)
  if (!def) {
    throw new Error(`Unknown agent CLI: ${options.cliId}`)
  }

  const scope: InstallScope = options.scope ?? 'user'
  if (scope === 'system' && !options.confirmSystem) {
    throw new Error('System-scope install requires confirmSystem: true')
  }

  // For upgrade: prefer reinstall strategies (Codex trap from cc-switch).
  let strategies = [...def.installStrategies]
  if (options.action === 'upgrade') {
    strategies = strategies.map((s) => {
      if (s.kind === 'npm' && s.preferReinstallOnUpgrade) {
        return s
      }
      return s
    })
    // Prefer npm reinstall over shell on upgrade when both exist.
    strategies.sort((a, b) => {
      if (a.kind === 'npm' && b.kind !== 'npm') return -1
      if (a.kind !== 'npm' && b.kind === 'npm') return 1
      return 0
    })
  }

  const job: AgentCliJob = {
    id: randomUUID(),
    cliId: options.cliId,
    action: options.action,
    scope,
    version: options.version ?? 'latest',
    status: 'queued',
    log: `Queued ${options.action} for ${def.displayName}`,
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
  persistJob(job)

  agentCliConsole('info', `queued ${options.action}`, {
    jobId: job.id,
    cliId: options.cliId,
    displayName: def.displayName,
    scope,
    version: job.version,
    strategies: strategies.map((s) =>
      s.kind === 'npm' ? `npm:${s.packageName}` : `shell:${s.url}`,
    ),
  })
  recordAgentCliEvent(
    'agent_cli.lifecycle.queued',
    'info',
    `Agent CLI ${options.action} queued: ${def.displayName}`,
    {
      jobId: job.id,
      cliId: options.cliId,
      action: options.action,
      scope,
      version: job.version,
    },
  )

  // Fire-and-forget background job.
  void (async () => {
    let running: AgentCliJob = {
      ...job,
      status: 'running',
      updatedAt: nowIso(),
    }
    persistJob(running)
    running = appendLog(running, `Starting ${options.action}…`)
    recordAgentCliEvent(
      'agent_cli.lifecycle.running',
      'info',
      `Agent CLI ${options.action} running: ${def.displayName}`,
      { jobId: job.id, cliId: options.cliId, action: options.action, scope },
    )
    try {
      await executeLifecycle(running, strategies)
      const after = getAgentCliJob(job.id)
      if (after?.status === 'succeeded') {
        const report = await probeOne(options.cliId, { skipLatest: false })
        appendLog(
          after,
          `Probe after ${options.action}: installed=${report.installed} runnable=${report.runnable} version=${report.localVersion ?? 'n/a'}`,
        )
      } else if (after?.status === 'failed') {
        agentCliConsole('error', `${options.action} failed`, {
          jobId: job.id,
          cliId: options.cliId,
          error: after.error,
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const failed: AgentCliJob = {
        ...(getAgentCliJob(job.id) ?? running),
        status: 'failed',
        error: message,
        updatedAt: nowIso(),
      }
      failed.log = `${failed.log}\nERROR: ${message}`
      persistJob(failed)
      agentCliConsole('error', `${options.action} crashed`, {
        jobId: job.id,
        cliId: options.cliId,
        error: message,
      })
      recordAgentCliEvent(
        'agent_cli.lifecycle.failed',
        'error',
        `Agent CLI ${options.action} crashed: ${options.cliId}`,
        { jobId: job.id, cliId: options.cliId, action: options.action, error: message },
      )
    }
  })()

  return job
}

/** Build the human-readable command users can run manually (system scope fallback). */
export function suggestManualInstallCommand(
  cliId: AgentCliId,
  action: 'install' | 'upgrade',
  version?: string | null,
): string | null {
  const def = getAgentCliDefinition(cliId)
  if (!def) return null
  const pkg = primaryNpmPackage(def)
  if (pkg) {
    const target = version && version !== 'latest' ? `${pkg}@${version}` : `${pkg}@latest`
    return `npm install -g ${target}`
  }
  const shell = def.installStrategies.find((s) => s.kind === 'shell')
  if (shell && shell.kind === 'shell') {
    if (isWindows()) return `irm ${shell.url} | iex`
    return `curl -fsSL ${shell.url} | bash`
  }
  return null
}

export function resetAgentCliJobsForTests(): void {
  memoryJobs.clear()
}
