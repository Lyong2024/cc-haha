import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type AgentCliId,
  type AgentCliListResponse,
  type ProbeReport,
} from '../../api/agentCli'
import { SETTINGS_TAB_ID, useTabStore } from '../../stores/tabStore'
import { useAgentCliStore } from '../../stores/agentCliStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useUIStore } from '../../stores/uiStore'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'

/** Public asset: web/public/cli-logos/{id}.svg */
export function cliLogoSrc(id: AgentCliId): string {
  const base = import.meta.env.BASE_URL || './'
  const prefix = base.endsWith('/') ? base : `${base}/`
  return `${prefix}cli-logos/${id}.svg`
}

type PendingAction =
  | { kind: 'switch'; tool: ProbeReport }
  | { kind: 'install'; tool: ProbeReport }

/** Trigger chip: logo larger than dense toolbar icons so brand marks stay readable. */
const TRIGGER_LOGO_PX = 22
/** Dropdown row logo — slightly larger for list scanning. */
const MENU_LOGO_PX = 24

function CliLogoMark({
  id,
  name,
  broken,
  onBroken,
  size = TRIGGER_LOGO_PX,
}: {
  id: AgentCliId
  name: string
  broken?: boolean
  onBroken?: () => void
  size?: number
}) {
  if (broken) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-container)] font-semibold text-[var(--color-text-secondary)]"
        style={{ width: size + 10, height: size + 10, fontSize: Math.max(12, size * 0.55) }}
      >
        {name.slice(0, 1)}
      </span>
    )
  }
  return (
    <img
      src={cliLogoSrc(id)}
      alt=""
      aria-hidden
      draggable={false}
      className="shrink-0 object-contain"
      style={{ width: size, height: size }}
      onError={onBroken}
    />
  )
}

/**
 * Top-right Agent CLI switcher: one active logo; click opens a dropdown of
 * logo + name rows. Switching requires confirm; uninstalled CLIs offer
 * navigation to System Management install.
 */
