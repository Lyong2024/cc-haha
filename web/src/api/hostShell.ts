import { getAuthToken, getBaseUrl } from './client'

export type HostShellServerMessage =
  | { type: 'hello'; message?: string }
  | { type: 'ready'; sessionId: string; shell: string; cwd: string; pid: number | null }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number; signal: string | null }
  | { type: 'error'; message: string }
  | { type: 'pong' }

export type HostShellClientMessage =
  | { type: 'start'; cols: number; rows: number; cwd?: string | null }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'kill' }
  | { type: 'ping' }

function buildHostShellWsUrl(): string {
  const base = getBaseUrl().replace(/\/$/, '')
  const wsBase = base.replace(/^http/, 'ws')
  const token = getAuthToken()
  const url = new URL(`${wsBase}/ws/host-shell`)
  if (token) url.searchParams.set('token', token)
  return url.toString()
}

export class HostShellConnection {
  private ws: WebSocket | null = null
  private intentionalClose = false
  private handlers = new Set<(msg: HostShellServerMessage) => void>()
  private openHandlers = new Set<() => void>()
  private closeHandlers = new Set<(ev: CloseEvent) => void>()

  connect() {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return
    }
    this.intentionalClose = false
    const ws = new WebSocket(buildHostShellWsUrl())
    this.ws = ws
    ws.onopen = () => {
      this.openHandlers.forEach((h) => h())
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as HostShellServerMessage
        this.handlers.forEach((h) => h(msg))
      } catch {
        // ignore
      }
    }
    ws.onclose = (ev) => {
      this.closeHandlers.forEach((h) => h(ev))
      if (!this.intentionalClose) {
        // leave reconnect to UI
      }
    }
  }

  onMessage(handler: (msg: HostShellServerMessage) => void) {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  onOpen(handler: () => void) {
    this.openHandlers.add(handler)
    return () => this.openHandlers.delete(handler)
  }

  onClose(handler: (ev: CloseEvent) => void) {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  send(msg: HostShellClientMessage) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }

  close() {
    this.intentionalClose = true
    try {
      this.send({ type: 'kill' })
    } catch {
      // ignore
    }
    this.ws?.close()
    this.ws = null
  }

  get readyState() {
    return this.ws?.readyState ?? WebSocket.CLOSED
  }
}
