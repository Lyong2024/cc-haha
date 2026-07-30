/**
 * **Grok 官方专用**多账号池表格（chenyme/grok2api 风格）。
 *
 * 仅对服务商 id === `grok-official` 生效；Claude 官方 / ChatGPT 官方 /
 * 任意第三方 API 卡片不得挂载本组件的账号池逻辑。
 *
 * Phase B: multi-row pool · inline 周限/月限 bars · 设为默认 · 退出登录
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SavedProvider, ProviderQuotaSnapshot } from '../../types/provider'
import {
  grokAccountsApi,
  type GrokAccountPublic,
  type GrokAccountsListResponse,
} from '../../api/grokAccounts'
import { ApiError } from '../../api/client'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useProviderStore } from '../../stores/providerStore'
import { useUIStore } from '../../stores/uiStore'
import { useHahaGrokOAuthStore } from '../../stores/hahaGrokOAuthStore'
import { getDesktopHost } from '../../lib/desktopHost'
import { copyTextToClipboard } from '@/lib/clipboard'
import { GROK_OFFICIAL_PROVIDER_ID } from '../../constants/grokOfficialProvider'

function fmt(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—'
  if (Number.isInteger(value)) return value.toLocaleString('en-US')
  return value.toFixed(1)
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—'
  return `${value.toFixed(2)}%`
}

function fmtTime(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString()
}

function statusLabel(status?: ProviderQuotaSnapshot['status'] | null): string {
  if (status === 'ok') return '正常'
  if (status === 'limited') return '受限'
  if (status === 'error') return '错误'
  if (status === 'unknown') return '未知'
  return '未同步'
}

function quotaTone(status?: ProviderQuotaSnapshot['status'] | null): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'ok') return 'success'
  if (status === 'limited') return 'warning'
  if (status === 'error') return 'danger'
  return 'neutral'
}

export function resolveUsed(
  used: number | null | undefined,
  remaining: number | null | undefined,
  limit: number | null | undefined,
): number | null {
  if (used != null && Number.isFinite(used)) return Math.max(0, used)
  if (remaining != null && limit != null && Number.isFinite(remaining) && Number.isFinite(limit)) {
    return Math.max(0, limit - remaining)
  }
  return null
}

export function resolveUsagePercent(
  used: number | null,
  limit: number | null | undefined,
  usagePercent?: number | null,
): number | null {
  if (used != null && limit != null && limit > 0) {
    return Math.max(0, Math.min(100, (used / limit) * 100))
  }
  if (usagePercent != null && Number.isFinite(usagePercent)) {
    return Math.max(0, Math.min(100, usagePercent))
  }
  return null
}

/**
 * grok2api-style quota cell unit:
 *   周限                    17%
 *   ████████████████
 * Label + value on the first row; progress bar on the SECOND row (below label).
 */
