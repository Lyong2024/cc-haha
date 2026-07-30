/**
 * Static catalog of supported Agent CLIs.
 * Install package names mirror common official distributions used by cc-switch.
 */

import type { AgentCliDefinition, AgentCliId } from './types.js'

export const DEFAULT_AGENT_CLI_ID: AgentCliId = 'claude-code'

export const AGENT_CLI_REGISTRY: readonly AgentCliDefinition[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    binaries: ['claude', 'claude-haha'],
    versionArgs: ['--version', '-v'],
    installStrategies: [
      { kind: 'npm', packageName: '@anthropic-ai/claude-code' },
    ],
    maturity: 'full',
    extraCandidates: ['bin/claude-haha', 'bin/claude-haha.ts'],
    homepage: 'https://docs.anthropic.com/en/docs/claude-code',
  },
  {
    id: 'codex',
    displayName: 'Codex CLI',
    binaries: ['codex'],
    versionArgs: ['--version', '-V'],
    // Avoid bare `codex update` (npm installs report fake success) — reinstall.
    installStrategies: [
      { kind: 'npm', packageName: '@openai/codex', preferReinstallOnUpgrade: true },
    ],
    maturity: 'beta',
    homepage: 'https://github.com/openai/codex',
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    binaries: ['gemini'],
    versionArgs: ['--version', '-v'],
    installStrategies: [
      { kind: 'npm', packageName: '@google/gemini-cli' },
    ],
    maturity: 'beta',
    homepage: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    id: 'kimi',
    // Official agent is Kimi Code CLI; npm publishes bin as `kimi`.
    displayName: 'Kimi Code CLI',
    binaries: ['kimi'],
    versionArgs: ['--version', '-v'],
    installStrategies: [
      { kind: 'npm', packageName: '@moonshot-ai/kimi-code' },
    ],
    maturity: 'manage-only',
    homepage: 'https://github.com/MoonshotAI/kimi-code',
  },
  {
    id: 'grok',
    displayName: 'Grok CLI',
    // xAI Grok Build TUI (`grok`), not Groq Code CLI.
    binaries: ['grok'],
    versionArgs: ['--version', '-v', 'version'],
    // Native installer under ~/.grok/bin — no stable npm package.
    installStrategies: [],
    maturity: 'manage-only',
    extraCandidates: [
      '~/.grok/bin/grok',
      '~/.grok/bin/grok.exe',
    ],
    homepage: 'https://grok.x.ai/',
  },
  {
    id: 'mistral',
    displayName: 'Mistral CLI',
    binaries: ['mistral'],
    versionArgs: ['--version', '-v'],
    // No official public npm agent CLI package yet (avoid dead @mistralai/* names).
    installStrategies: [],
    maturity: 'manage-only',
    homepage: 'https://mistral.ai/',
  },
  {
    id: 'opencode',
    displayName: 'OpenCode CLI',
    binaries: ['opencode'],
    versionArgs: ['--version', '-v'],
    installStrategies: [
      {
        kind: 'shell',
        url: 'https://opencode.ai/install',
        shell: 'bash',
      },
      { kind: 'npm', packageName: 'opencode-ai' },
    ],
    maturity: 'beta',
    homepage: 'https://opencode.ai/',
  },
  {
    id: 'pi',
    displayName: 'Pi',
    binaries: ['pi'],
    versionArgs: ['--version', '-v'],
    installStrategies: [
      { kind: 'npm', packageName: '@mariozechner/pi-coding-agent' },
    ],
    maturity: 'manage-only',
    homepage: 'https://github.com/mariozechner/pi-mono',
  },
] as const

const byId = new Map(AGENT_CLI_REGISTRY.map((entry) => [entry.id, entry]))

export function getAgentCliDefinition(id: string): AgentCliDefinition | null {
  return byId.get(id as AgentCliId) ?? null
}

export function isAgentCliId(value: string): value is AgentCliId {
  return byId.has(value as AgentCliId)
}

export function listAgentCliDefinitions(): readonly AgentCliDefinition[] {
  return AGENT_CLI_REGISTRY
}

export function primaryNpmPackage(def: AgentCliDefinition): string | null {
  for (const strategy of def.installStrategies) {
    if (strategy.kind === 'npm') return strategy.packageName
  }
  return null
}
