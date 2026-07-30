/**
 * Graded chat UI for non-Claude Agent CLIs (S4/S6).
 * beta: non-interactive exec + log; manage-only: host terminal launch.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  agentCliApi,
  type AgentCliId,
  type AgentCliMaturity,
  type AgentCliMessage,
} from '../../api/agentCli'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Spinner } from '@/components/ui/Spinner'
import { useSessionStore } from '../../stores/sessionStore'
import { useUIStore } from '../../stores/uiStore'

type ExternalAgentChatProps = {
  cliId: AgentCliId
  sessionId: string
  workDir?: string | null
  maturity?: AgentCliMaturity
}

export function ExternalAgentChat({
  cliId,
  sessionId,
  workDir,
  maturity = 'manage-only',
}: ExternalAgentChatProps) {
  const [messages, setMessages] = useState<AgentCliMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastMode, setLastMode] = useState<string | null>(null)
  const addToast = useUIStore((s) => s.addToast)

  const load = useCallback(async () => {
    try {
      const res = await agentCliApi.getMessages(cliId, sessionId)
      setMessages(res.messages ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [cliId, sessionId])

  useEffect(() => {
    void load()
  }, [load])

  async function launchHost() {
    setBusy(true)
    setError(null)
    try {
      const result = await agentCliApi.launch(cliId, { sessionId, workDir })
      addToast?.({ type: 'success', message: result.message })
      setLastMode('host-terminal')
      await load()
      void useSessionStore.getState().fetchSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function send() {
    const prompt = input.trim()
    if (!prompt || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await agentCliApi.chat(cliId, {
        sessionId,
        workDir,
        prompt,
      })
      setLastMode(result.mode)
      setInput('')
      await load()
      void useSessionStore.getState().fetchSessions()
      if (result.mode !== 'exec') {
        addToast?.({
          type: 'info',
          message: result.mode === 'manage-only'
            ? '已打开宿主机终端（仅管理成熟度）'
            : '已回退到宿主机终端',
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-[var(--color-border)] px-4 py-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="info" size="sm">{cliId}</Badge>
          <Badge tone={maturity === 'beta' ? 'warning' : 'neutral'} size="sm">
            {maturity === 'beta' ? 'Beta 对话' : '仅管理 / 宿主机终端'}
          </Badge>
          {lastMode ? (
            <span className="text-xs text-[var(--color-text-tertiary)]">上次：{lastMode}</span>
          ) : null}
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void launchHost()}>
            打开宿主机 CLI
          </Button>
        </div>
        <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
          {maturity === 'beta'
            ? '优先非交互子进程执行；失败时打开宿主机终端。非 Claude 流式协议为分级适配。'
            : '当前 CLI 未接入 Web 流式协议。请在宿主机终端中使用，或在系统管理中查看安装状态。'}
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <p className="text-sm text-[var(--color-text-tertiary)]">
            尚无消息。发送提示词或打开宿主机终端开始。
          </p>
        ) : null}
        {messages.map((m) => (
          <div
            key={m.id}
            className={[
              'rounded-[var(--radius-md)] px-3 py-2 text-sm whitespace-pre-wrap',
              m.role === 'user'
                ? 'ml-8 bg-[var(--color-primary)]/10'
                : m.role === 'system'
                  ? 'border border-[var(--color-border)] text-[var(--color-text-secondary)]'
                  : 'mr-8 bg-[var(--color-surface-container)]',
            ].join(' ')}
          >
            <div className="mb-1 text-[11px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
              {m.role}
            </div>
            {m.content}
          </div>
        ))}
      </div>

      {error ? (
        <p className="px-4 text-sm text-red-500" role="alert">{error}</p>
      ) : null}

      <div className="shrink-0 border-t border-[var(--color-border)] p-3">
        <div className="flex gap-2">
          <textarea
            className="min-h-[72px] flex-1 resize-y rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
            placeholder={maturity === 'manage-only' ? '发送后将引导到宿主机终端…' : '输入提示词…'}
            value={input}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <Button type="button" disabled={busy || !input.trim()} onClick={() => void send()}>
            {busy ? <Spinner size={16} /> : '发送'}
          </Button>
        </div>
      </div>
    </div>
  )
}
