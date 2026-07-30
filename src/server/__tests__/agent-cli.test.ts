import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getWebControlDatabase,
  openWebControlDatabase,
  resetWebControlDatabaseSingletonForTests,
  WEB_CONTROL_SCHEMA_VERSION,
} from '../services/webControlDb.js'
import {
  AGENT_CLI_REGISTRY,
  DEFAULT_AGENT_CLI_ID,
  buildNonInteractiveArgs,
  clearLatestVersionCacheForTests,
  createSessionForCli,
  isAgentCliId,
  isLocalDevVersion,
  isUpgradeAvailable,
  listSessionsForCli,
  parseVersionFromOutput,
  pickPrimaryInstall,
  resetAgentCliJobsForTests,
  setActiveAgentCli,
  setDefaultAgentCli,
  getActiveAgentCliId,
  getDefaultAgentCliId,
  listAgentCliStatus,
  suggestManualInstallCommand,
} from '../services/agentCli/index.js'
import {
  appendAgentCliMessage,
  listAgentCliMessages,
} from '../services/agentCli/sessionStore.js'

let tempDir: string | null = null

afterEach(() => {
  resetAgentCliJobsForTests()
  clearLatestVersionCacheForTests()
  resetWebControlDatabaseSingletonForTests()
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Windows may briefly lock WAL files
    }
    tempDir = null
  }
})

describe('agent CLI registry', () => {
  test('exposes eight CLIs with default claude-code', () => {
    expect(AGENT_CLI_REGISTRY).toHaveLength(8)
    expect(DEFAULT_AGENT_CLI_ID).toBe('claude-code')
    expect(isAgentCliId('claude-code')).toBe(true)
    expect(isAgentCliId('not-a-cli')).toBe(false)
    const ids = AGENT_CLI_REGISTRY.map((d) => d.id)
    expect(ids).toContain('codex')
    expect(ids).toContain('opencode')
    expect(ids).toContain('pi')
    expect(ids).toContain('grok')
    expect(ids).not.toContain('groq-code')
    const grok = AGENT_CLI_REGISTRY.find((d) => d.id === 'grok')
    expect(grok?.binaries).toContain('grok')
    expect(grok?.displayName).toBe('Grok CLI')
    const kimi = AGENT_CLI_REGISTRY.find((d) => d.id === 'kimi')
    expect(kimi?.installStrategies.some(
      (s) => s.kind === 'npm' && s.packageName === '@moonshot-ai/kimi-code',
    )).toBe(true)
  })

  test('parseVersionFromOutput handles grok banner', () => {
    expect(parseVersionFromOutput('grok 0.2.114 (0c78503879)')).toBe('0.2.114')
  })

  test('parseVersionFromOutput handles banners and plain semver', () => {
    expect(parseVersionFromOutput('1.2.3')).toBe('1.2.3')
    expect(parseVersionFromOutput('claude 2.0.14 (Claude Code)')).toBe('2.0.14')
    expect(parseVersionFromOutput('v0.9.1\nextra')).toBe('0.9.1')
    expect(parseVersionFromOutput('')).toBe(null)
  })

  test('isUpgradeAvailable compares loose semver', () => {
    expect(isUpgradeAvailable('1.0.0', '1.0.1')).toBe(true)
    expect(isUpgradeAvailable('2.0.0', '1.9.9')).toBe(false)
    expect(isUpgradeAvailable(null, '1.0.0')).toBe(false)
    // Monorepo 999.0.0-local must not hide real npm upgrades
    expect(isLocalDevVersion('999.0.0-local')).toBe(true)
    expect(isUpgradeAvailable('999.0.0-local', '2.0.14')).toBe(true)
  })

  test('pickPrimaryInstall prefers release over monorepo shim', () => {
    const primary = pickPrimaryInstall([
      {
        path: 'C:\\Users\\x\\.local\\bin\\claude-haha.cmd',
        version: '999.0.0-local',
        source: 'path',
        isPathDefault: true,
        runnable: true,
      },
      {
        path: 'C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd',
        version: '2.0.14',
        source: 'path',
        isPathDefault: false,
        runnable: true,
      },
    ])
    expect(primary?.version).toBe('2.0.14')
  })

  test('suggestManualInstallCommand returns npm for known packages', () => {
    const cmd = suggestManualInstallCommand('claude-code', 'install')
    expect(cmd).toContain('npm install -g')
    expect(cmd).toContain('@anthropic-ai/claude-code')
  })
})

