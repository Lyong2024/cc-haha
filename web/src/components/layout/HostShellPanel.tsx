/**
 * In-page host shell panel (pure-web).
 * xterm.js front-end + /ws/host-shell PTY bridge on the Bun server.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { X, RotateCcw, SquareTerminal } from 'lucide-react'
import { HostShellConnection } from '../../api/hostShell'
import { readTerminalPalette } from '../../lib/terminalTheme'
import { useHostShellStore, HOST_SHELL_MIN_HEIGHT, HOST_SHELL_MAX_HEIGHT } from '../../stores/hostShellStore'
import { useUIStore } from '../../stores/uiStore'
import { IconButton } from '@/components/ui/IconButton'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'

type ShellStatus = 'idle' | 'connecting' | 'running' | 'exited' | 'error'

export function HostShellPanel() {
  const open = useHostShellStore((s) => s.open)
  const height = useHostShellStore((s) => s.height)
  const cwd = useHostShellStore((s) => s.cwd)
  const setHeight = useHostShellStore((s) => s.setHeight)
  const closePanel = useHostShellStore((s) => s.closePanel)
  const theme = useUIStore((s) => s.theme)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const connRef = useRef<HostShellConnection | null>(null)
  const termRef = useRef<import('@xterm/xterm').Terminal | null>(null)
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null)
  const [status, setStatus] = useState<ShellStatus>('idle')
  const [shellInfo, setShellInfo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragStart, setDragStart] = useState<{ y: number; h: number } | null>(null)
  const startTokenRef = useRef(0)

  const disposeTerminal = useCallback(() => {
    termRef.current?.dispose()
    termRef.current = null
    fitRef.current = null
    if (hostRef.current) hostRef.current.innerHTML = ''
  }, [])

  const stopConnection = useCallback(() => {
    connRef.current?.close()
    connRef.current = null
  }, [])

  const startShell = useCallback(async () => {
    const host = hostRef.current
    if (!host) return

    const token = ++startTokenRef.current
    setStatus('connecting')
    setError(null)
    setShellInfo(null)
    stopConnection()
    disposeTerminal()

    let TerminalModule: typeof import('@xterm/xterm')
    let FitAddonModule: typeof import('@xterm/addon-fit')
    try {
      ;[TerminalModule, FitAddonModule] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ])
    } catch (err) {
      if (token !== startTokenRef.current) return
      setStatus('error')
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    if (token !== startTokenRef.current) return

    const terminal = new TerminalModule.Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: "var(--font-mono), 'SFMono-Regular', Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: readTerminalPalette(),
    })
    const fit = new FitAddonModule.FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    fit.fit()
    termRef.current = terminal
    fitRef.current = fit

    const conn = new HostShellConnection()
    connRef.current = conn

    const unsubMsg = conn.onMessage((msg) => {
      if (token !== startTokenRef.current) return
      switch (msg.type) {
        case 'ready':
          setStatus('running')
          setShellInfo(`${msg.shell} · ${msg.cwd}`)
          break
        case 'output':
          terminal.write(msg.data)
          break
        case 'exit':
          setStatus('exited')
          terminal.writeln(`\r\n[process exited: ${msg.code}${msg.signal ? `, ${msg.signal}` : ''}]`)
          break
        case 'error':
          setStatus('error')
          setError(msg.message)
          terminal.writeln(`\r\n[error] ${msg.message}`)
          break
        default:
          break
      }
    })

    conn.onOpen(() => {
      if (token !== startTokenRef.current) return
      fit.fit()
      conn.send({
        type: 'start',
        cols: terminal.cols,
        rows: terminal.rows,
        cwd: cwd ?? null,
      })
    })

    conn.onClose(() => {
      if (token !== startTokenRef.current) return
      setStatus((prev) => (prev === 'running' || prev === 'connecting' ? 'exited' : prev))
    })

    terminal.onData((data) => {
      conn.send({ type: 'input', data })
    })

    conn.connect()

    const ro = new ResizeObserver(() => {
      if (!fitRef.current || !termRef.current || !connRef.current) return
      try {
        fitRef.current.fit()
        connRef.current.send({
          type: 'resize',
          cols: termRef.current.cols,
          rows: termRef.current.rows,
        })
      } catch {
        // ignore
      }
    })
    ro.observe(host)

    return () => {
      ro.disconnect()
      unsubMsg()
    }
  }, [cwd, disposeTerminal, stopConnection])

  useEffect(() => {
    if (!open) {
      startTokenRef.current += 1
      stopConnection()
      disposeTerminal()
      setStatus('idle')
      setError(null)
      setShellInfo(null)
      return
    }
    let cleanup: (() => void) | undefined
    let cancelled = false
    void startShell().then((fn) => {
      if (cancelled) {
        fn?.()
        return
      }
      cleanup = fn
    })
    return () => {
      cancelled = true
      startTokenRef.current += 1
      cleanup?.()
      stopConnection()
      disposeTerminal()
    }
  }, [open, cwd, startShell, stopConnection, disposeTerminal])

  useEffect(() => {
    // re-apply theme colors
    if (termRef.current) {
      termRef.current.options.theme = readTerminalPalette()
    }
  }, [theme])

  useEffect(() => {
    if (!dragStart) return
    const onMove = (e: PointerEvent) => {
      const delta = dragStart.y - e.clientY
      setHeight(dragStart.h + delta)
    }
    const onUp = () => setDragStart(null)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragStart, setHeight])

  if (!open) return null

  return (
    <div
      data-testid="host-shell-panel"
      className="flex shrink-0 flex-col border-t border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]"
      style={{ height }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-valuemin={HOST_SHELL_MIN_HEIGHT}
        aria-valuemax={HOST_SHELL_MAX_HEIGHT}
        aria-valuenow={height}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          setDragStart({ y: e.clientY, h: height })
        }}
        className="group flex h-2.5 shrink-0 cursor-row-resize items-center bg-[var(--color-surface)]"
      >
        <div className="mx-3 h-px flex-1 rounded-full bg-[var(--color-border)] group-hover:bg-[var(--color-border-focus)]" />
      </div>

      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border-separator)] px-3">
        <SquareTerminal size={14} className="text-[var(--color-text-secondary)]" />
        <span className="text-xs font-medium text-[var(--color-text-primary)]">宿主机终端</span>
        <Badge
          tone={
            status === 'running'
              ? 'success'
              : status === 'error'
                ? 'danger'
                : status === 'connecting'
                  ? 'info'
                  : 'neutral'
          }
          size="sm"
        >
          {status}
        </Badge>
        {shellInfo ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-text-tertiary)]">
            {shellInfo}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => void startShell()}
          icon={<RotateCcw size={13} />}
        >
          重启
        </Button>
        <IconButton
          icon={<X size={15} />}
          label="关闭终端"
          size="sm"
          onClick={() => closePanel()}
        />
      </div>

      {error ? (
        <div className="px-3 py-1 text-[11px] text-red-500" role="alert">
          {error}
        </div>
      ) : null}

      <div
        ref={hostRef}
        className="min-h-0 flex-1 overflow-hidden px-1 pb-1"
        data-testid="host-shell-xterm"
      />
    </div>
  )
}
