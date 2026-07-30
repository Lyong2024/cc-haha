import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  importExternalProvidersIntoIndex,
  listExternalProviderCandidates,
  listExternalSources,
  proposeProviderName,
} from '../services/externalProviderSources.js'
import type { ProvidersIndex, SavedProvider } from '../types/provider.js'

afterEach(() => {
  // Always clear isolation env so other test files are not polluted.
  delete process.env.HAHA_DATA_DIR
  delete process.env.CC_HAHA_DATA_DIR
  delete process.env.CLAUDE_CONFIG_DIR
})

function emptyIndex(providers: SavedProvider[] = []): ProvidersIndex {
  return {
    schemaVersion: 2,
    activeId: null,
    providers,
    providerOrder: providers.map((p) => p.id),
  }
}

describe('external provider sources', () => {
  test('proposeProviderName adds source label only on conflict', () => {
    expect(proposeProviderName('DeepSeek', 'cc-haha', [])).toEqual({
      name: 'DeepSeek',
      conflict: false,
    })
    expect(proposeProviderName('DeepSeek', 'cc-haha', ['DeepSeek'])).toEqual({
      name: 'DeepSeek (cc-haha)',
      conflict: true,
    })
    expect(
      proposeProviderName('DeepSeek', 'cc-haha', ['DeepSeek', 'DeepSeek (cc-haha)']),
    ).toEqual({
      name: 'DeepSeek (cc-haha) 2',
      conflict: true,
    })
  })

  test('discovers Claude Code settings and cc-haha providers without auto-merge', () => {
    const home = mkdtempSync(join(tmpdir(), 'ext-src-'))
    try {
      process.env.CLAUDE_CONFIG_DIR = home
      // Isolated project store
      const project = join(home, 'haha-web')
      mkdirSync(project, { recursive: true })
      process.env.HAHA_DATA_DIR = project
      writeFileSync(
        join(project, 'providers.json'),
        JSON.stringify(emptyIndex([])),
      )

      // Claude Code settings
      writeFileSync(
        join(home, 'settings.json'),
        JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: 'sk-ant-test-token-value',
            ANTHROPIC_BASE_URL: 'https://api.example-claude.com',
            ANTHROPIC_MODEL: 'claude-opus-4',
          },
        }),
      )

      // Desktop cc-haha providers
      const desktop = join(home, 'cc-haha')
      mkdirSync(desktop, { recursive: true })
      writeFileSync(
        join(desktop, 'providers.json'),
        JSON.stringify({
          schemaVersion: 2,
          activeId: 'p1',
          providers: [
            {
              id: 'p1',
              presetId: 'custom',
              name: 'Desktop A',
              apiKey: 'sk-desktop-aaaa',
              baseUrl: 'https://desktop.example.com',
              apiFormat: 'anthropic',
              models: { main: 'm1', haiku: 'm1', sonnet: 'm1', opus: 'm1' },
            },
            {
              id: 'p2',
              presetId: 'deepseek',
              name: 'Desktop B',
              apiKey: 'sk-desktop-bbbb',
              baseUrl: 'https://desktop-b.example.com',
              apiFormat: 'anthropic',
              models: { main: 'm2', haiku: 'm2', sonnet: 'm2', opus: 'm2' },
            },
          ],
          providerOrder: ['p1', 'p2'],
        }),
      )

      const sources = listExternalSources([])
      expect(sources.find((s) => s.id === 'claude-code')?.candidateCount).toBe(1)
      expect(sources.find((s) => s.id === 'cc-haha')?.candidateCount).toBe(2)
      // Active dir is haha-web, not brand haha — brand haha file may not exist
      expect(sources.find((s) => s.id === 'cc-haha')?.isActiveDataDir).toBe(false)

      const candidates = listExternalProviderCandidates([])
      expect(candidates.some((c) => c.sourceId === 'claude-code')).toBe(true)
      expect(candidates.filter((c) => c.sourceId === 'cc-haha')).toHaveLength(2)
      // Secrets masked in public candidates
      expect(candidates.every((c) => !('__apiKey' in c))).toBe(true)
      expect(candidates.find((c) => c.sourceId === 'claude-code')?.maskedKey).toMatch(/…/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('import is opt-in and renames on conflict', () => {
    const home = mkdtempSync(join(tmpdir(), 'ext-import-'))
    try {
      process.env.CLAUDE_CONFIG_DIR = home
      const project = join(home, 'haha-web')
      mkdirSync(project, { recursive: true })
      process.env.HAHA_DATA_DIR = project

      const existing: SavedProvider = {
        id: 'local-1',
        presetId: 'custom',
        name: 'Desktop A',
        apiKey: 'sk-local',
        baseUrl: 'https://local.example.com',
        apiFormat: 'anthropic',
        models: { main: 'x', haiku: 'x', sonnet: 'x', opus: 'x' },
      }
      writeFileSync(join(project, 'providers.json'), JSON.stringify(emptyIndex([existing])))

      const desktop = join(home, 'cc-haha')
      mkdirSync(desktop, { recursive: true })
      writeFileSync(
        join(desktop, 'providers.json'),
        JSON.stringify({
          schemaVersion: 2,
          activeId: null,
          providers: [
            {
              id: 'p1',
              presetId: 'custom',
              name: 'Desktop A',
              apiKey: 'sk-desktop-aaaa',
              baseUrl: 'https://desktop.example.com',
              apiFormat: 'anthropic',
              models: { main: 'm1', haiku: 'm1', sonnet: 'm1', opus: 'm1' },
            },
          ],
          providerOrder: ['p1'],
        }),
      )

      const before = emptyIndex([existing])
      const key = 'cc-haha:p1'
      const { index, result } = importExternalProvidersIntoIndex(before, [key])
      expect(result.imported).toHaveLength(1)
      expect(result.imported[0]!.name).toBe('Desktop A (cc-haha)')
      expect(index.providers).toHaveLength(2)
      const imported = index.providers.find((p) => p.id === result.imported[0]!.id)!
      expect(imported.importedFrom?.sourceId).toBe('cc-haha')
      expect(imported.importedFrom?.externalId).toBe('p1')
      expect(imported.apiKey).toBe('sk-desktop-aaaa')
      // Local store not auto-replaced — existing stays
      expect(index.providers.find((p) => p.id === 'local-1')?.name).toBe('Desktop A')

      // Second import of same key skips
      const again = importExternalProvidersIntoIndex(index, [key])
      expect(again.result.imported).toHaveLength(0)
      expect(again.result.skipped[0]?.reason).toMatch(/已导入/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('does not list providers from the active data dir as external', () => {
    const home = mkdtempSync(join(tmpdir(), 'ext-active-'))
    try {
      process.env.CLAUDE_CONFIG_DIR = home
      const haha = join(home, 'haha')
      mkdirSync(haha, { recursive: true })
      process.env.HAHA_DATA_DIR = haha
      writeFileSync(
        join(haha, 'providers.json'),
        JSON.stringify({
          schemaVersion: 2,
          activeId: null,
          providers: [
            {
              id: 'only-local',
              presetId: 'custom',
              name: 'Local Only',
              apiKey: 'sk-local-only',
              baseUrl: 'https://local-only.example.com',
              models: { main: 'm', haiku: 'm', sonnet: 'm', opus: 'm' },
            },
          ],
          providerOrder: ['only-local'],
        }),
      )
      const candidates = listExternalProviderCandidates([])
      expect(candidates.some((c) => c.externalId === 'only-local')).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