describe('agent CLI prefs + schema v4', () => {
  test('creates agent_cli_prefs and jobs tables and stores active/default', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'agent-cli-'))
    const prevDataDir = process.env.HAHA_DATA_DIR
    process.env.HAHA_DATA_DIR = tempDir
    resetWebControlDatabaseSingletonForTests()
    // Prefer singleton so prefsService + schema share the same temp DB.
    const control = openWebControlDatabase({ dataDir: tempDir })
    try {
      const version = control.db
        .query<{ value: string }, []>(
          `SELECT value FROM meta WHERE key = 'schema_version'`,
        )
        .get()
      expect(version?.value).toBe(String(WEB_CONTROL_SCHEMA_VERSION))

      const tables = control.db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_cli%'`,
        )
        .all()
        .map((r) => r.name)
        .sort()
      expect(tables).toEqual([
        'agent_cli_jobs',
        'agent_cli_messages',
        'agent_cli_prefs',
        'agent_cli_sessions',
      ])

      // Bind singleton to this file by re-opening via get path used by prefs.
      control.close()
      resetWebControlDatabaseSingletonForTests()
      getWebControlDatabase() // uses HAHA_DATA_DIR

      expect(getDefaultAgentCliId()).toBe('claude-code')
      setDefaultAgentCli('codex')
      expect(getDefaultAgentCliId()).toBe('codex')
      setActiveAgentCli('gemini')
      expect(getActiveAgentCliId()).toBe('gemini')
    } finally {
      resetWebControlDatabaseSingletonForTests()
      if (prevDataDir === undefined) delete process.env.HAHA_DATA_DIR
      else process.env.HAHA_DATA_DIR = prevDataDir
    }
  })
})

describe('agent CLI probe list', () => {
  test('listAgentCliStatus returns eight tools with anyRunnable flag', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'agent-cli-'))
    const prevDataDir = process.env.HAHA_DATA_DIR
    process.env.HAHA_DATA_DIR = tempDir
    resetWebControlDatabaseSingletonForTests()
    try {
      // skipLatest to keep unit test offline/fast
      const status = await listAgentCliStatus({ skipLatest: true })
      expect(status.tools).toHaveLength(8)
      expect(status.activeId).toBeTruthy()
      expect(status.defaultId).toBeTruthy()
      expect(typeof status.anyInstalled).toBe('boolean')
      expect(typeof status.anyRunnable).toBe('boolean')
      // At least one tool object shape
      const claude = status.tools.find((t) => t.id === 'claude-code')
      expect(claude).toBeTruthy()
      expect(claude?.displayName).toBe('Claude Code')
      expect(Array.isArray(claude?.installs)).toBe(true)
      expect(claude?.maturity).toBe('full')
    } finally {
      resetWebControlDatabaseSingletonForTests()
      if (prevDataDir === undefined) delete process.env.HAHA_DATA_DIR
      else process.env.HAHA_DATA_DIR = prevDataDir
    }
  }, 30_000)
})

describe('agent CLI external sessions + adapters (S3-S6)', () => {
  test('buildNonInteractiveArgs is allowlisted per CLI', () => {
    expect(buildNonInteractiveArgs('codex', 'hi')?.[0]).toBe('exec')
    expect(buildNonInteractiveArgs('gemini', 'hi')?.[0]).toBe('-p')
    expect(buildNonInteractiveArgs('opencode', 'hi')?.[0]).toBe('run')
    expect(buildNonInteractiveArgs('pi', 'hi')).toBe(null)
  })

  test('creates external sessions bound to cliId with message log', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'agent-cli-sess-'))
    const prevDataDir = process.env.HAHA_DATA_DIR
    process.env.HAHA_DATA_DIR = tempDir
    resetWebControlDatabaseSingletonForTests()
    try {
      getWebControlDatabase()
      const created = await createSessionForCli('codex', tempDir, 'Codex test')
      expect(created.agentCliId).toBe('codex')
      expect(created.id).toBeTruthy()
      expect(created.workDir).toBeTruthy()

      appendAgentCliMessage({
        sessionId: created.id,
        role: 'user',
        content: 'hello codex',
      })
      appendAgentCliMessage({
        sessionId: created.id,
        role: 'assistant',
        content: 'world',
      })

      const messages = listAgentCliMessages(created.id)
      expect(messages).toHaveLength(2)
      expect(messages[0]?.content).toBe('hello codex')

      const page = await listSessionsForCli('codex')
      expect(page.total).toBeGreaterThanOrEqual(1)
      expect(page.sessions.some((s) => s.id === created.id)).toBe(true)
      expect(page.sessions.every((s) => s.agentCliId === 'codex')).toBe(true)

      const empty = await listSessionsForCli('gemini')
      expect(empty.sessions.every((s) => s.id !== created.id)).toBe(true)
    } finally {
      resetWebControlDatabaseSingletonForTests()
      if (prevDataDir === undefined) delete process.env.HAHA_DATA_DIR
      else process.env.HAHA_DATA_DIR = prevDataDir
    }
  })
})