function StackedQuotaBar({
  label,
  used,
  remaining,
  limit,
  usagePercent,
  preferRatio = false,
  testId,
}: {
  label: string
  used?: number | null
  remaining?: number | null
  limit?: number | null
  usagePercent?: number | null
  preferRatio?: boolean
  testId?: string
}) {
  const usedVal = resolveUsed(used, remaining, limit)
  const limitVal = limit != null && Number.isFinite(limit) ? limit : null
  const pct = resolveUsagePercent(usedVal, limitVal, usagePercent)
  const fill = pct != null ? Math.max(0, Math.min(100, pct)) : 0
  const hasData = usedVal != null || limitVal != null || remaining != null

  const rightText = !hasData
    ? '—'
    : preferRatio && usedVal != null && limitVal != null
      ? `${fmt(usedVal)}/${fmt(limitVal)}`
      : pct != null
        ? `${Math.round(pct)}%`
        : usedVal != null && limitVal != null
          ? `${fmt(usedVal)}/${fmt(limitVal)}`
          : '—'

  const title =
    usedVal != null && limitVal != null
      ? `${label} 已用 ${fmt(usedVal)} / ${fmt(limitVal)}${pct != null ? ` (${fmtPct(pct)})` : ''}`
      : `${label} ${rightText}`

  return (
    <div
      className="flex w-full min-w-[7.5rem] max-w-[11rem] flex-col gap-1"
      data-testid={testId}
      title={title}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="shrink-0 text-[11px] leading-none text-[var(--color-text-secondary)]">
          {label}
        </span>
        <span className="shrink-0 text-[11px] leading-none tabular-nums text-[var(--color-text-primary)]">
          {rightText}
        </span>
      </div>
      <div
        className="h-[6px] w-full overflow-hidden rounded-sm bg-[#e8e8e8] dark:bg-[var(--color-surface-container)]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct != null ? Number(pct.toFixed(2)) : undefined}
        aria-label={`${label} 使用进度`}
      >
        <div
          className={`h-full rounded-sm transition-[width] duration-300 ${
            pct == null
              ? 'bg-neutral-400 opacity-40'
              : pct >= 95
                ? 'bg-red-500'
                : pct >= 80
                  ? 'bg-amber-500'
                  : 'bg-neutral-900 dark:bg-neutral-100'
          }`}
          style={{ width: pct != null ? `${fill}%` : '0%' }}
        />
      </div>
    </div>
  )
}

const MENU_MIN_WIDTH = 152
const MENU_EST_HEIGHT = 220

/**
 * Row ⋯ menu (grok2api style).
 * Rendered via portal + fixed position so it is NOT clipped by the card's
 * overflow-x-auto table wrapper / limited expanded-card height.
 */
function AccountRowMenu({
  account,
  busy,
  onPrefer,
  onRename,
  onRefresh,
  onSync,
  onLogout,
}: {
  account: GrokAccountPublic
  busy: boolean
  onPrefer: () => void
  onRename: () => void
  onRefresh: () => void
  onSync: () => void
  onLogout: () => void
}) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const updatePosition = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const openUp = spaceBelow < MENU_EST_HEIGHT && rect.top > spaceBelow
    const top = openUp
      ? Math.max(8, rect.top - MENU_EST_HEIGHT - 4)
      : Math.min(rect.bottom + 4, window.innerHeight - MENU_EST_HEIGHT - 8)
    const left = Math.min(
      Math.max(8, rect.right - MENU_MIN_WIDTH),
      window.innerWidth - MENU_MIN_WIDTH - 8,
    )
    setCoords({ top, left })
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null)
      return
    }
    updatePosition()
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onReposition = () => updatePosition()
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onReposition)
    // Capture scroll from any ancestor (settings pane, card, table)
    window.addEventListener('scroll', onReposition, true)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [open, updatePosition])

  const closeAnd = (fn: () => void) => {
    setOpen(false)
    fn()
  }

  const menu = open && coords
    ? createPortal(
        <div
          ref={menuRef}
          role="menu"
          data-testid={`account-menu-panel-${account.id}`}
          className="fixed z-[var(--z-popover,200)] min-w-[9.5rem] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
          style={{ top: coords.top, left: coords.left }}
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-container)]"
            onClick={() => closeAnd(onPrefer)}
          >
            <span className="material-symbols-outlined text-[16px] text-[var(--color-text-tertiary)]">
              {account.isPreferred ? 'star' : 'star_outline'}
            </span>
            {account.isPreferred ? '取消默认' : '设为默认'}
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-container)]"
            onClick={() => closeAnd(onRename)}
          >
            <span className="material-symbols-outlined text-[16px] text-[var(--color-text-tertiary)]">edit</span>
            编辑
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-container)]"
            onClick={() => closeAnd(onRefresh)}
          >
            <span className="material-symbols-outlined text-[16px] text-[var(--color-text-tertiary)]">refresh</span>
            刷新凭据
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-container)]"
            onClick={() => closeAnd(onSync)}
          >
            <span className="material-symbols-outlined text-[16px] text-[var(--color-text-tertiary)]">sync</span>
            同步额度
          </button>
          <div className="my-1 border-t border-[var(--color-border-separator)]" />
          <button
            type="button"
            role="menuitem"
            data-testid={`account-logout-${account.id}`}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-red-500 hover:bg-red-500/10"
            onClick={() => closeAnd(onLogout)}
          >
            <span className="material-symbols-outlined text-[16px]">delete</span>
            删除
          </button>
        </div>,
        document.body,
      )
    : null

  return (
    <div className="flex justify-end">
      <button
        ref={triggerRef}
        type="button"
        disabled={busy}
        aria-label="账号操作"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={`account-menu-${account.id}`}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-container-high)] disabled:opacity-50"
      >
        <span className="material-symbols-outlined text-[20px]">more_horiz</span>
      </button>
      {menu}
    </div>
  )
}

