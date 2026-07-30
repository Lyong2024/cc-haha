/**
 * Adapters API — IM Adapter 配置读写
 *
 * GET  /api/adapters  → 返回配置（敏感字段脱敏）
 * PUT  /api/adapters  → 更新配置（浅合并），返回更新后的脱敏配置
 */

import { adapterService, type AdapterFileConfig, type PairedUser } from '../services/adapterService.js'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

// WhatsApp/WeChat protocol modules pull optional platform SDKs (baileys, etc.).
// Load them only on WhatsApp/WeChat login routes so GET /api/adapters never
// crashes the pure-web server when adapters/node_modules is incomplete.

const WECHAT_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

function isMissingOptionalModule(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const err = error as { code?: string; message?: string }
  if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') return true
  const message = err.message ?? ''
  return (
    message.includes('Cannot find module') ||
    message.includes('Cannot find package') ||
    /baileys/i.test(message)
  )
}

function optionalSdkError(platform: string, error: unknown): ApiError {
  if (isMissingOptionalModule(error)) {
    return new ApiError(
      503,
      `${platform} adapter SDK is not installed in this runtime. Run \`cd adapters && bun install\` (or pnpm install) to enable login/QR flows. Config GET/PUT still works without it.`,
      'OPTIONAL_SDK_MISSING',
    )
  }
  if (error instanceof ApiError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new ApiError(500, message, 'ADAPTER_PROTOCOL_ERROR')
}

async function loadWechatProtocol() {
  try {
    return await import('../../../adapters/wechat/protocol.js')
  } catch (error) {
    throw optionalSdkError('WeChat', error)
  }
}

async function loadWhatsAppProtocol() {
  try {
    return await import('../../../adapters/whatsapp/protocol.js')
  } catch (error) {
    throw optionalSdkError('WhatsApp', error)
  }
}

async function loadAdapterCommonConfig() {
  try {
    return await import('../../../adapters/common/config.js')
  } catch (error) {
    throw optionalSdkError('Adapter config', error)
  }
}

const ALLOWED_TOP_KEYS = new Set(['serverUrl', 'defaultProjectDir', 'telegram', 'feishu', 'wechat', 'dingtalk', 'whatsapp', 'pairing'])
const MAX_TEXT_LENGTH = 16_384
const MAX_PATH_LENGTH = 4_096
const MAX_LIST_LENGTH = 1_000
const WHATSAPP_STAGING_TTL_MS = 3 * 60 * 1000
const whatsappLoginDirs = new Map<string, {
  stagingDir: string
  targetDir: string
  createdAt: number
}>()

function getAdapterConfigDir(): string {
  return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'))
}

function getManagedWhatsAppRoot(): string {
  return path.join(getAdapterConfigDir(), 'whatsapp-auth')
}

function getDefaultManagedWhatsAppAuthDir(): string {
  return path.join(getManagedWhatsAppRoot(), 'default')
}

function isManagedWhatsAppAuthDir(candidate: string): boolean {
  const root = getManagedWhatsAppRoot()
  const resolved = path.resolve(candidate)
  return path.dirname(resolved) === root && path.basename(resolved).length > 0
}

async function removeManagedWhatsAppDir(candidate: string): Promise<void> {
  if (!isManagedWhatsAppAuthDir(candidate)) return
  const stat = await fs.lstat(candidate).catch(() => null)
  if (stat?.isSymbolicLink()) return
  await fs.rm(candidate, { recursive: true, force: true })
}

async function cleanupExpiredWhatsAppStaging(): Promise<void> {
  const now = Date.now()
  for (const [sessionKey, loginDirs] of whatsappLoginDirs) {
    if (now - loginDirs.createdAt <= WHATSAPP_STAGING_TTL_MS) continue
    whatsappLoginDirs.delete(sessionKey)
    await removeManagedWhatsAppDir(loginDirs.stagingDir)
  }
}

export async function cleanupStaleWhatsAppLoginDirectories(): Promise<void> {
  const root = getManagedWhatsAppRoot()
  const entries = await fs.readdir(root).catch(() => [])
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.startsWith('.login-')) continue
    const fullPath = path.join(root, entry)
    const stat = await fs.lstat(fullPath).catch(() => null)
    if (!stat || stat.isSymbolicLink()) continue
    if (now - stat.mtimeMs > WHATSAPP_STAGING_TTL_MS) {
      await removeManagedWhatsAppDir(fullPath)
    }
  }
}

