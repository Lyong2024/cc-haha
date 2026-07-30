/**
 * Host shell sessions for pure-web in-page terminal.
 * Spawns a Node.js node-pty bridge (Bun cannot drive node-pty on Windows).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

export type HostShellSession = {
  id: string
  shell: string
  cwd: string
  pid: number | null
  status: 'starting' | 'running' | 'exited' | 'error'
  error: string | null
  createdAt: number
}

type BridgeHandlers = {
  onReady?: (info: { shell: string; cwd: string; pid: number | null }) => void
  onOutput?: (data: string) => void
  onExit?: (code: number, signal: string | null) => void
  onError?: (message: string) => void
}

type InternalSession = HostShellSession & {
  child: ChildProcessWithoutNullStreams
  handlers: BridgeHandlers
}

const sessions = new Map<string, InternalSession>()

function bridgeScriptPath(): string {
  // Compiled / source: prefer sibling .mjs next to this file.
  const here = dirname(fileURLToPath(import.meta.url))
  const candidate = join(here, 'hostShellBridge.mjs')
  if (existsSync(candidate)) return candidate
  // Repo layout fallback
  return join(process.cwd(), 'src', 'server', 'services', 'hostShellBridge.mjs')
}

function resolveNodeBinary(): string {
  return process.env.HAHA_NODE_PATH?.trim() || 'node'
}

function resolveCwd(input?: string | null): string {
  const fallback = process.env.HAHA_DEFAULT_WORK_DIR?.trim() || process.cwd() || homedir()
  const candidate = resolve((input?.trim() || fallback).trim())
  if (existsSync(candidate)) return candidate
  return fallback
}

function sendToBridge(session: InternalSession, msg: Record<string, unknown>): void {
  if (!session.child.stdin.writable) return
  session.child.stdin.write(JSON.stringify(msg) + '\n')
}

export function createHostShellSession(options: {
  cols?: number
  rows?: number
  cwd?: string | null
  handlers?: BridgeHandlers
}): HostShellSession {
  const id = randomUUID()
  const cwd = resolveCwd(options.cwd)
  const bridge = bridgeScriptPath()
  if (!existsSync(bridge)) {
    throw new Error(`Host shell bridge not found: ${bridge}`)
  }

  const child = spawn(resolveNodeBinary(), [bridge], {
    cwd,
    env: {
      ...process.env,
      // Ensure node can resolve root node_modules/node-pty
      NODE_PATH: [
        join(process.cwd(), 'node_modules'),
        process.env.NODE_PATH || '',
      ].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const session: InternalSession = {
    id,
    shell: '',
    cwd,
    pid: child.pid ?? null,
    status: 'starting',
    error: null,
    createdAt: Date.now(),
    child,
    handlers: options.handlers ?? {},
  }
  sessions.set(id, session)

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    switch (msg.type) {
      case 'ready':
        session.status = 'running'
        session.shell = String(msg.shell ?? '')
        session.cwd = String(msg.cwd ?? cwd)
        session.pid = typeof msg.pid === 'number' ? msg.pid : session.pid
        session.handlers.onReady?.({
          shell: session.shell,
          cwd: session.cwd,
          pid: session.pid,
        })
        break
      case 'output':
        if (typeof msg.data === 'string') session.handlers.onOutput?.(msg.data)
        break
      case 'exit':
        session.status = 'exited'
        session.handlers.onExit?.(
          typeof msg.code === 'number' ? msg.code : 0,
          typeof msg.signal === 'string' ? msg.signal : null,
        )
        sessions.delete(id)
        break
      case 'error':
        session.status = 'error'
        session.error = String(msg.message ?? 'bridge error')
        session.handlers.onError?.(session.error)
        break
      default:
        break
    }
  })

  child.stderr.on('data', (buf: Buffer) => {
    const text = buf.toString('utf8').trim()
    if (text) {
      session.handlers.onError?.(text)
    }
  })

  child.on('error', (err) => {
    session.status = 'error'
    session.error = err.message
    session.handlers.onError?.(err.message)
    sessions.delete(id)
  })

  child.on('exit', (code) => {
    if (sessions.has(id)) {
      session.status = 'exited'
      session.handlers.onExit?.(code ?? 0, null)
      sessions.delete(id)
    }
  })

  sendToBridge(session, {
    type: 'start',
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    cwd,
  })

  return {
    id: session.id,
    shell: session.shell,
    cwd: session.cwd,
    pid: session.pid,
    status: session.status,
    error: session.error,
    createdAt: session.createdAt,
  }
}

export function writeHostShell(sessionId: string, data: string): boolean {
  const session = sessions.get(sessionId)
  if (!session || session.status !== 'running') return false
  sendToBridge(session, { type: 'input', data })
  return true
}

export function resizeHostShell(sessionId: string, cols: number, rows: number): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  sendToBridge(session, { type: 'resize', cols, rows })
  return true
}

export function killHostShell(sessionId: string): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  try {
    sendToBridge(session, { type: 'kill' })
  } catch {
    // ignore
  }
  try {
    session.child.kill()
  } catch {
    // ignore
  }
  sessions.delete(sessionId)
  return true
}

export function getHostShellSession(sessionId: string): HostShellSession | null {
  const s = sessions.get(sessionId)
  if (!s) return null
  return {
    id: s.id,
    shell: s.shell,
    cwd: s.cwd,
    pid: s.pid,
    status: s.status,
    error: s.error,
    createdAt: s.createdAt,
  }
}

export function attachHostShellHandlers(
  sessionId: string,
  handlers: BridgeHandlers,
): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  session.handlers = { ...session.handlers, ...handlers }
  return true
}

export function listHostShellSessions(): HostShellSession[] {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    shell: s.shell,
    cwd: s.cwd,
    pid: s.pid,
    status: s.status,
    error: s.error,
    createdAt: s.createdAt,
  }))
}
