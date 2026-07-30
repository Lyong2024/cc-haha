import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyLegacyHahaEnvAliases,
  LEGACY_HAHA_DIR_NAME,
  resolveHahaDataDir,
  resolveHahaOAuthFile,
} from '../services/ccHahaPaths.js'

afterEach(() => {
  delete process.env.HAHA_DATA_DIR
  delete process.env.CC_HAHA_DATA_DIR
  delete process.env.CLAUDE_CONFIG_DIR
})

describe('haha path isolation', () => {
  test('prefers HAHA_DATA_DIR for data and oauth files', () => {
    delete process.env.CC_HAHA_DATA_DIR
    process.env.HAHA_DATA_DIR = 'C:\\tmp\\web-instance-a'
    expect(resolveHahaDataDir()).toBe('C:\\tmp\\web-instance-a')
    expect(resolveHahaOAuthFile('grok-oauth.json')).toBe(
      join('C:\\tmp\\web-instance-a', 'grok-oauth.json'),
    )
  })

  test('accepts legacy CC_HAHA_DATA_DIR when HAHA_DATA_DIR unset', () => {
    delete process.env.HAHA_DATA_DIR
    process.env.CC_HAHA_DATA_DIR = 'C:\\tmp\\legacy-instance'
    applyLegacyHahaEnvAliases()
    expect(resolveHahaDataDir()).toBe('C:\\tmp\\legacy-instance')
    expect(process.env.HAHA_DATA_DIR).toBe('C:\\tmp\\legacy-instance')
  })

  test('falls back to CLAUDE_CONFIG_DIR/haha when data-dir unset', () => {
    delete process.env.HAHA_DATA_DIR
    delete process.env.CC_HAHA_DATA_DIR
    process.env.CLAUDE_CONFIG_DIR = 'C:\\tmp\\claude-home'
    expect(resolveHahaDataDir()).toBe(join('C:\\tmp\\claude-home', 'haha'))
    expect(resolveHahaOAuthFile('openai-oauth.json')).toBe(
      join('C:\\tmp\\claude-home', 'haha', 'openai-oauth.json'),
    )
  })

  test('uses legacy ~/.claude/cc-haha when only that directory exists', () => {
    delete process.env.HAHA_DATA_DIR
    delete process.env.CC_HAHA_DATA_DIR
    const home = mkdtempSync(join(tmpdir(), 'haha-path-legacy-'))
    try {
      process.env.CLAUDE_CONFIG_DIR = home
      const legacy = join(home, LEGACY_HAHA_DIR_NAME)
      mkdirSync(legacy, { recursive: true })
      writeFileSync(join(legacy, 'marker.txt'), 'ok')
      expect(resolveHahaDataDir()).toBe(legacy)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('does not auto-switch write root to heavier cc-haha when both exist', () => {
    delete process.env.HAHA_DATA_DIR
    delete process.env.CC_HAHA_DATA_DIR
    const home = mkdtempSync(join(tmpdir(), 'haha-path-both-'))
    try {
      process.env.CLAUDE_CONFIG_DIR = home
      const primary = join(home, 'haha')
      const legacy = join(home, LEGACY_HAHA_DIR_NAME)
      mkdirSync(primary, { recursive: true })
      mkdirSync(legacy, { recursive: true })
      // Empty project brand folder is still the active write root.
      writeFileSync(
        join(primary, 'providers.json'),
        JSON.stringify({ schemaVersion: 2, activeId: null, providers: [], providerOrder: [] }),
      )
      writeFileSync(
        join(legacy, 'providers.json'),
        JSON.stringify({
          schemaVersion: 2,
          activeId: 'p1',
          providers: [
            {
              id: 'p1',
              presetId: 'custom',
              name: 'Desktop',
              apiKey: 'sk',
              baseUrl: 'https://x',
              models: { main: 'm', haiku: 'm', sonnet: 'm', opus: 'm' },
            },
          ],
          providerOrder: ['p1'],
        }),
      )
      // External desktop data stays external — import is user-driven.
      expect(resolveHahaDataDir()).toBe(primary)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