cleanupStaleWhatsAppLoginDirectories().catch(() => {})

async function promoteWhatsAppAuth(stagingDir: string, targetDir: string): Promise<void> {
  if (!isManagedWhatsAppAuthDir(stagingDir) || !isManagedWhatsAppAuthDir(targetDir)) {
    throw ApiError.internal('WhatsApp authentication directory is invalid')
  }
  const root = getManagedWhatsAppRoot()
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const backupDir = path.join(root, `.backup-${crypto.randomUUID()}`)
  const targetExists = await fs.lstat(targetDir).then((stat) => !stat.isSymbolicLink()).catch(() => false)
  if (targetExists) await fs.rename(targetDir, backupDir)
  try {
    await fs.rename(stagingDir, targetDir)
    await fs.rm(backupDir, { recursive: true, force: true })
  } catch {
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {})
    if (targetExists) await fs.rename(backupDir, targetDir).catch(() => {})
    throw ApiError.internal('Failed to activate WhatsApp authentication')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw ApiError.badRequest(`${label} must be an object`)
  return value
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw ApiError.badRequest(`Unknown ${label} key: ${key}`)
  }
}

function readString(value: unknown, label: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string') throw ApiError.badRequest(`${label} must be a string`)
  if (value.length > maxLength) throw ApiError.badRequest(`${label} is too long`)
  return value
}

function readStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_LENGTH) {
    throw ApiError.badRequest(`${label} must be an array`)
  }
  return value.map((item, index) => {
    const text = readString(item, `${label}[${index}]`, 1_024).trim()
    if (!text) throw ApiError.badRequest(`${label}[${index}] must not be empty`)
    return text
  })
}

function readTelegramUsers(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_LENGTH) {
    throw ApiError.badRequest('telegram.allowedUsers must be an array')
  }
  return value.map((item, index) => {
    if (!Number.isSafeInteger(item) || Number(item) <= 0) {
      throw ApiError.badRequest(`telegram.allowedUsers[${index}] must be a positive integer`)
    }
    return Number(item)
  })
}

function readPairedUsers(value: unknown, label: string): PairedUser[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_LENGTH) {
    throw ApiError.badRequest(`${label} must be an array`)
  }
  return value.map((item, index) => {
    const user = requireRecord(item, `${label}[${index}]`)
    assertKnownKeys(user, ['userId', 'displayName', 'pairedAt'], `${label}[${index}]`)
    const userId = user.userId
    if (
      !(typeof userId === 'string' && userId.length > 0 && userId.length <= 1_024)
      && !Number.isSafeInteger(userId)
    ) {
      throw ApiError.badRequest(`${label}[${index}].userId is invalid`)
    }
    const displayName = readString(user.displayName, `${label}[${index}].displayName`, 1_024)
    if (typeof user.pairedAt !== 'number' || !Number.isFinite(user.pairedAt) || user.pairedAt < 0) {
      throw ApiError.badRequest(`${label}[${index}].pairedAt is invalid`)
    }
    return { userId: userId as string | number, displayName, pairedAt: user.pairedAt }
  })
}

function readOptionalStringField(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  label: string,
  maxLength = MAX_TEXT_LENGTH,
): void {
  if (key in source) target[key] = readString(source[key], label, maxLength)
}

function readOptionalStringListField(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  label: string,
): void {
  if (key in source) target[key] = readStringList(source[key], label)
}

