/**
 * User-driven import of providers discovered from Claude Code / cc-haha / haha.
 * Does not auto-merge; name conflicts get a source label suffix.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  providersApi,
  type ExternalProviderCandidate,
  type ExternalSourceSummary,
} from '../../api/providers'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { useUIStore } from '../../stores/uiStore'

type Props = {
  onImported?: () => void
}

export function ExternalProviderImportPanel({ onImported }: Props) {
  const addToast = useUIStore((s) => s.addToast)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [activeDataDir, setActiveDataDir] = useState<string | null>(null)
  const [sources, setSources] = useState<ExternalSourceSummary[]>([])
  const [candidates, setCandidates] = useState<ExternalProviderCandidate[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [src, cand] = await Promise.all([
        providersApi.listExternalSources(),
        providersApi.listExternalCandidates(),
      ])
      setActiveDataDir(src.activeDataDir)
      setSources(src.sources)
      setCandidates(cand.candidates)
      // Pre-select not-yet-imported
      setSelected(
        new Set(cand.candidates.filter((c) => !c.alreadyImported).map((c) => c.key)),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const importable = useMemo(
    () => candidates.filter((c) => !c.alreadyImported),
    [candidates],
  )

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleImport = async () => {
    const keys = [...selected].filter((k) => importable.some((c) => c.key === k))
    if (keys.length === 0) {
      addToast({ type: 'info', message: '请先勾选要导入的服务商' })
      return
    }
    setImporting(true)
    try {
      const result = await providersApi.importExternal(keys)
      const n = result.imported.length
      const skip = result.skipped.length
      addToast({
        type: n > 0 ? 'success' : 'info',
        message:
          n > 0
            ? `已导入 ${n} 个服务商${skip ? `，跳过 ${skip} 个` : ''}`
            : skip
              ? `未导入（跳过 ${skip} 个）`
              : '没有可导入项',
      })
      await load()
      onImported?.()
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setImporting(false)
    }
  }

  const totalAvailable = sources.reduce((sum, s) => sum + s.candidateCount, 0)

  return (
    <div
      className="mb-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low,transparent)]"
      data-testid="external-provider-import-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--color-text-primary)]">
            外部设置来源
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--color-text-tertiary)]">
            可发现 Claude Code / cc-haha 中的服务商；需手动勾选导入，不会自动合并。
            重名时会附加来源后缀（如「名称 (cc-haha)」）。
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setOpen((v) => !v)}
          data-testid="external-provider-import-toggle"
        >
          {open ? '收起' : totalAvailable > 0 ? `发现 ${totalAvailable} 项` : '扫描外部来源'}
        </Button>
      </div>

      {open ? (
        <div className="border-t border-[var(--color-border-separator)] px-3 py-3">
          {activeDataDir ? (
            <div className="mb-2 text-[11px] text-[var(--color-text-tertiary)]">
              当前项目数据目录：
              <code className="ml-1 break-all text-[var(--color-text-secondary)]">
                {activeDataDir}
              </code>
            </div>
          ) : null}

          {loading ? (
            <div className="py-4 text-center text-xs text-[var(--color-text-tertiary)]">
              扫描中…
            </div>
          ) : error ? (
            <div className="py-2 text-xs text-[var(--color-error)]">{error}</div>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap gap-2">
                {sources.map((s) => (
                  <Badge
                    key={s.id}
                    tone={s.candidateCount > 0 ? 'info' : 'neutral'}
                    size="sm"
                    title={s.path}
                  >
                    {s.label}
                    {s.isActiveDataDir ? ' · 当前' : ''}
                    {s.available ? ` · ${s.candidateCount}` : ' · 不可用'}
                  </Badge>
                ))}
              </div>

              {candidates.length === 0 ? (
                <div className="py-3 text-center text-xs text-[var(--color-text-tertiary)]">
                  未发现可导入的外部服务商
                </div>
              ) : (
                <ul className="max-h-56 space-y-1 overflow-y-auto">
                  {candidates.map((c) => (
                    <li
                      key={c.key}
                      className="flex items-start gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 hover:bg-[var(--color-surface-hover)]"
                    >
                      <input
                        type="checkbox"
                        className="mt-1"
                        disabled={c.alreadyImported}
                        checked={c.alreadyImported ? false : selected.has(c.key)}
                        onChange={() => toggle(c.key)}
                        aria-label={`选择 ${c.proposedName}`}
                        data-testid={`external-candidate-${c.key}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                          <span className="font-medium text-[var(--color-text-primary)]">
                            {c.proposedName}
                          </span>
                          <Badge tone="neutral" size="sm">
                            {c.sourceLabel}
                          </Badge>
                          {c.nameConflict ? (
                            <Badge tone="warning" size="sm">
                              重名已加来源
                            </Badge>
                          ) : null}
                          {c.alreadyImported ? (
                            <Badge tone="success" size="sm">
                              已导入
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[11px] text-[var(--color-text-tertiary)]">
                          {c.baseUrl} · {c.maskedKey}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
                  刷新
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  loading={importing}
                  disabled={importing || selected.size === 0}
                  onClick={() => void handleImport()}
                  data-testid="external-provider-import-submit"
                >
                  导入所选
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