type ProviderAccountPanelProps = {
  /** Must be the Grok official shell provider (`id === grok-official`). */
  provider: SavedProvider
  isActive: boolean
  onDeleted?: () => void
  onEditFull?: () => void
  /**
   * @deprecated Prefer checking provider.id. Kept for call-site clarity only;
   * pool APIs still require `provider.id === grok-official`.
   */
  officialOAuth?: boolean
  autoSync?: boolean
  flush?: boolean
}

export function ProviderAccountPanel({
  provider,
  isActive,
  onDeleted,
  autoSync = false,
  flush = false,
}: ProviderAccountPanelProps) {
  const fetchProviders = useProviderStore((s) => s.fetchProviders)
  const addToast = useUIStore((s) => s.addToast)
  const fetchGrokStatus = useHahaGrokOAuthStore((s) => s.fetchStatus)
  const login = useHahaGrokOAuthStore((s) => s.login)
  const startPolling = useHahaGrokOAuthStore((s) => s.startPolling)
  const oauthLoading = useHahaGrokOAuthStore((s) => s.isLoading)

  // HARD SCOPE: multi-account pool is Grok Official only — never Claude/OpenAI/custom.
  const isGrokOfficialOnly = provider.id === GROK_OFFICIAL_PROVIDER_ID

  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [list, setList] = useState<GrokAccountsListResponse | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [logoutTarget, setLogoutTarget] = useState<GrokAccountPublic | null>(null)

  const loadAccounts = useCallback(async () => {
    if (!isGrokOfficialOnly) return
    try {
      const data = await grokAccountsApi.list()
      setList(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [isGrokOfficialOnly])

  useEffect(() => {
    void loadAccounts()
  }, [loadAccounts])

  useEffect(() => {
    if (!autoSync || !isGrokOfficialOnly) return
    let cancelled = false
    void (async () => {
      try {
        const data = await grokAccountsApi.syncAll()
        if (!cancelled) setList(data)
      } catch {
        if (!cancelled) await loadAccounts()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [autoSync, isGrokOfficialOnly, loadAccounts])

  async function run(action: string, fn: () => Promise<void>) {
    setBusy(action)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function handleSyncAll() {
    await run('sync', async () => {
      const data = await grokAccountsApi.syncAll()
      setList(data)
      const ok = data.results?.filter((r) => r.ok).length ?? data.accounts.length
      const fail = (data.results?.length ?? 0) - ok
      addToast({
        type: fail > 0 ? 'warning' : 'success',
        message: fail > 0
          ? `额度同步完成：成功 ${ok}，失败 ${fail}`
          : `额度同步完成（${ok} 个账号）`,
      })
    })
  }

  /** 凭据刷新：刷新池内全部账号 OAuth token */
  async function handleRefreshAll() {
    await run('refresh-all', async () => {
      const data = await grokAccountsApi.refreshAll()
      setList(data)
      const ok = data.refreshedCount ?? data.results?.filter((r) => r.ok).length ?? 0
      const fail = (data.results?.length ?? 0) - ok
      addToast({
        type: fail > 0 ? 'warning' : 'success',
        message: fail > 0
          ? `凭据刷新完成：成功 ${ok}，失败 ${fail}`
          : ok > 0
            ? `凭据已刷新（${ok} 个账号）`
            : '没有可刷新的账号',
      })
      await fetchGrokStatus()
    })
  }

  /** 账号接入：OAuth 新登录并写入账号池 */
  async function handleAccountConnect() {
    await run('connect', async () => {
      const { authorizeUrl } = await login()
      try {
        await getDesktopHost().shell.open(authorizeUrl)
        startPolling()
        addToast({
          type: 'info',
          message: '已打开浏览器完成 Grok 授权，授权成功后账号将自动加入池中',
          duration: 6000,
        })
      } catch {
        // Browser open failed — copy URL fallback
        const ok = await copyTextToClipboard(authorizeUrl)
        addToast({
          type: ok ? 'warning' : 'error',
          message: ok
            ? '无法自动打开浏览器，授权链接已复制到剪贴板，请粘贴到浏览器完成登录'
            : '无法打开浏览器且复制失败，请重试',
          duration: 8000,
        })
        if (ok) startPolling()
      }
    })
  }

  async function handlePrefer(account: GrokAccountPublic) {
    await run(`prefer:${account.id}`, async () => {
      if (account.isPreferred) {
        const data = await grokAccountsApi.setPreferred(account.id, true)
        setList(data)
        addToast({ type: 'info', message: '已恢复轮询（取消默认账号）' })
      } else {
        const data = await grokAccountsApi.setPreferred(account.id, false)
        setList(data)
        addToast({ type: 'success', message: `已设为默认使用：${account.email || account.displayName || account.id}` })
      }
    })
  }

  async function handleLogoutConfirm() {
    if (!logoutTarget) return
    const id = logoutTarget.id
    await run(`logout:${id}`, async () => {
      const res = await grokAccountsApi.logout(id)
      setList({
        preferredAccountId: res.preferredAccountId,
        strategy: res.preferredAccountId ? 'preferred' : 'round_robin',
        accounts: res.accounts,
      })
      setLogoutTarget(null)
      await fetchGrokStatus()
      await fetchProviders()
      addToast({
        type: 'success',
        message: res.remaining === 0 ? '已退出全部 Grok 账号' : '已退出该账号',
      })
      if (res.remaining === 0) onDeleted?.()
    })
  }

  async function handleSyncOne(accountId: string) {
    await run(`sync-one:${accountId}`, async () => {
      const res = await grokAccountsApi.syncOne(accountId)
      setList((prev) =>
        prev
          ? { ...prev, accounts: res.accounts }
          : { preferredAccountId: null, strategy: 'round_robin', accounts: res.accounts },
      )
      addToast({ type: 'success', message: '额度已同步' })
    })
  }

  async function handleRename(accountId: string) {
    const name = nameDraft.trim()
    if (!name) return
    await run(`rename:${accountId}`, async () => {
      const res = await grokAccountsApi.rename(accountId, name)
      setList((prev) =>
        prev
          ? { ...prev, accounts: res.accounts }
          : { preferredAccountId: null, strategy: 'round_robin', accounts: res.accounts },
      )
      setRenamingId(null)
      addToast({ type: 'success', message: '账号名称已更新' })
    })
  }

  async function handleRefreshCredential(account: GrokAccountPublic) {
    await run(`refresh:${account.id}`, async () => {
      const res = await grokAccountsApi.refreshOne(account.id)
      setList((prev) =>
        prev
          ? { ...prev, accounts: res.accounts }
          : { preferredAccountId: null, strategy: 'round_robin', accounts: res.accounts },
      )
      addToast({
        type: res.refreshed ? 'success' : 'warning',
        message: res.refreshed ? '凭据已刷新' : '凭据刷新未完成',
      })
      await fetchGrokStatus()
    })
  }

  const accounts = list?.accounts ?? []
  const strategy = list?.strategy ?? 'round_robin'

  // Refuse to mount pool UI on any non-Grok provider card.
  if (!isGrokOfficialOnly) {
    return (
      <div
        className={`${flush ? '' : 'border-t border-[var(--color-border-separator)] '}px-4 py-3 text-xs text-[var(--color-text-tertiary)]`}
        data-testid="provider-account-panel-scope-guard"
      >
        多账号池仅适用于「Grok 官方」服务商，当前卡片不支持。
      </div>
    )
  }

  return (
    <div
      className={`${flush ? '' : 'border-t border-[var(--color-border-separator)] '}overflow-visible px-3 pb-5 pt-3`}
      data-testid="provider-account-panel"
      data-scope="grok-official-only"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-[var(--color-text-secondary)]">
            Grok 账号池
          </span>
          <Badge tone="neutral" size="sm">{accounts.length} 个</Badge>
          <Badge tone={strategy === 'preferred' ? 'brand' : 'info'} size="sm">
            {strategy === 'preferred' ? '默认账号优先' : '健康账号轮询'}
          </Badge>
        </div>
        {/* Toolbar aligned with grok2api: 额度同步 · 凭据刷新 · 账号接入 */}
        <div className="flex flex-wrap items-center gap-1.5" data-testid="grok-pool-toolbar">
          <Button
            size="sm"
            variant="secondary"
            disabled={!!busy || accounts.length === 0}
            loading={busy === 'sync'}
            onClick={() => void handleSyncAll()}
            data-testid="grok-pool-sync-quota"
          >
            {busy === 'sync' ? '同步中…' : '额度同步'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!!busy || accounts.length === 0}
            loading={busy === 'refresh-all'}
            onClick={() => void handleRefreshAll()}
            data-testid="grok-pool-refresh-creds"
          >
            {busy === 'refresh-all' ? '刷新中…' : '凭据刷新'}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!!busy || oauthLoading}
            loading={busy === 'connect' || oauthLoading}
            onClick={() => void handleAccountConnect()}
            data-testid="grok-pool-connect"
            icon={<span className="material-symbols-outlined text-[16px]">person_add</span>}
          >
            {busy === 'connect' || oauthLoading ? '接入中…' : '账号接入'}
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
        <table className="w-full min-w-[860px] border-collapse text-left text-[12px]" data-testid="provider-account-table">
          <thead>
            <tr className="border-b border-[var(--color-border-separator)] bg-[var(--color-surface-container-low,transparent)] text-[11px] text-[var(--color-text-tertiary)]">
              <th className="whitespace-nowrap px-3 py-2 font-medium">账号</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">类型</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">状态</th>
              <th className="min-w-[18rem] px-3 py-2 font-medium">额度</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">凭据续期</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">创建时间</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-[var(--color-text-tertiary)]">
                  暂无账号，请使用上方「登录 Grok」添加
                </td>
              </tr>
            ) : (
              accounts.map((account) => {
                const q = account.quotaSnapshot
                const monthlyUsed = resolveUsed(q?.used, q?.monthlyRemaining ?? q?.remaining, q?.monthlyLimit ?? q?.limit)
                const monthlyLimit = q?.monthlyLimit ?? q?.limit ?? null
                const monthlyPct = resolveUsagePercent(
                  monthlyUsed,
                  monthlyLimit,
                  monthlyLimit != null && monthlyLimit === q?.limit ? q?.usagePercent : undefined,
                )
                const label = account.email || account.displayName || account.id
                const renew =
                  q?.credentialExpiresAt
                    ? fmtTime(q.credentialExpiresAt)
                    : account.hasRefreshToken
                      ? '支持自动续期'
                      : '—'

                return (
                  <tr
                    key={account.id}
                    className="border-b border-[var(--color-border-separator)] last:border-b-0"
                    data-testid={`provider-account-row-${account.id}`}
                  >
                    <td className="max-w-[11rem] px-3 py-2.5">
                      <div className="truncate font-medium text-[var(--color-text-primary)]" title={label}>
                        {label}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {account.isPreferred ? <Badge tone="brand" size="sm">默认</Badge> : null}
                        {account.isActivePick && !account.isPreferred ? (
                          <Badge tone="info" size="sm">当前选用</Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-[var(--color-text-secondary)]">
                      {account.accountType || 'oauth/grok'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <Badge tone={quotaTone(q?.status)} size="sm">
                        {statusLabel(q?.status)}
                      </Badge>
                    </td>
                    <td className="min-w-[16rem] px-3 py-2.5">
                      {/*
                        额度列：周限 | 月限 并排；
                        每个单元内部「标签+数值」在上，进度条在下（非与标签平级）。
                      */}
                      <div
                        className="flex items-stretch gap-4"
                        data-testid={`quota-meter-primary-${account.id}`}
                      >
                        <StackedQuotaBar
                          label="周限"
                          remaining={q?.weeklyRemaining}
                          limit={q?.weeklyLimit}
                          testId={`quota-meter-weekly-${account.id}`}
                        />
                        <div className="w-px shrink-0 self-stretch bg-[var(--color-border-separator)]" aria-hidden />
                        <StackedQuotaBar
                          label="月限"
                          used={monthlyUsed}
                          remaining={q?.monthlyRemaining ?? (monthlyLimit != null ? q?.remaining : null)}
                          limit={monthlyLimit}
                          usagePercent={monthlyPct}
                          preferRatio
                          testId={`quota-meter-monthly-${account.id}`}
                        />
                      </div>
                    </td>
                    <td
                      className={`whitespace-nowrap px-3 py-2.5 ${
                        renew === '支持自动续期'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-[var(--color-text-secondary)]'
                      }`}
                    >
                      {renew}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-[var(--color-text-secondary)]">
                      {fmtTime(account.createdAt)}
                    </td>
                    <td className="px-2 py-2.5">
                      <AccountRowMenu
                        account={account}
                        busy={!!busy}
                        onPrefer={() => void handlePrefer(account)}
                        onRename={() => {
                          setRenamingId(account.id)
                          setNameDraft(account.displayName || account.email || '')
                        }}
                        onRefresh={() => void handleRefreshCredential(account)}
                        onSync={() => void handleSyncOne(account.id)}
                        onLogout={() => setLogoutTarget(account)}
                      />
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {renamingId ? (
        <div className="mt-2 flex items-center gap-2">
          <Input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            className="h-8 text-sm"
            placeholder="账号显示名称"
          />
          <Button size="sm" disabled={!!busy} onClick={() => void handleRename(renamingId)}>
            保存
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRenamingId(null)}>
            取消
          </Button>
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 text-[12px] text-red-500" role="alert">{error}</p>
      ) : null}

      <Modal
        open={!!logoutTarget}
        onClose={() => {
          if (!busy) setLogoutTarget(null)
        }}
        title="确认删除账号"
        width={420}
        footer={(
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={!!busy} onClick={() => setLogoutTarget(null)}>
              取消
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              loading={!!busy && busy.startsWith('logout:')}
              onClick={() => void handleLogoutConfirm()}
              data-testid="account-logout-confirm"
            >
              确认删除
            </Button>
          </div>
        )}
      >
        <p className="text-sm text-[var(--color-text-primary)]">
          确定删除账号
          {' '}
          <strong>{logoutTarget?.email || logoutTarget?.displayName || logoutTarget?.id}</strong>
          ？将清除本地 OAuth 凭证（退出登录），不可恢复。
        </p>
        {(list?.accounts.length ?? 0) <= 1 ? (
          <p className="mt-2 text-xs text-[var(--color-text-secondary)]">
            这是列表中最后一个账号，删除后需重新登录 Grok。
          </p>
        ) : null}
      </Modal>
    </div>
  )
}
