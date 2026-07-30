import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openWebControlDatabase,
  resetWebControlDatabaseSingletonForTests,
} from '../services/webControlDb.js'
import {
  WebAuthService,
  resetWebAuthServiceForTests,
} from '../services/webAuthService.js'
import {
  WebPresenceService,
  resetWebPresenceServiceForTests,
} from '../services/webPresenceService.js'

let tempDir: string | null = null

afterEach(() => {
  resetWebAuthServiceForTests()
  resetWebPresenceServiceForTests()
  resetWebControlDatabaseSingletonForTests()
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  }
})

describe('web-control database', () => {
  test('opens with WAL journal mode and high-performance pragmas', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'web-control-'))
    const control = openWebControlDatabase({ dataDir: tempDir })
    try {
      expect(control.pragmaJournalMode()).toBe('wal')
      const sync = control.db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()
      // NORMAL == 1
      expect(sync?.synchronous).toBe(1)
    } finally {
      control.close()
    }
  })

  test('admin setup/login and online users include web + im', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'web-control-'))
    const control = openWebControlDatabase({ dataDir: tempDir })
    try {
      const auth = new WebAuthService(control)
      const presence = new WebPresenceService(control)

      expect(auth.getStatus(null).setupRequired).toBe(true)
      const setup = auth.setupAdmin(
        { username: 'root_user', password: 'password-long-enough' },
        {
          ip: '127.0.0.1',
          userAgent: 'test-agent',
        },
      )
      expect(auth.getAdminUsername()).toBe('root_user')
      expect(auth.getStatus(null).username).toBe('root_user')

      presence.touchWebSession(setup.session.id, {
        ip: '127.0.0.1',
        userAgent: 'test-agent',
        identity: 'root_user',
      })

      const session = auth.validateSession(setup.token)
      expect(session?.id).toBe(setup.session.id)

      const login = auth.login({
        username: 'Root_User',
        password: 'password-long-enough',
      })
      expect(login.session.id).toBeTruthy()

      expect(() =>
        auth.login({ username: 'wrong', password: 'password-long-enough' }),
      ).toThrow(/账号或密码错误|Invalid credentials/)

      presence.touchImActivity({
        platform: 'telegram',
        identity: 'user-42',
        sessionRef: 'sess-1',
      })

      const users = presence.listOnlineUsers()
      expect(users.some((u) => u.source === 'web' && u.identity === 'root_user')).toBe(true)
      expect(users.some((u) => u.source === 'im' && u.platform === 'telegram')).toBe(true)
      expect(users.every((u) => !('kick' in u))).toBe(true)
    } finally {
      control.close()
    }
  })

  test('rejects weak setup credentials', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'web-control-'))
    const control = openWebControlDatabase({ dataDir: tempDir })
    try {
      const auth = new WebAuthService(control)
      expect(() =>
        auth.setupAdmin({ username: 'ab', password: 'password-long-enough' }),
      ).toThrow(/Username/)
      expect(() =>
        auth.setupAdmin({ username: 'admin', password: 'short' }),
      ).toThrow(/Password/)
    } finally {
      control.close()
    }
  })

  test('host terminal service resolves existing cwd', async () => {
    const { openHostTerminal } = await import('../services/hostTerminalService.js')
    // We only validate path resolution errors here (no GUI spawn assertion in CI).
    await expect(openHostTerminal({ cwd: '__definitely_missing_dir__' })).rejects.toThrow(/does not exist|not a directory|Cannot access/)
  })

  test('locks login after 10 failures for fingerprint and IP', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'web-control-'))
    const control = openWebControlDatabase({ dataDir: tempDir })
    try {
      const auth = new WebAuthService(control)
      auth.setupAdmin({ username: 'admin', password: 'password-long-enough' })

      const client = {
        ip: '203.0.113.10',
        fingerprint: 'test-fp-device-a',
      }

      for (let i = 0; i < 9; i += 1) {
        try {
          auth.login({ username: 'admin', password: 'wrong-password' }, client)
          throw new Error('expected login to fail')
        } catch (error) {
          expect((error as { code?: string }).code).toBe('UNAUTHORIZED')
          const lockout = (error as { lockout?: { remainingAttempts: number } }).lockout
          expect(lockout?.remainingAttempts).toBe(9 - i)
        }
      }

      try {
        auth.login({ username: 'admin', password: 'wrong-password' }, client)
        throw new Error('expected lock')
      } catch (error) {
        expect((error as { code?: string }).code).toBe('LOCKED')
        const lockout = (error as { lockout?: { locked: boolean; remainingAttempts: number } }).lockout
        expect(lockout?.locked).toBe(true)
        expect(lockout?.remainingAttempts).toBe(0)
      }

      // Correct password still blocked while locked
      expect(() =>
        auth.login({ username: 'admin', password: 'password-long-enough' }, client),
      ).toThrow(/锁定/)

      // Different device fingerprint + IP is not locked
      const other = auth.login(
        { username: 'admin', password: 'password-long-enough' },
        { ip: '198.51.100.2', fingerprint: 'other-device' },
      )
      expect(other.token).toBeTruthy()
    } finally {
      control.close()
    }
  })
})
