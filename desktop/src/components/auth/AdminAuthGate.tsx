import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { api, ApiError, getBaseUrl, setBaseUrl } from '../../api/client'
import { getSameOriginServerUrl } from '../../lib/desktopRuntime'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { BrandSeal } from '../composite/BrandSeal'

type AuthStatus = {
  setupRequired: boolean
  authenticated: boolean
  mode: string
  username?: string | null
}

type GateState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: AuthStatus }
  | { kind: 'error'; message: string }

const USERNAME_MIN = 3
const USERNAME_MAX = 32
const PASSWORD_MIN = 8

export function AdminAuthGate({ children }: { children: React.ReactNode }) {
  const [gate, setGate] = useState<GateState>({ kind: 'loading' })
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const sameOrigin = getSameOriginServerUrl()
      if (sameOrigin) setBaseUrl(sameOrigin)
      const status = await api.get<AuthStatus>('/api/auth/status')
      setGate({ kind: 'ready', status })
      if (!status.setupRequired && status.username) {
        setUsername((current) => current || status.username || '')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setGate({ kind: 'error', message: `无法连接服务器 ${getBaseUrl()}: ${message}` })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const setupMode = gate.kind === 'ready' && gate.status.setupRequired

  const canSubmit = useMemo(() => {
    const nameOk = username.trim().length >= USERNAME_MIN && username.trim().length <= USERNAME_MAX
    const passOk = password.trim().length >= PASSWORD_MIN
    if (!nameOk || !passOk) return false
    if (setupMode && password !== confirmPassword) return false
    return true
  }, [username, password, confirmPassword, setupMode])

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (gate.kind !== 'ready') return
    setBusy(true)
    setFormError(null)
    try {
      if (setupMode) {
        if (password !== confirmPassword) {
          setFormError('两次输入的密码不一致')
          return
        }
        await api.post('/api/auth/setup', {
          username: username.trim(),
          password,
          confirmPassword,
        })
      } else {
        await api.post('/api/auth/login', {
          username: username.trim(),
          password,
        })
      }
      setPassword('')
      setConfirmPassword('')
      await refresh()
    } catch (error) {
      if (error instanceof ApiError) {
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
            hint={setupMode ? `${USERNAME_MIN}–${USERNAME_MAX} 位，字母/数字/下划线/连字符` : undefined}
          />

          <Input
            label="密码"
            name="password"
            type="password"
            autoComplete={setupMode ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={setupMode ? '至少 8 位' : '密码'}
            minLength={PASSWORD_MIN}
            required
            size="lg"
            hint={setupMode ? `至少 ${PASSWORD_MIN} 位` : undefined}
          />

          {setupMode ? (
            <Input
              label="确认密码"
              name="confirmPassword"
              type="password"
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

          <Button
            type="submit"
            size="lg"
            className="mt-1 w-full"
            disabled={busy || !canSubmit}
            loading={busy}
          >
            {setupMode ? '完成初始化并进入' : '登录'}
          </Button>

          {setupMode ? (
            <p className="text-center text-xs text-[var(--color-text-tertiary)]">
              仅支持单一管理员；初始化完成后不可通过此页面重新 setup。
            </p>
          ) : null}
        </form>
      </Card>
    </div>
  )
}
