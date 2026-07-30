import * as fs from 'fs/promises'
import * as path from 'path'
import { resolveHahaOAuthFile } from './ccHahaPaths.js'
import { AuthCodeListener } from '../../services/oauth/auth-code-listener.js'
import {
  buildGrokAuthorizeUrl,
  exchangeGrokCodeForTokens,
  generateGrokCodeVerifier,
  generateGrokNonce,
  generateGrokState,
  isGrokTokenExpired,
  normalizeGrokTokens,
  refreshGrokTokens,
  withRefreshedGrokAccessToken,
  type GrokTokenFetchOptions,
} from '../../services/grokAuth/client.js'
import type { GrokOAuthTokenResponse } from '../../services/grokAuth/types.js'
import { logTokenRefreshFailure } from './oauthRefreshLog.js'
import {
  getNetworkProxyUrl,
  loadNetworkSettings,
} from './networkSettings.js'

export type StoredGrokOAuthTokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  idToken?: string | null
  email: string | null
  clientId?: string | null
  /** User-editable display name on the Grok official card (grok2api-style). */
  displayName?: string | null
  /** First successful login time (ISO). */
  createdAt?: string | null
}

export type GrokOAuthSession = {
  state: string
  codeVerifier: string
  authorizeUrl: string
  redirectUri: string
  createdAt: number
  authCodeListener?: AuthCodeListener
  expiresTimer?: ReturnType<typeof setTimeout>
}

type GrokRefreshFn = (
  refreshToken: string,
  options?: GrokTokenFetchOptions,
) => Promise<GrokOAuthTokenResponse>

const SESSION_TTL_MS = 10 * 60 * 1000
const CALLBACK_PATH = '/callback'

