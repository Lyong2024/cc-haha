/**
 * WebSocket handler for pure-web in-page host shell.
 * Path: /ws/host-shell
 */

import type { ServerWebSocket } from 'bun'
import {
  attachHostShellHandlers,
  createHostShellSession,
  killHostShell,
  resizeHostShell,
  writeHostShell,
} from '../services/hostShellService.js'

export type HostShellWsData = {
  channel: 'host-shell'
  connectedAt: number
  shellSessionId?: string | null
  sessionId?: string
  serverPort: number
  serverHost: string
  sdkToken?: string | null
  clientKind?: string
}

type ClientMsg =
  | { type: 'start'; cols?: number; rows?: number; cwd?: string | null }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'kill' }
  | { type: 'ping' }

function send(ws: ServerWebSocket<HostShellWsData>, msg: Record<string, unknown>) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  } catch {
    // ignore
  }
}

export const handleHostShellWebSocket = {
  open(ws: ServerWebSocket<HostShellWsData>) {
    ws.data.shellSessionId = null
    send(ws, { type: 'hello', message: 'host-shell ready' })
  },

  message(ws: ServerWebSocket<HostShellWsData>, raw: string | Buffer) {
    let msg: ClientMsg
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) as ClientMsg
    } catch {
      send(ws, { type: 'error', message: 'invalid json' })
      return
    }

    switch (msg.type) {
      case 'ping':
        send(ws, { type: 'pong' })
        return

      case 'start': {
        // Replace existing session if any
        if (ws.data.shellSessionId) {
          killHostShell(ws.data.shellSessionId)
          ws.data.shellSessionId = null
        }
        try {
          const session = createHostShellSession({
            cols: msg.cols,
            rows: msg.rows,
            cwd: msg.cwd,
            handlers: {
              onReady: (info) => {
                send(ws, {
                  type: 'ready',
                  sessionId: session.id,
                  shell: info.shell,
                  cwd: info.cwd,
                  pid: info.pid,
                })
              },
              onOutput: (data) => {
                send(ws, { type: 'output', data })
              },
              onExit: (code, signal) => {
                send(ws, { type: 'exit', code, signal })
                if (ws.data.shellSessionId === session.id) {
                  ws.data.shellSessionId = null
                }
              },
              onError: (message) => {
                send(ws, { type: 'error', message })
              },
            },
          })
          ws.data.shellSessionId = session.id
          // Re-attach in case create returned before handlers were set (already set above)
          attachHostShellHandlers(session.id, {
            onReady: (info) => {
              send(ws, {
                type: 'ready',
                sessionId: session.id,
                shell: info.shell,
                cwd: info.cwd,
                pid: info.pid,
              })
            },
            onOutput: (data) => send(ws, { type: 'output', data }),
            onExit: (code, signal) => {
              send(ws, { type: 'exit', code, signal })
              if (ws.data.shellSessionId === session.id) ws.data.shellSessionId = null
            },
            onError: (message) => send(ws, { type: 'error', message }),
          })
        } catch (err) {
          send(ws, {
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
        }
        return
      }

      case 'input': {
        const id = ws.data.shellSessionId
        if (!id) {
          send(ws, { type: 'error', message: 'shell not started' })
          return
        }
        if (typeof msg.data === 'string') writeHostShell(id, msg.data)
        return
      }

      case 'resize': {
        const id = ws.data.shellSessionId
        if (!id) return
        resizeHostShell(id, msg.cols, msg.rows)
        return
      }

      case 'kill': {
        const id = ws.data.shellSessionId
        if (id) {
          killHostShell(id)
          ws.data.shellSessionId = null
        }
        return
      }

      default:
        send(ws, { type: 'error', message: 'unknown message type' })
    }
  },

  close(ws: ServerWebSocket<HostShellWsData>) {
    const id = ws.data.shellSessionId
    if (id) {
      killHostShell(id)
      ws.data.shellSessionId = null
    }
  },
}
