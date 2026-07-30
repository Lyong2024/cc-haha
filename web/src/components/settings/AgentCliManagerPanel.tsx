import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  agentCliApi,
  type AgentCliId,
  type AgentCliJob,
  type AgentCliListResponse,
  type ProbeReport,
} from '../../api/agentCli'
import { ApiError } from '../../api/client'
import { useAgentCliStore } from '../../stores/agentCliStore'
import { SettingsSection } from '@/components/settings/SettingsSection'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'

function maturityLabel(m: ProbeReport['maturity']): string {
  if (m === 'full') return '完整'
  if (m === 'beta') return 'Beta'
  return '仅管理'
}

function statusTone(tool: ProbeReport): 'success' | 'warning' | 'danger' | 'neutral' {
  if (tool.runnable) return 'success'
  if (tool.installedButBroken) return 'danger'
  if (tool.installed) return 'warning'
  return 'neutral'
}

function statusText(tool: ProbeReport): string {
  if (tool.runnable) return '可用'
  if (tool.installedButBroken) return '已装但损坏'
  if (tool.installed) return '已安装'
  return '未安装'
}

function isLocalDevVersion(version: string | null | undefined): boolean {
  if (!version) return false
  const v = version.trim().toLowerCase()
  return (
    v.includes('-local')
    || v.endsWith('.local')
    || /^999\./.test(v)
    || v === '0.0.0'
    || v === 'dev'
  )
}

function formatLocalVersion(version: string | null): string {
  if (!version) return '未检测'
  if (isLocalDevVersion(version)) return `开发构建 ${version}`
  return version
}

/** Split install control: primary action + ··· menu (capsule). */
function InstallCapsule({
  tool,
  busy,
  highlight,
  onInstallSystemLatest,
  onInstallUserLatest,
  onUpgrade,
  onOpenVersion,
}: {
  tool: ProbeReport
  busy: boolean
  highlight?: boolean
  onInstallSystemLatest: () => void
  onInstallUserLatest: () => void
  onUpgrade: () => void
  onOpenVersion: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuOpen])

  const primaryLabel = tool.runnable
    ? (tool.upgradeAvailable ? '升级' : '重装')
    : '安装'
  const primaryAction = tool.runnable ? onUpgrade : onInstallSystemLatest

  return (
    <div
      ref={rootRef}
      className={`relative inline-flex ${highlight ? 'animate-pulse' : ''}`}
      data-testid={highlight ? `agent-cli-install-capsule-focus-${tool.id}` : undefined}
    >
      <div
        className={[
          'inline-flex overflow-hidden rounded-full border shadow-sm',
          highlight
            ? 'border-[var(--color-primary)] ring-2 ring-[var(--color-primary)] ring-offset-2 ring-offset-[var(--color-surface)]'
            : 'border-[var(--color-border)]',
        ].join(' ')}
      >
        <button
          type="button"
          disabled={busy}
          onClick={primaryAction}
          className="h-8 bg-[var(--color-primary)] px-3.5 text-[12px] font-medium text-[var(--color-on-primary,white)] transition-colors hover:opacity-90 disabled:opacity-50"
        >
          {busy ? '处理中…' : primaryLabel}
        </button>
        <button
          type="button"
          disabled={busy}
          aria-label="更多安装选项"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
          className="flex h-8 w-8 items-center justify-center border-l border-[var(--color-border)] bg-[var(--color-surface-container)] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
        >
          <span className="text-[14px] leading-none tracking-tighter" aria-hidden>
            ···
          </span>
        </button>
      </div>
      {menuOpen ? (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+4px)] z-30 min-w-[200px] rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
        >
          {!tool.runnable ? (
            <>
              <MenuItem
                onClick={() => {
                  setMenuOpen(false)
                  onInstallSystemLatest()
                }}
              >
                系统级安装最新版（默认）
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setMenuOpen(false)
                  onInstallUserLatest()
                }}
              >
                用户级安装最新版
              </MenuItem>
            </>
          ) : (
            <MenuItem
              onClick={() => {
                setMenuOpen(false)
                onUpgrade()
              }}
            >
              {tool.upgradeAvailable ? '升级到最新版' : '按最新版重装'}
            </MenuItem>
          )}
          <MenuItem
            onClick={() => {
              setMenuOpen(false)
              onOpenVersion()
            }}
          >
            指定版本…
          </MenuItem>
        </div>
      ) : null}
    </div>
  )
}