function parseAdapterConfigPatch(value: unknown): Partial<AdapterFileConfig> {
  const body = requireRecord(value, 'request body')
  for (const key of Object.keys(body)) {
    if (!ALLOWED_TOP_KEYS.has(key)) throw ApiError.badRequest(`Unknown config key: ${key}`)
  }

  const patch: Partial<AdapterFileConfig> = {}
  if ('serverUrl' in body) patch.serverUrl = readString(body.serverUrl, 'serverUrl', 2_048)
  if ('defaultProjectDir' in body) {
    patch.defaultProjectDir = readString(body.defaultProjectDir, 'defaultProjectDir', MAX_PATH_LENGTH)
  }

  if ('pairing' in body) {
    const source = requireRecord(body.pairing, 'pairing')
    assertKnownKeys(source, ['code', 'expiresAt', 'createdAt'], 'pairing')
    const pairing: NonNullable<AdapterFileConfig['pairing']> = {}
    if ('code' in source) {
      if (source.code !== null && (typeof source.code !== 'string' || source.code.length > 64)) {
        throw ApiError.badRequest('pairing.code must be a string or null')
      }
      pairing.code = source.code as string | null
    }
    for (const key of ['expiresAt', 'createdAt'] as const) {
      if (!(key in source)) continue
      const field = source[key]
      if (field !== null && (typeof field !== 'number' || !Number.isFinite(field) || field < 0)) {
        throw ApiError.badRequest(`pairing.${key} must be a non-negative number or null`)
      }
      pairing[key] = field as number | null
    }
    patch.pairing = pairing
  }

  if ('telegram' in body) {
    const source = requireRecord(body.telegram, 'telegram')
    assertKnownKeys(source, ['botToken', 'allowedUsers', 'pairedUsers', 'defaultWorkDir'], 'telegram')
    const telegram: NonNullable<AdapterFileConfig['telegram']> = {}
    readOptionalStringField(source, telegram, 'botToken', 'telegram.botToken')
    if ('allowedUsers' in source) telegram.allowedUsers = readTelegramUsers(source.allowedUsers)
    if ('pairedUsers' in source) telegram.pairedUsers = readPairedUsers(source.pairedUsers, 'telegram.pairedUsers')
    readOptionalStringField(source, telegram, 'defaultWorkDir', 'telegram.defaultWorkDir', MAX_PATH_LENGTH)
    patch.telegram = telegram
  }

  if ('feishu' in body) {
    const source = requireRecord(body.feishu, 'feishu')
    assertKnownKeys(
      source,
      ['appId', 'appSecret', 'encryptKey', 'verificationToken', 'allowedUsers', 'pairedUsers', 'defaultWorkDir', 'streamingCard'],
      'feishu',
    )
    const feishu: NonNullable<AdapterFileConfig['feishu']> = {}
    for (const key of ['appId', 'appSecret', 'encryptKey', 'verificationToken'] as const) {
      readOptionalStringField(source, feishu, key, `feishu.${key}`)
    }
    readOptionalStringListField(source, feishu, 'allowedUsers', 'feishu.allowedUsers')
    if ('pairedUsers' in source) feishu.pairedUsers = readPairedUsers(source.pairedUsers, 'feishu.pairedUsers')
    readOptionalStringField(source, feishu, 'defaultWorkDir', 'feishu.defaultWorkDir', MAX_PATH_LENGTH)
    if ('streamingCard' in source) {
      if (typeof source.streamingCard !== 'boolean') throw ApiError.badRequest('feishu.streamingCard must be a boolean')
      feishu.streamingCard = source.streamingCard
    }
    patch.feishu = feishu
  }

  if ('wechat' in body) {
    const source = requireRecord(body.wechat, 'wechat')
    assertKnownKeys(source, ['allowedUsers', 'pairedUsers', 'defaultWorkDir'], 'wechat')
    const wechat: NonNullable<AdapterFileConfig['wechat']> = {}
    readOptionalStringListField(source, wechat, 'allowedUsers', 'wechat.allowedUsers')
    if ('pairedUsers' in source) wechat.pairedUsers = readPairedUsers(source.pairedUsers, 'wechat.pairedUsers')
    readOptionalStringField(source, wechat, 'defaultWorkDir', 'wechat.defaultWorkDir', MAX_PATH_LENGTH)
    patch.wechat = wechat
  }

  if ('dingtalk' in body) {
    const source = requireRecord(body.dingtalk, 'dingtalk')
    assertKnownKeys(
      source,
      ['clientId', 'clientSecret', 'allowedUsers', 'pairedUsers', 'defaultWorkDir', 'endpoint', 'permissionCardTemplateId'],
      'dingtalk',
    )
    const dingtalk: NonNullable<AdapterFileConfig['dingtalk']> = {}
    for (const key of ['clientId', 'clientSecret', 'endpoint', 'permissionCardTemplateId'] as const) {
      readOptionalStringField(source, dingtalk, key, `dingtalk.${key}`, key === 'endpoint' ? 2_048 : MAX_TEXT_LENGTH)
    }
    readOptionalStringListField(source, dingtalk, 'allowedUsers', 'dingtalk.allowedUsers')
    if ('pairedUsers' in source) dingtalk.pairedUsers = readPairedUsers(source.pairedUsers, 'dingtalk.pairedUsers')
    readOptionalStringField(source, dingtalk, 'defaultWorkDir', 'dingtalk.defaultWorkDir', MAX_PATH_LENGTH)
    patch.dingtalk = dingtalk
  }

  if ('whatsapp' in body) {
    const source = requireRecord(body.whatsapp, 'whatsapp')
    assertKnownKeys(source, ['allowedUsers', 'pairedUsers', 'defaultWorkDir'], 'whatsapp')
    const whatsapp: NonNullable<AdapterFileConfig['whatsapp']> = {}
    readOptionalStringListField(source, whatsapp, 'allowedUsers', 'whatsapp.allowedUsers')
    if ('pairedUsers' in source) whatsapp.pairedUsers = readPairedUsers(source.pairedUsers, 'whatsapp.pairedUsers')
    readOptionalStringField(source, whatsapp, 'defaultWorkDir', 'whatsapp.defaultWorkDir', MAX_PATH_LENGTH)
    patch.whatsapp = whatsapp
  }

  return patch
}

