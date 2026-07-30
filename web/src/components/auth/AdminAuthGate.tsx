import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { api, ApiError, getBaseUrl, setBaseUrl } from '../../api/client'
import { getSameOriginServerUrl } from '../../lib/desktopRuntime'
import { getDeviceFingerprint } from '../../lib/deviceFingerprint'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { BrandSeal } from '../composite/BrandSeal'
import { PasswordField } from './PasswordField'

type LoginLockout = {
  locked: boolean
  failCount: number
  remainingAttempts: number
  lockedUntil: string | null
  retryAfterSeconds: number
}

type AuthStatus = {
  setupRequired: boolean
  authenticated: boolean
  mode: string
  username?: string | null
  lockoutPolicy?: {
    maxFailures: number
    lockDurationSeconds: number
  }
  lockout?: LoginLockout | null
}

type GateState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: AuthStatus }
  | { kind: 'error'; message: string }

const USERNAME_MIN = 3
const USERNAME_MAX = 32
const PASSWORD_MIN = 8

function formatLockCountdown(seconds: number): string {
  if (seconds <= 0) return '即将解除'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h} 小时 ${m} 分`
  if (m > 0) return `${m} 分 ${s} 秒`
  return `${s} 秒`
}

export function AdminAuthGate({ children }: { children: React.ReactNode }) {
  const [gate, setGate] = useState<GateState>({ kind: 'loading' })
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [lockout, setLockout] = useState<LoginLockout | null>(null)
  const [nowTick, setNowTick] = useState(() => Date.now())

  const refresh = useCallback(async (fp?: string | null) => {
    try {
      const sameOrigin = getSameOriginServerUrl()
      if (sameOrigin) setBaseUrl(sameOrigin)
      const deviceId = fp ?? fingerprint ?? (await getDeviceFingerprint())
      setFingerprint((current) => current || deviceId)
      const qs = deviceId ? `?fingerprint=${encodeURIComponent(deviceId)}` : ''
      const status = await api.get<AuthStatus>(`/api/auth/status${qs}`, {
        headers: deviceId ? { 'X-Device-Fingerprint': deviceId } : undefined,
      })
      setGate({ kind: 'ready', status })
      setLockout(status.lockout ?? null)
      if (!status.setupRequired && status.username) {
        setUsername((current) => current || status.username || '')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setGate({ kind: 'error', message: `无法连接服务器 ${getBaseUrl()}: ${message}` })
    }
  }, [fingerprint])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const sameOrigin = getSameOriginServerUrl()
        if (sameOrigin) setBaseUrl(sameOrigin)
        const deviceId = await getDeviceFingerprint()
        if (cancelled) return
        setFingerprint(deviceId)
        const status = await api.get<AuthStatus>(
          `/api/auth/status?fingerprint=${encodeURIComponent(deviceId)}`,
          { headers: { 'X-Device-Fingerprint': deviceId } },
        )
        if (cancelled) return
        setGate({ kind: 'ready', status })
        setLockout(status.lockout ?? null)
        if (!status.setupRequired && status.username) {
          setUsername((current) => current || status.username || '')
        }
      } catch (error) {
        if (cancelled) return
        const message = error instanceof Error ? error.message : String(error)
        setGate({ kind: 'error', message: `无法连接服务器 ${getBaseUrl()}: ${message}` })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Tick while locked so countdown updates.
  useEffect(() => {
    if (!lockout?.locked || !lockout.lockedUntil) return
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [lockout?.locked, lockout?.lockedUntil])

  const setupMode = gate.kind === 'ready' && gate.status.setupRequired

  const retryAfterSeconds = useMemo(() => {
    if (!lockout?.locked || !lockout.lockedUntil) return lockout?.retryAfterSeconds ?? 0
    const until = Date.parse(lockout.lockedUntil)
    if (!Number.isFinite(until)) return lockout.retryAfterSeconds
    return Math.max(0, Math.ceil((until - nowTick) / 1000))
  }, [lockout, nowTick])

  const isLocked = Boolean(lockout?.locked && retryAfterSeconds > 0)

  // Auto-refresh status when lock expires.
  useEffect(() => {
    if (lockout?.locked && retryAfterSeconds === 0) {
      void refresh()
    }
  }, [lockout?.locked, retryAfterSeconds, refresh])

  const canSubmit = useMemo(() => {
    if (isLocked && !setupMode) return false
    const nameOk = username.trim().length >= USERNAME_MIN && username.trim().length <= USERNAME_MAX
    const passOk = password.trim().length >= PASSWORD_MIN
    if (!nameOk || !passOk) return false
    if (setupMode && password !== confirmPassword) return false
    return true
  }, [username, password, confirmPassword, setupMode, isLocked])

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (gate.kind !== 'ready') return
    if (isLocked && !setupMode) {
      setFormError(`登录已锁定，请 ${formatLockCountdown(retryAfterSeconds)} 后再试`)
      return
    }
    setBusy(true)
    setFormError(null)
    try {
      const deviceId = fingerprint ?? (await getDeviceFingerprint())
      setFingerprint(deviceId)
      const headers = { 'X-Device-Fingerprint': deviceId }
      if (setupMode) {
        if (password !== confirmPassword) {
          setFormError('两次输入的密码不一致')
          return
        }
        await api.post('/api/auth/setup', {
          username: username.trim(),
          password,
          confirmPassword,
          fingerprint: deviceId,
        }, { headers })
      } else {
        await api.post('/api/auth/login', {
          username: username.trim(),
          password,
          fingerprint: deviceId,
        }, { headers })
      }
      setPassword('')
      setConfirmPassword('')
      setLockout(null)
      await refresh(deviceId)
    } catch (error) {
      if (error instanceof ApiError) {
        const body = error.body as { lockout?: LoginLockout; message?: string } | undefined
        if (body?.lockout) setLockout(body.lockout)
        setFormError(error.message)
      } else {
        setFormError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      setBusy(false)
    }
  }

  if (gate.kind === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-background)] text-[var(--color-text-primary)]">
        <p className="text-sm text-[var(--color-text-secondary)]">正在连接…</p>
      </div>
    )
  }

  if (gate.kind === 'error') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[var(--color-background)] px-6 text-center text-[var(--color-text-primary)]">
        <h1 className="text-xl font-semibold" style={{ fontFamily: 'var(--font-headline)' }}>
          服务器不可用
        </h1>
        <p className="max-w-md text-sm text-[var(--color-text-secondary)]">{gate.message}</p>
        <Button type="button" variant="secondary" size="sm" onClick={() => void refresh()}>
          重试
        </Button>
      </div>
    )
  }

  if (gate.status.authenticated) {
    return <>{children}</>
  }

  const maxFailures = gate.status.lockoutPolicy?.maxFailures ?? 10

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-background)] px-4 py-10 text-[var(--color-text-primary)]">
      <Card
        as="section"
        radius="lg"
        padding="lg"
        shadow="card"
        className="w-full max-w-md border border-[var(--color-border)]"
      >
        <div className="mb-6 flex flex-col items-center text-center">
          <BrandSeal size="lg" className="mb-3" />
          <h1
            className="text-xl font-semibold tracking-tight"
            style={{ fontFamily: 'var(--font-headline)' }}
          >
            {setupMode ? '系统初始化' : '管理员登录'}
          </h1>
          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
            {setupMode
              ? '首次启动请创建唯一管理员账号与密码。此账号用于 Web 控制台登录。'
              : '使用初始化时设置的管理员账号与密码登录。'}
          </p>
        </div>

        {isLocked && !setupMode ? (
          <div
            className="mb-4 rounded-[var(--radius-md)] border border-[var(--color-error)]/40 bg-[var(--color-error)]/10 px-3 py-2 text-sm text-[var(--color-error)]"
            role="alert"
          >
            本设备/网络登录失败次数过多，已临时锁定。
            <br />
            剩余解锁时间：<strong>{formatLockCountdown(retryAfterSeconds)}</strong>
          </div>
        ) : null}

        <form onSubmit={onSubmit} className="flex flex-col gap-4" autoComplete="on">
          <Input
            label="账号"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={setupMode ? '例如 admin' : '管理员账号'}
            minLength={USERNAME_MIN}
            maxLength={USERNAME_MAX}
            required
            size="lg"
            disabled={isLocked && !setupMode}
            hint={setupMode ? `${USERNAME_MIN}–${USERNAME_MAX} 位，字母/数字/下划线/连字符` : undefined}
          />

          <PasswordField
            label="密码"
            name="password"
            autoComplete={setupMode ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={setupMode ? '至少 8 位' : '密码'}
            minLength={PASSWORD_MIN}
            required
            size="lg"
            disabled={isLocked && !setupMode}
            hint={setupMode ? `至少 ${PASSWORD_MIN} 位` : undefined}
          />

          {setupMode ? (
            <PasswordField
              label="确认密码"
              name="confirmPassword"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="再次输入密码"
              minLength={PASSWORD_MIN}
              required
              size="lg"
              error={
                confirmPassword.length > 0 && confirmPassword !== password
                  ? '两次输入的密码不一致'
                  : undefined
              }
            />
          ) : null}

          {formError ? (
            <p className="text-sm text-[var(--color-error)]" role="alert">
              {formError}
            </p>
          ) : null}

          {!setupMode && !isLocked && lockout && lockout.failCount > 0 ? (
            <p className="text-xs text-[var(--color-text-tertiary)]">
              已失败 {lockout.failCount}/{maxFailures} 次；连续失败 {maxFailures} 次将锁定本设备 1 小时。
            </p>
          ) : null}

          <Button
            type="submit"
            size="lg"
            className="mt-1 w-full"
            disabled={busy || !canSubmit}
            loading={busy}
          >
            {setupMode ? '完成初始化并进入' : isLocked ? '已锁定' : '登录'}
          </Button>

          {setupMode ? (
            <p className="text-center text-xs text-[var(--color-text-tertiary)]">
              仅支持单一管理员；初始化完成后不可通过此页面重新 setup。
            </p>
          ) : (
            <p className="text-center text-xs text-[var(--color-text-tertiary)]">
              安全策略：浏览器指纹 + IP 防暴力破解；失败 {maxFailures} 次锁定 1 小时。
            </p>
          )}
        </form>
      </Card>
    </div>
  )
}
