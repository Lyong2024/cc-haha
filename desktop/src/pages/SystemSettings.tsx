import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../api/client'
import { SettingsPageHeader, SettingsSection } from '@/components/settings/SettingsSection'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'

const ADAPTER_PLATFORMS = ['telegram', 'feishu', 'wechat', 'dingtalk', 'whatsapp'] as const
type AdapterPlatform = (typeof ADAPTER_PLATFORMS)[number]

type OnlineUser = {
  id: string
  source: 'web' | 'im'
  platform: string | null
  identity: string
  ip: string | null
  userAgent: string | null
  sessionRef: string | null
  status: string
  loginAt: string | null
  lastActiveAt: string
}

type OnlineUsersResponse = {
  users: OnlineUser[]
  generatedAt: string
  note?: string
}

function formatTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

export function SystemSettings() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [users, setUsers] = useState<OnlineUser[]>([])
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [runningAdapters, setRunningAdapters] = useState<string[]>([])
  const [adapterBusy, setAdapterBusy] = useState<string | null>(null)
  const [logoutBusy, setLogoutBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [data, processStatus] = await Promise.all([
        api.get<OnlineUsersResponse>('/api/system/online-users'),
        api.get<{ running: string[] }>('/api/adapters/process/status').catch(() => ({ running: [] as string[] })),
      ])
      setUsers(data.users ?? [])
      setGeneratedAt(data.generatedAt ?? null)
      setNote(data.note ?? null)
      setRunningAdapters(processStatus.running ?? [])
    } catch (err) {
      const message = err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err)
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      void load()
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [load])

  async function toggleAdapter(platform: AdapterPlatform, start: boolean) {
    setAdapterBusy(platform)
    try {
      await api.post(start ? '/api/adapters/process/start' : '/api/adapters/process/stop', { platform })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAdapterBusy(null)
    }
  }

  async function logout() {
    setLogoutBusy(true)
    try {
      await api.post('/api/auth/logout', {})
      window.location.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setLogoutBusy(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <SettingsPageHeader
        title="系统管理"
        description="管理员会话、在线用户（Web + IM，只读不踢人）与 IM 进程宿主。"
        action={(
          <Button type="button" variant="secondary" size="sm" disabled={logoutBusy} onClick={() => void logout()}>
            {logoutBusy ? '退出中…' : '退出登录'}
          </Button>
        )}
      />

      <SettingsSection
        title="IM 适配器进程"
        description="无 Electron 时由 Web Server 拉起 adapters 子进程。需先在「IM 接入」配置凭证。"
      >
        <div className="flex flex-wrap gap-2">
          {ADAPTER_PLATFORMS.map((platform) => {
            const running = runningAdapters.includes(platform)
            const busy = adapterBusy === platform
            return (
              <div
                key={platform}
                className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2"
              >
                <Badge tone={running ? 'success' : 'neutral'} size="sm">
                  {platform}
                </Badge>
                <span className="text-xs text-[var(--color-text-secondary)]">
                  {running ? '运行中' : '已停止'}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void toggleAdapter(platform, !running)}
                >
                  {busy ? '…' : running ? '停止' : '启动'}
                </Button>
              </div>
            )
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        title="在线用户"
        description={note ?? 'Web 会话与 IM 活跃身份。列表每 15 秒自动刷新。'}
        action={(
          <Button type="button" variant="secondary" size="sm" onClick={() => void load()}>
            刷新
          </Button>
        )}
      >
        {loading && users.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
            <Spinner size={16} />
            加载中…
          </div>
        ) : null}

        {error ? (
          <p className="text-sm text-red-500" role="alert">{error}</p>
        ) : null}

        {!loading && !error && users.length === 0 ? (
          <p className="text-sm text-[var(--color-text-secondary)]">当前没有在线或近期活跃记录。</p>
        ) : null}

        {users.length > 0 ? (
          <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
            <table className="min-w-full text-left text-[13px]">
              <thead className="bg-[var(--color-surface-container-low)] text-[var(--color-text-secondary)]">
                <tr>
                  <th className="px-3 py-2 font-medium">来源</th>
                  <th className="px-3 py-2 font-medium">身份</th>
                  <th className="px-3 py-2 font-medium">IP</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">登录时间</th>
                  <th className="px-3 py-2 font-medium">最后活跃</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-t border-[var(--color-border-separator)]">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Badge tone={user.source === 'web' ? 'info' : 'success'} size="sm">
                          {user.source === 'web' ? 'Web' : `IM${user.platform ? `/${user.platform}` : ''}`}
                        </Badge>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-[var(--color-text-primary)]">{user.identity}</div>
                      {user.userAgent ? (
                        <div className="mt-0.5 max-w-[240px] truncate text-[11px] text-[var(--color-text-tertiary)]" title={user.userAgent}>
                          {user.userAgent}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-[var(--color-text-secondary)]">{user.ip || '—'}</td>
                    <td className="px-3 py-2">
                      <Badge
                        tone={user.status === 'online' || user.status === 'active' ? 'success' : 'neutral'}
                        size="sm"
                      >
                        {user.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-[var(--color-text-secondary)]">{formatTime(user.loginAt)}</td>
                    <td className="px-3 py-2 text-[var(--color-text-secondary)]">{formatTime(user.lastActiveAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {generatedAt ? (
          <p className="mt-3 text-[11px] text-[var(--color-text-tertiary)]">
            生成时间：{formatTime(generatedAt)}
          </p>
        ) : null}
      </SettingsSection>
    </div>
  )
}