type RegistrationApiResponse<T extends Record<string, unknown>> = T & {
  errcode: number
  errmsg?: string
}

type RegistrationBeginPayload = {
  deviceCode: string
  userCode?: string
  verificationUri?: string
  verificationUriComplete: string
  expiresInSeconds: number
  intervalSeconds: number
  qrDataUrl?: string
}

const DINGTALK_REGISTRATION_BASE_URL =
  process.env.DINGTALK_REGISTRATION_BASE_URL?.trim() || 'https://oapi.dingtalk.com'
const DINGTALK_REGISTRATION_SOURCE =
  process.env.DINGTALK_REGISTRATION_SOURCE?.trim() || 'DING_DWS_CLAW'

async function postDingtalkRegistration<T extends Record<string, unknown>>(
  path: string,
  body: Record<string, unknown>,
  action: string,
): Promise<RegistrationApiResponse<T>> {
  const res = await fetch(`${DINGTALK_REGISTRATION_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => null) as RegistrationApiResponse<T> | null
  if (!res.ok || !data || data.errcode !== 0) {
    throw ApiError.internal(`[DingTalk ${action}] ${data?.errmsg || res.statusText || 'unknown error'}`)
  }
  return data
}

async function createQrDataUrl(text: string): Promise<string | undefined> {
  try {
    const qr = await import('qrcode') as any
    return await qr.toDataURL(text, { margin: 1, width: 220 })
  } catch {
    return undefined
  }
}

async function beginDingtalkRegistration(): Promise<RegistrationBeginPayload> {
  const initData = await postDingtalkRegistration<{ nonce?: string }>(
    '/app/registration/init',
    { source: DINGTALK_REGISTRATION_SOURCE },
    'init',
  )
  const nonce = String(initData.nonce ?? '').trim()
  if (!nonce) throw ApiError.internal('[DingTalk init] missing nonce')

  const beginData = await postDingtalkRegistration<{
    device_code?: string
    user_code?: string
    verification_uri?: string
    verification_uri_complete?: string
    expires_in?: number
    interval?: number
  }>('/app/registration/begin', { nonce }, 'begin')

  const deviceCode = String(beginData.device_code ?? '').trim()
  const verificationUriComplete = String(beginData.verification_uri_complete ?? '').trim()
  if (!deviceCode) throw ApiError.internal('[DingTalk begin] missing device_code')
  if (!verificationUriComplete) throw ApiError.internal('[DingTalk begin] missing verification_uri_complete')

  const expiresInSeconds = Number(beginData.expires_in ?? 7200)
  const intervalSeconds = Number(beginData.interval ?? 3)

  return {
    deviceCode,
    userCode: String(beginData.user_code ?? '').trim() || undefined,
    verificationUri: String(beginData.verification_uri ?? '').trim() || undefined,
    verificationUriComplete,
    expiresInSeconds: Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 7200,
    intervalSeconds: Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : 3,
    qrDataUrl: await createQrDataUrl(verificationUriComplete),
  }
}

async function pollDingtalkRegistration(deviceCode: string): Promise<Response> {
  if (!deviceCode) throw ApiError.badRequest('deviceCode is required')

  const pollData = await postDingtalkRegistration<{
    status?: string
    client_id?: string
    client_secret?: string
    fail_reason?: string
  }>('/app/registration/poll', { device_code: deviceCode }, 'poll')

  const status = String(pollData.status ?? '').trim().toUpperCase()
  if (status === 'SUCCESS') {
    const clientId = String(pollData.client_id ?? '').trim()
    const clientSecret = String(pollData.client_secret ?? '').trim()
    if (!clientId || !clientSecret) {
      throw ApiError.internal('DingTalk authorization succeeded but credentials are missing')
    }
    await adapterService.updateConfig({
      dingtalk: {
        clientId,
        clientSecret,
      },
    })
    return Response.json({
      status,
      config: await adapterService.getConfig(),
    })
  }

  return Response.json({
    status: status || 'UNKNOWN',
    failReason: String(pollData.fail_reason ?? '').trim() || undefined,
  })
}

export async function handleAdaptersApi(
  req: Request,
  _url: URL,
  _segments: string[],
): Promise<Response> {
  try {
    const tail = _segments.slice(2)

    // Pure-web process control lives in adapterProcess.ts (router routes
    // /api/adapters/process/* there so optional IM SDKs are not loaded).

    if (tail[0] === 'wechat') {
      return await handleWechatAdaptersApi(req, tail.slice(1))
    }
    if (tail[0] === 'whatsapp') {
      return await handleWhatsAppAdaptersApi(req, tail.slice(1))
    }
    if (tail[0] === 'dingtalk' && req.method === 'POST' && tail[1] === 'unbind') {
      await adapterService.updateConfig({
        dingtalk: {
          clientId: undefined,
          clientSecret: undefined,
          allowedUsers: [],
          pairedUsers: [],
          permissionCardTemplateId: undefined,
        },
      })
      return Response.json(await adapterService.getConfig())
    }
    if (tail[0] === 'dingtalk' && tail[1] === 'registration') {
      if (req.method === 'POST' && tail[2] === 'begin') {
        return Response.json(await beginDingtalkRegistration())
      }
      if (req.method === 'POST' && tail[2] === 'poll') {
        const body = await req.json().catch(() => {
          throw ApiError.badRequest('Request body must be valid JSON')
        })
        const deviceCode = isRecord(body) ? body.deviceCode : undefined
        if (typeof deviceCode !== 'string' || !deviceCode.trim() || deviceCode.length > 256) {
          throw ApiError.badRequest('deviceCode is required')
        }
        return pollDingtalkRegistration(deviceCode.trim())
      }
    }

    if (req.method === 'GET') {
      const config = await adapterService.getConfig()
      return Response.json(config)
    }

    if (req.method === 'PUT') {
      const body = await req.json().catch(() => {
        throw ApiError.badRequest('Request body must be valid JSON')
      })
      await adapterService.updateConfig(parseAdapterConfigPatch(body))
      const config = await adapterService.getConfig()
      return Response.json(config)
    }

    throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
  } catch (error) {
    return errorResponse(error)
  }
}

async function handleWechatAdaptersApi(req: Request, tail: string[]): Promise<Response> {
  if (req.method === 'POST' && tail[0] === 'login' && tail[1] === 'start') {
    const { startWechatLoginWithQr } = await loadWechatProtocol()
    const result = await startWechatLoginWithQr({ force: true })
    return Response.json(result)
  }

  if (req.method === 'POST' && tail[0] === 'login' && tail[1] === 'poll') {
    const body = await req.json().catch(() => {
      throw ApiError.badRequest('Request body must be valid JSON')
    })
    const sessionKey = isRecord(body) ? body.sessionKey : undefined
    if (typeof sessionKey !== 'string' || !sessionKey || sessionKey.length > 256) {
      throw ApiError.badRequest('Missing or invalid sessionKey')
    }
    const { pollWechatLoginWithQr } = await loadWechatProtocol()
    const result = await pollWechatLoginWithQr({ sessionKey })
    if (result.connected) {
      await adapterService.updateConfig({
        wechat: {
          accountId: result.accountId,
          botToken: result.botToken,
          baseUrl: result.baseUrl || WECHAT_DEFAULT_BASE_URL,
          userId: result.userId,
          pairedUsers: [],
        },
      })
    }
    return Response.json(result.connected ? await adapterService.getConfig() : result)
  }

  if (req.method === 'POST' && tail[0] === 'unbind') {
    await adapterService.updateConfig({
      wechat: {
        accountId: undefined,
        botToken: undefined,
        baseUrl: WECHAT_DEFAULT_BASE_URL,
        userId: undefined,
        pairedUsers: [],
        allowedUsers: [],
      },
    })
    return Response.json(await adapterService.getConfig())
  }

  throw new ApiError(404, 'Unknown WeChat adapter endpoint', 'NOT_FOUND')
}

async function handleWhatsAppAdaptersApi(req: Request, tail: string[]): Promise<Response> {
  if (req.method === 'POST' && tail[0] === 'login' && tail[1] === 'start') {
    await cleanupExpiredWhatsAppStaging()
    const { loadConfig } = await loadAdapterCommonConfig()
    const { startWhatsAppLoginWithQr } = await loadWhatsAppProtocol()
    const config = loadConfig()
    const configuredTarget = path.resolve(config.whatsapp.authDir)
    const targetDir = isManagedWhatsAppAuthDir(configuredTarget)
      ? configuredTarget
      : getDefaultManagedWhatsAppAuthDir()
    const stagingDir = path.join(getManagedWhatsAppRoot(), `.login-${crypto.randomUUID()}`)
    try {
      const result = await startWhatsAppLoginWithQr({
        authDir: stagingDir,
        force: true,
      })
      whatsappLoginDirs.set(result.sessionKey, {
        stagingDir,
        targetDir,
        createdAt: Date.now(),
      })
      return Response.json({
        ...result,
        qrDataUrl: result.qr ? await createQrDataUrl(result.qr) : undefined,
      })
    } catch (error) {
      await removeManagedWhatsAppDir(stagingDir)
      if (isMissingOptionalModule(error)) throw optionalSdkError('WhatsApp', error)
      throw error
    }
  }

  if (req.method === 'POST' && tail[0] === 'login' && tail[1] === 'poll') {
    const body = await req.json().catch(() => {
      throw ApiError.badRequest('Request body must be valid JSON')
    })
    const sessionKey = isRecord(body) ? body.sessionKey : undefined
    if (typeof sessionKey !== 'string' || !sessionKey || sessionKey.length > 256) {
      throw ApiError.badRequest('Missing or invalid sessionKey')
    }
    const loginDirs = whatsappLoginDirs.get(sessionKey)
    if (!loginDirs) {
      return Response.json({
        connected: false,
        status: 'expired',
        message: 'WhatsApp login session expired. Generate a new QR code.',
      })
    }
    const { pollWhatsAppLoginWithQr } = await loadWhatsAppProtocol()
    const result = await pollWhatsAppLoginWithQr({ sessionKey })
    if (result.connected) {
      whatsappLoginDirs.delete(sessionKey)
      await promoteWhatsAppAuth(loginDirs.stagingDir, loginDirs.targetDir)
      await adapterService.updateConfig({
        whatsapp: {
          accountJid: result.accountJid,
          authDir: loginDirs.targetDir,
          pairedUsers: [],
        },
      })
      return Response.json(await adapterService.getConfig())
    }
    if (result.status === 'expired' || result.status === 'error') {
      whatsappLoginDirs.delete(sessionKey)
      await removeManagedWhatsAppDir(loginDirs.stagingDir)
    }
    return Response.json({
      ...result,
      qrDataUrl: result.qr ? await createQrDataUrl(result.qr) : undefined,
    })
  }

  if (req.method === 'POST' && tail[0] === 'unbind') {
    // Unbind should succeed even when baileys is missing: clear local config,
    // and only attempt auth-dir logout when the SDK can load.
    let authDir: string | null = null
    try {
      const { loadConfig } = await loadAdapterCommonConfig()
      const config = loadConfig()
      authDir = config.whatsapp?.authDir
        ? path.resolve(config.whatsapp.authDir)
        : null
    } catch {
      authDir = null
    }
    if (authDir && isManagedWhatsAppAuthDir(authDir)) {
      try {
        const { logoutWhatsAppAuth } = await loadWhatsAppProtocol()
        await logoutWhatsAppAuth(authDir)
      } catch (error) {
        // Missing SDK or logout failure: still clear web config.
        if (!isMissingOptionalModule(error)) {
          console.warn('[adapters] WhatsApp logout failed during unbind:', error)
        }
      }
    }
    await adapterService.updateConfig({
      whatsapp: {
        accountJid: undefined,
        authDir: getDefaultManagedWhatsAppAuthDir(),
        pairedUsers: [],
        allowedUsers: [],
      },
    })
    return Response.json(await adapterService.getConfig())
  }

  throw new ApiError(404, 'Unknown WhatsApp adapter endpoint', 'NOT_FOUND')
}
