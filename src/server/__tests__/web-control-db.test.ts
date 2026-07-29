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
      ).toThrow(/Invalid credentials/)

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
})