function MenuItem({
  children,
  onClick,
}: {
  children: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full px-3 py-1.5 text-left text-[12px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
    >
      {children}
    </button>
  )
}

export function AgentCliManagerPanel() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<AgentCliListResponse | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [job, setJob] = useState<AgentCliJob | null>(null)
  const [manualHint, setManualHint] = useState<string | null>(null)
  const [infoOpenId, setInfoOpenId] = useState<AgentCliId | null>(null)
  const [versionModalId, setVersionModalId] = useState<AgentCliId | null>(null)
  const [versionDraft, setVersionDraft] = useState('')
  const [versionScope, setVersionScope] = useState<'user' | 'system'>('system')
  const focusInstallId = useAgentCliStore((s) => s.focusInstallId)
  const setFocusInstallId = useAgentCliStore((s) => s.setFocusInstallId)
  const cardRefs = useRef<Partial<Record<AgentCliId, HTMLDivElement | null>>>({})

  const load = useCallback(async (skipLatest = false) => {
    setLoading(true)
    setError(null)
    try {
      // skipLatest=false → refresh npm latest for every CLI (user-facing "刷新探测").
      const next = await agentCliApi.list(skipLatest)
      setData(next)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Initial load still fetches latest so cards show version comparison.
    void load(false)
  }, [load])

  // Navigate from top-right CLI switcher: scroll + pulse install target.
  useEffect(() => {
    if (!focusInstallId || loading) return
    const el = cardRefs.current[focusInstallId]
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const timer = window.setTimeout(() => {
      setFocusInstallId(null)
    }, 8000)
    return () => window.clearTimeout(timer)
  }, [focusInstallId, loading, data, setFocusInstallId])

  useEffect(() => {
    if (!job || job.status === 'succeeded' || job.status === 'failed') return
    const timer = window.setInterval(() => {
      void agentCliApi.getJob(job.id).then((next) => {
        setJob(next)
        if (next.status === 'succeeded' || next.status === 'failed') {
          void load(false)
          setBusyId(null)
        }
      }).catch(() => {
        // ignore poll errors
      })
    }, 1500)
    return () => window.clearInterval(timer)
  }, [job, load])

  async function runLifecycle(
    id: AgentCliId,
    action: 'install' | 'upgrade',
    scope: 'user' | 'system' = 'system',
    version = 'latest',
    confirmSystem = scope === 'system',
  ) {
    setBusyId(`${id}:${action}`)
    setError(null)
    setManualHint(null)
    try {
      const res = action === 'install'
        ? await agentCliApi.install(id, { scope, version, confirmSystem })
        : await agentCliApi.upgrade(id, { scope, version, confirmSystem })
      setJob(res.job)
      if (res.manualCommand) setManualHint(res.manualCommand)
      setVersionModalId(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      const body = err && typeof err === 'object' && 'body' in err
        ? (err as { body?: { manualCommand?: string; risk?: string } }).body
        : null
      if (body?.manualCommand) {
        setManualHint(
          `${body.risk ? `${body.risk}\n` : ''}手动命令：${body.manualCommand}`,
        )
      }
      setBusyId(null)
    }
  }

  async function setActive(id: AgentCliId) {
    setBusyId(`${id}:active`)
    try {
      await agentCliApi.setActive(id)
      await load(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  async function setDefault(id: AgentCliId) {
    setBusyId(`${id}:default`)
    try {
      await agentCliApi.setDefault(id)
      await load(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <SettingsSection
      title="Agent 管理"
      description="检测、安装与升级宿主机 Agent CLI。默认系统级安装最新版；详细路径点 i 查看。"
      action={(
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={loading}
          onClick={() => void load(false)}
          icon={loading ? undefined : <span className="material-symbols-outlined text-[16px]">refresh</span>}
        >
          {loading ? '探测中…' : '刷新探测'}
        </Button>
      )}
    >
      {loading && !data ? (
        <div className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
          <Spinner size={16} />
          正在探测本地 CLI 与最新版本…
        </div>
      ) : null}

      {error ? (
        <p className="mb-3 text-sm text-red-500" role="alert">{error}</p>
      ) : null}

      {data ? (
        <p className="mb-3 text-xs text-[var(--color-text-secondary)]">
          当前激活 <strong>{data.activeId}</strong>
          {' · '}
          默认 <strong>{data.defaultId}</strong>
          {data.anyRunnable
            ? null
            : ' · 未检测到可用 CLI'}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        {(data?.tools ?? []).map((tool) => {
          const isActive = data?.activeId === tool.id
          const isDefault = data?.defaultId === tool.id
          const busy = !!busyId && busyId.startsWith(`${tool.id}:`)
          const infoOpen = infoOpenId === tool.id
          const focusInstall = focusInstallId === tool.id

          return (
            <div
              key={tool.id}
              ref={(node) => {
                cardRefs.current[tool.id] = node
              }}
              data-testid={`agent-cli-card-${tool.id}`}
              data-focus-install={focusInstall ? 'true' : undefined}
              className={`w-full rounded-[var(--radius-lg)] border px-3.5 py-3 transition-colors ${
                focusInstall
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary-container,var(--color-surface-container-low))] shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-primary)_35%,transparent)] ring-2 ring-[var(--color-primary)] animate-pulse'
                  : isActive
                    ? 'border-[var(--color-primary)] bg-[var(--color-surface-container-low)]'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)]'
              }`}
            >
              {focusInstall && !tool.runnable ? (
                <p
                  className="mb-2 rounded-[var(--radius-md)] bg-[var(--color-primary)]/10 px-2.5 py-1.5 text-[12px] font-medium text-[var(--color-primary)]"
                  role="status"
                  data-testid={`agent-cli-install-hint-${tool.id}`}
                >
                  请点击右侧「安装」按钮安装 {tool.displayName}
                </p>
              ) : null}
              {/* Header */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-container)] text-sm font-semibold text-[var(--color-text-primary)]">
                    {tool.displayName.slice(0, 1)}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate font-medium text-[var(--color-text-primary)]">
                        {tool.displayName}
                      </span>
                      {isActive ? <Badge tone="brand" size="sm">当前</Badge> : null}
                      {isDefault ? <Badge tone="info" size="sm">默认</Badge> : null}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-text-tertiary)]">
                      <Badge tone={statusTone(tool)} size="sm">{statusText(tool)}</Badge>
                      <span>{maturityLabel(tool.maturity)}</span>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  aria-label={`${tool.displayName} 详细信息`}
                  aria-expanded={infoOpen}
                  title="CLI 路径与探测详情"
                  onClick={() => setInfoOpenId(infoOpen ? null : tool.id)}
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[12px] font-semibold transition-colors ${
                    infoOpen
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-on-primary,white)]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface-container)] text-[var(--color-text-secondary)] hover:border-[var(--color-outline)]'
                  }`}
                >
                  i
                </button>
              </div>

              {/* Compact version row */}
              <div className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[12px] text-[var(--color-text-secondary)]">
                <span>
                  本地{' '}
                  <strong className="font-medium text-[var(--color-text-primary)]">
                    {formatLocalVersion(tool.localVersion)}
                  </strong>
                </span>
                <span>
                  最新{' '}
                  <strong className="font-medium text-[var(--color-text-primary)]">
                    {tool.latestVersion ?? '—'}
                  </strong>
                  {tool.upgradeAvailable ? (
                    <span className="ml-1 text-amber-600">可升级</span>
                  ) : null}
                </span>
              </div>

              {/* Details only via i */}
              {infoOpen ? (
                <div className="mt-2 space-y-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-separator)] bg-[var(--color-surface-container-low)] px-2.5 py-2 text-[11px] text-[var(--color-text-secondary)]">
                  {tool.npmPackage ? (
                    <div className="truncate" title={tool.npmPackage}>
                      包：{tool.npmPackage}
                    </div>
                  ) : null}
                  {tool.hasConflict ? (
                    <div className="text-amber-600">检测到多个安装路径（冲突）</div>
                  ) : null}
                  {tool.installs.length === 0 ? (
                    <div className="text-[var(--color-text-tertiary)]">PATH 上未发现可执行文件</div>
                  ) : (
                    <ul className="max-h-28 space-y-1 overflow-y-auto">
                      {tool.installs.map((row) => (
                        <li key={row.path} className="break-all">
                          <span className="text-[var(--color-text-primary)]">
                            {row.isPathDefault ? '★ ' : ''}
                            {isLocalDevVersion(row.version)
                              ? `开发构建 ${row.version}`
                              : (row.version ?? '未知版本')}
                          </span>
                          <span className="text-[var(--color-text-tertiary)]">
                            {' · '}
                            {row.runnable ? '可运行' : '不可运行'}
                            {' · '}
                            {row.path}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {tool.error ? (
                    <div className="text-red-500">{tool.error}</div>
                  ) : null}
                </div>
              ) : null}

              {/* Actions: secondary left, install capsule right-aligned */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {tool.runnable && !isActive ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void setActive(tool.id)}
                  >
                    设为当前
                  </Button>
                ) : null}
                {!isDefault ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void setDefault(tool.id)}
                  >
                    设为默认
                  </Button>
                ) : null}
                <div className="ml-auto shrink-0">
                  <InstallCapsule
                    tool={tool}
                    busy={busy}
                    highlight={focusInstall && !tool.runnable}
                    onInstallSystemLatest={() =>
                      void runLifecycle(tool.id, 'install', 'system', 'latest', true)
                    }
                    onInstallUserLatest={() =>
                      void runLifecycle(tool.id, 'install', 'user', 'latest', false)
                    }
                    onUpgrade={() =>
                      void runLifecycle(tool.id, 'upgrade', 'system', 'latest', true)
                    }
                    onOpenVersion={() => {
                      setVersionModalId(tool.id)
                      setVersionDraft(tool.latestVersion ?? 'latest')
                      setVersionScope('system')
                    }}
                  />
                </div>
              </div>

              {/* Version modal (from ···) */}
              {versionModalId === tool.id ? (
                <div className="mt-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-2.5">
                  <div className="mb-2 text-[12px] font-medium text-[var(--color-text-primary)]">
                    指定版本安装
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      className="h-8 w-32 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12px] text-[var(--color-text-primary)]"
                      placeholder="latest 或 1.2.3"
                      value={versionDraft}
                      onChange={(e) => setVersionDraft(e.target.value)}
                    />
                    <select
                      className="h-8 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12px]"
                      value={versionScope}
                      onChange={(e) => setVersionScope(e.target.value as 'user' | 'system')}
                    >
                      <option value="system">系统级</option>
                      <option value="user">用户级</option>
                    </select>
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void runLifecycle(
                          tool.id,
                          tool.runnable ? 'upgrade' : 'install',
                          versionScope,
                          versionDraft.trim() || 'latest',
                          versionScope === 'system',
                        )
                      }
                    >
                      确认
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setVersionModalId(null)}
                    >
                      取消
                    </Button>
                  </div>
                  {versionScope === 'system' ? (
                    <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                      系统级可能需要管理员权限；Windows 失败时请使用下方手动命令。
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {manualHint ? (
        <pre className="mt-3 whitespace-pre-wrap rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-2 text-[11px] text-[var(--color-text-secondary)]">
          {manualHint}
        </pre>
      ) : null}

      {job ? (
        <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
          <div className="mb-1 flex items-center gap-2 text-sm">
            <span className="font-medium">任务 {job.action}</span>
            <Badge
              tone={
                job.status === 'succeeded'
                  ? 'success'
                  : job.status === 'failed'
                    ? 'danger'
                    : 'info'
              }
              size="sm"
            >
              {job.status}
            </Badge>
            <span className="text-[var(--color-text-tertiary)]">{job.cliId}</span>
          </div>
          {job.error ? (
            <p className="text-sm text-red-500">{job.error}</p>
          ) : null}
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--color-surface-container-low)] p-2 text-[11px] text-[var(--color-text-secondary)]">
            {job.log || '…'}
          </pre>
        </div>
      ) : null}
    </SettingsSection>
  )
}