export const GROK_OAUTH_SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Grok Login Success</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;color:#333}.card{text-align:center;padding:40px;background:white;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.06)}h1{color:#16a34a;margin:0 0 12px}p{color:#666}</style>
</head><body><div class="card"><h1>✓ Grok Login Successful</h1><p>Authorization is complete. You can close this window and return to Claude Code Haha.</p></div><script>setTimeout(() => window.close(), 3000)</script></body></html>`

function renderErrorHtml(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Grok Login Failed</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;color:#333}.card{text-align:center;padding:40px;background:white;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.06)}h1{color:#dc2626;margin:0 0 12px}pre{color:#666;white-space:pre-wrap;word-break:break-word;text-align:left;background:#f5f5f5;padding:12px;border-radius:6px}</style>
</head><body><div class="card"><h1>Grok Login Failed</h1><pre>${escapeHtml(message)}</pre></div></body></html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function getHahaGrokOAuthFilePath(): string {
  return resolveHahaOAuthFile('grok-oauth.json')
}

export class HahaGrokOAuthService {
  private sessions = new Map<string, GrokOAuthSession>()
  private refreshFn: GrokRefreshFn = refreshGrokTokens

  setRefreshFn(fn: GrokRefreshFn): void {
    this.refreshFn = fn
  }

  getOAuthFilePath(): string {
    return getHahaGrokOAuthFilePath()
  }

  async loadTokens(): Promise<StoredGrokOAuthTokens | null> {
    // Phase B: prefer multi-account pool pick (sticky preferred or round-robin).
    try {
      const { grokAccountPoolService } = await import('./grokAccountPoolService.js')
      const fromPool = await grokAccountPoolService.getActiveTokens()
      if (fromPool) return fromPool
    } catch {
      // fall through to legacy single-file
    }
    try {
      return JSON.parse(await fs.readFile(this.getOAuthFilePath(), 'utf-8')) as StoredGrokOAuthTokens
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async saveTokens(tokens: StoredGrokOAuthTokens): Promise<void> {
    // Keep pool + legacy mirror in sync when writing the active credential.
    try {
      const { grokAccountPoolService } = await import('./grokAccountPoolService.js')
      const pool = await grokAccountPoolService.loadPool()
      const picked = grokAccountPoolService.pickAccount(pool)
      if (picked) {
        await grokAccountPoolService.updateAccountTokens(picked.id, tokens)
        return
      }
      await grokAccountPoolService.upsertFromLogin(tokens)
      return
    } catch {
      // fall through
    }
    const filePath = this.getOAuthFilePath()
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const temporaryPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
    let renamed = false
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 })
      await fs.rename(temporaryPath, filePath)
      renamed = true
    } finally {
      if (!renamed) await fs.rm(temporaryPath, { force: true }).catch(() => {})
    }
  }

  async deleteTokens(): Promise<void> {
    try {
      const { grokAccountPoolService } = await import('./grokAccountPoolService.js')
      await grokAccountPoolService.clearAll()
    } catch {
      // ignore
    }
    await fs.rm(this.getOAuthFilePath(), { force: true })
  }

  async startSession(): Promise<GrokOAuthSession> {
    this.dispose()
    const codeVerifier = generateGrokCodeVerifier()
    const state = generateGrokState()
    const nonce = generateGrokNonce()
    const authCodeListener = new AuthCodeListener(CALLBACK_PATH)
    const port = await authCodeListener.start(undefined, '127.0.0.1')
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`
    const authorizeUrl = buildGrokAuthorizeUrl({ redirectUri, codeVerifier, state, nonce })
    const session: GrokOAuthSession = {
      state,
      codeVerifier,
      authorizeUrl,
      redirectUri,
      createdAt: Date.now(),
      authCodeListener,
    }
    session.expiresTimer = setTimeout(() => {
      if (this.sessions.get(state) === session) {
        this.closeSession(session)
        this.sessions.delete(state)
      }
    }, SESSION_TTL_MS)
    session.expiresTimer.unref?.()
    this.sessions.set(state, session)
    this.waitForDesktopCallback(session)
    return session
  }

  private waitForDesktopCallback(session: GrokOAuthSession): void {
    const listener = session.authCodeListener
    if (!listener) return
    void listener.waitForAuthorization(session.state, async () => {})
      .then(async (code) => {
        try {
          await this.completeSession(code, session.state)
          listener.handleSuccessRedirect([], (response) => {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            response.end(GROK_OAUTH_SUCCESS_HTML)
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          listener.handleSuccessRedirect([], (response) => {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            response.end(renderErrorHtml(message))
          })
        } finally {
          this.closeSession(session)
          this.sessions.delete(session.state)
        }
      })
      .catch(() => {
        this.closeSession(session)
        this.sessions.delete(session.state)
      })
  }

  async completeSession(code: string, state: string): Promise<StoredGrokOAuthTokens> {
    const session = this.sessions.get(state)
    if (!session || Date.now() - session.createdAt > SESSION_TTL_MS) {
      throw new Error('Grok OAuth session not found or expired')
    }
    this.sessions.delete(state)
    const response = await exchangeGrokCodeForTokens({
      code,
      redirectUri: session.redirectUri,
      codeVerifier: session.codeVerifier,
      ...(await this.getTokenFetchOptions()),
    })
    const normalized = normalizeGrokTokens(response)
    const tokens: StoredGrokOAuthTokens = {
      accessToken: normalized.accessToken,
      refreshToken: normalized.refreshToken,
      expiresAt: normalized.expiresAt,
      idToken: normalized.idToken ?? null,
      email: normalized.email ?? null,
      clientId: normalized.clientId ?? null,
      displayName: null,
      createdAt: new Date().toISOString(),
    }
    // Phase B: add/update account in pool (multi-login accumulates accounts).
    // Always also mirror legacy grok-oauth.json for desktop/cc-haha compatibility.
    try {
      const { grokAccountPoolService } = await import('./grokAccountPoolService.js')
      const acc = await grokAccountPoolService.upsertFromLogin(tokens)
      tokens.displayName = acc.displayName
      tokens.createdAt = acc.createdAt
    } catch (err) {
      console.warn(
        '[hahaGrokOAuth] pool upsert failed, writing legacy file only:',
        err instanceof Error ? err.message : err,
      )
      // Direct legacy write (saveTokens may recurse into empty pool)
      const filePath = this.getOAuthFilePath()
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 })
    }
    // Make Grok Official the default provider after a successful login.
    // Settings treats activeId === null as Claude Official; without this step the
    // green "Default" badge stays on Claude even though Grok OAuth succeeded.
    await this.activateGrokOfficialProvider().catch((err) => {
      console.warn(
        '[hahaGrokOAuth] login succeeded but failed to activate grok-official as default:',
        err instanceof Error ? err.message : err,
      )
    })
    return tokens
  }

  private async activateGrokOfficialProvider(): Promise<void> {
    // Dynamic import avoids a static cycle with providerService → hahaGrokOAuthService.
    const { ProviderService } = await import('./providerService.js')
    await new ProviderService().activateProvider('grok-official')
  }

  private mergePreservedMeta(
    previous: StoredGrokOAuthTokens,
    next: {
      accessToken: string
      refreshToken: string | null
      expiresAt: number | null
      idToken?: string | null
      email?: string | null
      clientId?: string | null
    },
  ): StoredGrokOAuthTokens {
    return {
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      expiresAt: next.expiresAt,
      idToken: next.idToken ?? null,
      email: next.email ?? previous.email,
      clientId: next.clientId ?? previous.clientId ?? null,
      displayName: previous.displayName ?? null,
      createdAt: previous.createdAt ?? new Date().toISOString(),
    }
  }

  async ensureFreshTokens(): Promise<StoredGrokOAuthTokens | null> {
    const tokens = await this.loadTokens()
    if (!tokens) return null
    if (tokens.expiresAt === null || !isGrokTokenExpired(tokens.expiresAt)) {
      // Advance RR when not sticky so consecutive requests rotate healthy accounts.
      try {
        const { grokAccountPoolService } = await import('./grokAccountPoolService.js')
        const pool = await grokAccountPoolService.loadPool()
        const picked = grokAccountPoolService.pickAccount(pool)
        if (picked && !pool.preferredAccountId) {
          await grokAccountPoolService.advanceRoundRobin(picked.id)
        }
      } catch {
        // ignore
      }
      return tokens
    }
    if (!tokens.refreshToken) return null
    try {
      const response = await this.refreshFn(tokens.refreshToken, await this.getTokenFetchOptions())
      const normalized = withRefreshedGrokAccessToken({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
        ...(tokens.email ? { email: tokens.email } : {}),
        ...(tokens.clientId ? { clientId: tokens.clientId } : {}),
      }, response)
      const updated = this.mergePreservedMeta(tokens, {
        accessToken: normalized.accessToken,
        refreshToken: normalized.refreshToken,
        expiresAt: normalized.expiresAt,
        idToken: normalized.idToken ?? null,
        email: normalized.email ?? null,
        clientId: normalized.clientId ?? null,
      })
      await this.saveTokens(updated)
      return updated
    } catch (error) {
      logTokenRefreshFailure('[HahaGrokOAuthService]', error)
      return null
    }
  }

  /**
   * Always call the refresh endpoint when a refresh_token exists
   * (user-initiated "刷新凭据", unlike ensureFreshTokens which is expiry-gated).
   */
  async forceRefreshTokens(): Promise<StoredGrokOAuthTokens> {
    const tokens = await this.loadTokens()
    if (!tokens) throw new Error('Grok OAuth 未登录')
    if (!tokens.refreshToken) throw new Error('缺少 refresh_token，请重新登录 Grok')
    try {
      const response = await this.refreshFn(tokens.refreshToken, await this.getTokenFetchOptions())
      const normalized = withRefreshedGrokAccessToken({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
        ...(tokens.email ? { email: tokens.email } : {}),
        ...(tokens.clientId ? { clientId: tokens.clientId } : {}),
      }, response)
      const updated = this.mergePreservedMeta(tokens, {
        accessToken: normalized.accessToken,
        refreshToken: normalized.refreshToken,
        expiresAt: normalized.expiresAt,
        idToken: normalized.idToken ?? null,
        email: normalized.email ?? null,
        clientId: normalized.clientId ?? null,
      })
      await this.saveTokens(updated)
      return updated
    } catch (error) {
      logTokenRefreshFailure('[HahaGrokOAuthService]', error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  async updateDisplayName(name: string): Promise<StoredGrokOAuthTokens> {
    const tokens = await this.loadTokens()
    if (!tokens) throw new Error('Grok OAuth 未登录，无法重命名')
    const trimmed = name.trim()
    if (!trimmed) throw new Error('name is required')
    const updated: StoredGrokOAuthTokens = {
      ...tokens,
      displayName: trimmed,
      createdAt: tokens.createdAt ?? new Date().toISOString(),
    }
    await this.saveTokens(updated)
    return updated
  }

  /** Export the on-disk auth file content (auth.json style). */
  async exportAuthJson(): Promise<{
    path: string
    tokens: StoredGrokOAuthTokens
  }> {
    const tokens = await this.loadTokens()
    if (!tokens) throw new Error('Grok OAuth 未登录，无凭证可导出')
    return {
      path: this.getOAuthFilePath(),
      tokens,
    }
  }

  dispose(): void {
    for (const session of this.sessions.values()) this.closeSession(session)
    this.sessions.clear()
  }

  private closeSession(session: GrokOAuthSession): void {
    if (session.expiresTimer) clearTimeout(session.expiresTimer)
    session.expiresTimer = undefined
    session.authCodeListener?.close()
    session.authCodeListener = undefined
  }

  private async getTokenFetchOptions(): Promise<GrokTokenFetchOptions> {
    const settings = await loadNetworkSettings()
    return {
      proxyUrl: getNetworkProxyUrl(settings),
      timeoutMs: settings.aiRequestTimeoutMs,
    }
  }
}

export const hahaGrokOAuthService = new HahaGrokOAuthService()