export function CliLogoSwitcher() {
  const [data, setData] = useState<AgentCliListResponse | null>(null)
  const [brokenLogos, setBrokenLogos] = useState<Partial<Record<AgentCliId, boolean>>>({})
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const activeId = useAgentCliStore((s) => s.activeId)
  const refresh = useAgentCliStore((s) => s.refresh)
  const setActive = useAgentCliStore((s) => s.setActive)
  const setFocusInstallId = useAgentCliStore((s) => s.setFocusInstallId)

  const load = useCallback(async () => {
    const next = await refresh(true)
    if (next) setData(next)
  }, [refresh])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const currentId = (data?.activeId || activeId) as AgentCliId
  const currentTool = data?.tools.find((t) => t.id === currentId) ?? data?.tools[0] ?? null

  function markBroken(id: AgentCliId) {
    setBrokenLogos((prev) => (prev[id] ? prev : { ...prev, [id]: true }))
  }

  function requestSelect(tool: ProbeReport) {
    setOpen(false)
    if (tool.id === currentId && tool.runnable) return
    if (!tool.runnable) {
      setPending({ kind: 'install', tool })
      return
    }
    setPending({ kind: 'switch', tool })
  }

  async function confirmPending() {
    if (!pending) return
    const { tool, kind } = pending
    if (kind === 'install') {
      setFocusInstallId(tool.id)
      try {
        useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
      } catch {
        // ignore
      }
      useUIStore.getState().setPendingSettingsTab('system')
      useUIStore.getState().setActiveSettingsTab('system')
      useUIStore.getState().addToast({
        type: 'info',
        message: `请在「系统管理 → Agent 管理」中点击 ${tool.displayName} 的安装按钮`,
        duration: 6000,
      })
      setPending(null)
      return
    }

    setBusy(true)
    try {
      await setActive(tool.id)
      setData((prev) => (prev ? { ...prev, activeId: tool.id } : prev))
      useSessionStore.setState({ sessions: [], activeSessionId: null })
      await useSessionStore.getState().fetchSessions()
      useUIStore.getState().addToast({
        type: 'success',
        message: `已切换到 ${tool.displayName}`,
        duration: 2500,
      })
    } catch (err) {
      useUIStore.getState().addToast({
        type: 'error',
        message: err instanceof Error ? err.message : `切换 ${tool.displayName} 失败`,
      })
    } finally {
      setBusy(false)
      setPending(null)
    }
  }

  if (!data?.tools?.length || !currentTool) return null

  const triggerTooltip = `${currentTool.displayName}${
    currentTool.localVersion ? ` ${currentTool.localVersion}` : ''
  } · 点击切换 Agent CLI`

  return (
    <div ref={rootRef} className="relative" data-testid="cli-logo-switcher">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={triggerTooltip}
        aria-label={triggerTooltip}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="cli-logo-switcher-trigger"
        className={[
          'relative flex h-10 min-w-[9.5rem] max-w-[14rem] items-center gap-2.5 rounded-full',
          'border border-[var(--color-border)] bg-[var(--color-surface)]',
          'px-3 py-1.5 transition',
          'hover:bg-[var(--color-surface-container-high)]',
          open
            ? 'ring-2 ring-[var(--color-primary)] ring-offset-1 ring-offset-[var(--color-surface)]'
            : '',
        ].join(' ')}
      >
        <span
          className={[
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
            'bg-[var(--color-surface-container)]',
          ].join(' ')}
        >
          <CliLogoMark
            id={currentTool.id}
            name={currentTool.displayName}
            broken={!!brokenLogos[currentTool.id]}
            onBroken={() => markBroken(currentTool.id)}
            size={TRIGGER_LOGO_PX}
          />
        </span>
        <span
          className="min-w-0 flex-1 truncate text-left text-[13px] font-medium leading-tight text-[var(--color-text-primary)]"
          data-testid="cli-logo-switcher-label"
        >
          {currentTool.displayName}
        </span>
        <span className="material-symbols-outlined shrink-0 text-[20px] text-[var(--color-text-tertiary)]">
          {open ? 'expand_less' : 'expand_more'}
        </span>
        {currentTool.upgradeAvailable ? (
          <span className="absolute right-1.5 top-1 h-2 w-2 rounded-full bg-amber-500" />
        ) : null}
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label="选择 Agent CLI"
          data-testid="cli-logo-switcher-menu"
          className={[
            'absolute right-0 z-[var(--z-popover,50)] mt-1.5 min-w-[16rem] overflow-hidden',
            'rounded-[var(--radius-lg)] border border-[var(--color-border)]',
            'bg-[var(--color-surface)] py-1.5 shadow-lg',
          ].join(' ')}
        >
          <div className="px-3.5 py-1.5 text-[12px] text-[var(--color-text-tertiary)]">
            切换当前 Agent CLI（本页仅激活一个）
          </div>
          {data.tools.map((tool) => {
            const active = tool.id === currentId
            const dim = !tool.runnable
            const status = tool.runnable
              ? active
                ? '当前'
                : tool.localVersion
                  ? `v${tool.localVersion}`
                  : '已安装'
              : '未安装'
            return (
              <button
                key={tool.id}
                type="button"
                role="option"
                aria-selected={active}
                data-testid={`cli-logo-option-${tool.id}`}
                onClick={() => requestSelect(tool)}
                className={[
                  'flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition',
                  active
                    ? 'bg-[var(--color-surface-container-high)]'
                    : 'hover:bg-[var(--color-surface-container)]',
                  dim ? 'opacity-70' : '',
                ].join(' ')}
              >
                <span
                  className={[
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                    active
                      ? 'bg-[var(--color-surface)] ring-2 ring-[var(--color-primary)]'
                      : 'bg-[var(--color-surface-container)]',
                    dim ? 'grayscale' : '',
                  ].join(' ')}
                >
                  <CliLogoMark
                    id={tool.id}
                    name={tool.displayName}
                    broken={!!brokenLogos[tool.id]}
                    onBroken={() => markBroken(tool.id)}
                    size={MENU_LOGO_PX}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium leading-snug text-[var(--color-text-primary)]">
                    {tool.displayName}
                  </span>
                  <span className="mt-0.5 block text-[12px] text-[var(--color-text-tertiary)]">
                    {status}
                    {tool.upgradeAvailable ? ' · 可升级' : ''}
                  </span>
                </span>
                {active ? (
                  <span className="material-symbols-outlined shrink-0 text-[18px] text-[var(--color-primary)]">
                    check
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}

      <Modal
        open={!!pending}
        onClose={() => {
          if (!busy) setPending(null)
        }}
        title={
          pending?.kind === 'install'
            ? '尚未安装此 Agent CLI'
            : '确认切换 Agent CLI'
        }
        width={420}
        footer={(
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              loading={busy}
              onClick={() => void confirmPending()}
              data-testid="cli-logo-confirm"
            >
              {pending?.kind === 'install' ? '前往安装' : '确认切换'}
            </Button>
          </div>
        )}
      >
        {pending?.kind === 'install' ? (
          <div className="space-y-3 text-sm text-[var(--color-text-primary)]">
            <p>
              <strong>{pending.tool.displayName}</strong>
              {' '}
              尚未安装（或不可运行）。是否打开
              <strong> 设置 → 系统管理 </strong>
              并定位到对应安装按钮？
            </p>
            <p className="text-xs text-[var(--color-text-secondary)]">
              打开后请点击该 CLI 卡片右侧的「安装」按钮完成安装。
            </p>
          </div>
        ) : pending?.kind === 'switch' ? (
          <div className="space-y-3 text-sm text-[var(--color-text-primary)]">
            <p>
              将当前 Agent CLI 从
              {' '}
              <strong>{currentTool.displayName}</strong>
              {' '}
              切换为
              {' '}
              <strong>{pending.tool.displayName}</strong>
              ？
            </p>
            <p className="text-xs text-[var(--color-text-secondary)]">
              切换后本页会话历史将按该 CLI 重新加载（各 CLI 历史相互隔离）。
            </p>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
