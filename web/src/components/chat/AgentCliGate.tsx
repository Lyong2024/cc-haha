import { useCallback, useEffect, useState } from 'react'
import { agentCliApi, type AgentCliListResponse } from '../../api/agentCli'
import { Button } from '@/components/ui/Button'
import { SETTINGS_TAB_ID, useTabStore } from '../../stores/tabStore'

/**
 * Hard gate: when no Agent CLI is runnable on the host, block chat and guide install.
 */
export function AgentCliGateBanner() {
  const [data, setData] = useState<AgentCliListResponse | null>(null)

  const load = useCallback(async () => {
    try {
      const next = await agentCliApi.list(true)
      setData(next)
    } catch {
      setData(null)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 30_000)
    return () => window.clearInterval(timer)
  }, [load])

  if (!data) return null

  if (!data.anyRunnable) {
    return (
      <div
        className="mx-auto mb-3 w-full max-w-2xl rounded-[var(--radius-md)] border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
        role="alert"
      >
        <div className="font-medium text-[var(--color-text-primary)]">
          未检测到可用的 Agent CLI
        </div>
        <p className="mt-1 text-[var(--color-text-secondary)]">
          对话已禁用。请在「系统管理 → Agent 管理」安装 Claude Code 或其他 CLI（用户级 npm 安装）。
        </p>
        <div className="mt-2">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              try {
                useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
              } catch {
                // ignore
              }
            }}
          >
            打开系统管理
          </Button>
        </div>
      </div>
    )
  }

  const active = data.tools.find((t) => t.id === data.activeId)
  if (active && !active.runnable) {
    return (
      <div
        className="mx-auto mb-3 w-full max-w-2xl rounded-[var(--radius-md)] border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
        role="status"
      >
        <div className="font-medium">当前 CLI「{active.displayName}」未安装或不可用</div>
        <p className="mt-1 text-[var(--color-text-secondary)]">
          请切换顶栏已安装的 CLI Logo，或前往系统管理安装。
        </p>
      </div>
    )
  }

  return null
}

/** Returns whether chat composer should accept input. */
export function useAgentCliChatAllowed(): {
  allowed: boolean
  loading: boolean
  data: AgentCliListResponse | null
} {
  const [data, setData] = useState<AgentCliListResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void agentCliApi.list(true)
      .then((next) => {
        if (!cancelled) setData(next)
      })
      .catch(() => {
        if (!cancelled) setData(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) return { allowed: true, loading: true, data }
  if (!data) return { allowed: true, loading: false, data }
  if (!data.anyRunnable) return { allowed: false, loading: false, data }
  const active = data.tools.find((t) => t.id === data.activeId)
  if (active && !active.runnable) return { allowed: false, loading: false, data }
  return { allowed: true, loading: false, data }
}
