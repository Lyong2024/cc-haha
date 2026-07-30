import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  GrokAccountPoolService,
} from '../services/grokAccountPoolService.js'

describe('GrokAccountPoolService', () => {
  let tmpDir: string
  let service: GrokAccountPoolService
  let prevEnv: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-pool-'))
    prevEnv = process.env.HAHA_DATA_DIR
    process.env.HAHA_DATA_DIR = tmpDir
    // OAuth files live under haha data dir via resolveHahaOAuthFile
    service = new GrokAccountPoolService()
  })

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.HAHA_DATA_DIR
    else process.env.HAHA_DATA_DIR = prevEnv
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  test('upsert two accounts and pick preferred over round-robin', async () => {
    const a = await service.upsertFromLogin({
      accessToken: 'at-a',
      refreshToken: 'rt-a',
      expiresAt: Date.now() + 60_000,
      email: 'a@x.ai',
      displayName: null,
      createdAt: new Date().toISOString(),
    })
    const b = await service.upsertFromLogin({
      accessToken: 'at-b',
      refreshToken: 'rt-b',
      expiresAt: Date.now() + 60_000,
      email: 'b@x.ai',
      displayName: null,
      createdAt: new Date().toISOString(),
    })
    expect(a.id).not.toBe(b.id)

    let pool = await service.loadPool()
    expect(pool.accounts.length).toBe(2)

    // No preferred → pick first healthy (rr)
    const t1 = await service.getActiveTokens()
    expect(t1?.accessToken).toBeTruthy()

    await service.setPreferred(b.id)
    const t2 = await service.getActiveTokens()
    expect(t2?.accessToken).toBe('at-b')
    expect(t2?.email).toBe('b@x.ai')

    pool = await service.loadPool()
    const pub = service.toPublicList(pool)
    expect(pub.find((x) => x.id === b.id)?.isPreferred).toBe(true)
  })

  test('remove account and clear preferred', async () => {
    const a = await service.upsertFromLogin({
      accessToken: 'at-a',
      refreshToken: 'rt-a',
      expiresAt: null,
      email: 'a@x.ai',
      displayName: null,
      createdAt: new Date().toISOString(),
    })
    await service.setPreferred(a.id)
    const { remaining } = await service.removeAccount(a.id)
    expect(remaining).toBe(0)
    const pool = await service.loadPool()
    expect(pool.preferredAccountId).toBeNull()
    expect(await service.getActiveTokens()).toBeNull()
  })

  test('same email login updates existing entry', async () => {
    const a1 = await service.upsertFromLogin({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: null,
      email: 'same@x.ai',
      displayName: null,
      createdAt: new Date().toISOString(),
    })
    const a2 = await service.upsertFromLogin({
      accessToken: 'at-2',
      refreshToken: 'rt-2',
      expiresAt: null,
      email: 'same@x.ai',
      displayName: 'Nick',
      createdAt: new Date().toISOString(),
    })
    expect(a2.id).toBe(a1.id)
    expect(a2.accessToken).toBe('at-2')
    const pool = await service.loadPool()
    expect(pool.accounts.length).toBe(1)
  })

  test('migrates desktop-style grok-oauth.json into empty pool', async () => {
    const oauthPath = path.join(tmpDir, 'grok-oauth.json')
    await fs.writeFile(
      oauthPath,
      JSON.stringify({
        accessToken: 'legacy-at',
        refreshToken: 'legacy-rt',
        expiresAt: null,
        email: 'desktop@gmail.com',
        displayName: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      }, null, 2),
    )
    // no pool file yet
    const pool = await service.loadPool()
    expect(pool.accounts.length).toBe(1)
    expect(pool.accounts[0]?.email).toBe('desktop@gmail.com')
    expect(pool.accounts[0]?.accessToken).toBe('legacy-at')
    // legacy file kept for desktop compat
    const still = await fs.readFile(oauthPath, 'utf-8')
    expect(still).toContain('legacy-at')
  })
})
