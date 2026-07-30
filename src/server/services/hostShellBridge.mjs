/**
 * Node.js host-shell PTY bridge.
 * Bun cannot reliably drive node-pty on Windows; each shell session runs this
 * script under `node` and speaks newline-delimited JSON on stdin/stdout.
 *
 * Client (Bun service) -> stdin:
 *   {"type":"start","cols":80,"rows":24,"cwd":"...","shell":"...","args":[]}
 *   {"type":"input","data":"..."}
 *   {"type":"resize","cols":100,"rows":30}
 *   {"type":"kill"}
 *
 * Bridge -> stdout:
 *   {"type":"ready","shell":"...","cwd":"...","pid":123}
 *   {"type":"output","data":"..."}
 *   {"type":"exit","code":0,"signal":null}
 *   {"type":"error","message":"..."}
 */

import pty from 'node-pty'
import { homedir } from 'node:os'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import readline from 'node:readline'

let term = null
let started = false

function send(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n')
  } catch {
    // ignore broken pipe
  }
}

function resolveCwd(input) {
  const fallback = process.env.HAHA_DEFAULT_WORK_DIR || process.cwd() || homedir()
  const candidate = resolve((input && String(input).trim()) || fallback)
  try {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
  } catch {
    // fall through
  }
  return fallback
}

function defaultShell() {
  if (process.platform === 'win32') {
    // Prefer PowerShell 7, then Windows PowerShell, then cmd.
    // which is not always available; try known names and let spawn fail over.
    return { shell: 'powershell.exe', args: ['-NoLogo'] }
  }
  const shell = process.env.SHELL || '/bin/bash'
  return { shell, args: ['-l'] }
}

function start(opts) {
  if (started) {
    send({ type: 'error', message: 'already started' })
    return
  }
  started = true

  const defaults = defaultShell()
  const explicitShell = opts.shell && String(opts.shell).trim()
  const cwd = resolveCwd(opts.cwd)
  const cols = Math.max(20, Number(opts.cols) || 80)
  const rows = Math.max(5, Number(opts.rows) || 24)

  // On Windows try pwsh -> powershell -> cmd for a usable default shell.
  const candidates =
    process.platform === 'win32' && !explicitShell
      ? [
          { shell: 'pwsh.exe', args: ['-NoLogo'] },
          { shell: 'powershell.exe', args: ['-NoLogo'] },
          { shell: process.env.ComSpec || 'cmd.exe', args: [] },
        ]
      : [
          {
            shell: explicitShell || defaults.shell,
            args: Array.isArray(opts.args)
              ? opts.args.map(String)
              : defaults.args,
          },
        ]

  let lastErr = null
  let chosen = null
  for (const candidate of candidates) {
    try {
      term = pty.spawn(candidate.shell, candidate.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        },
      })
      chosen = candidate
      break
    } catch (err) {
      lastErr = err
      term = null
    }
  }

  if (!term || !chosen) {
    send({
      type: 'error',
      message: lastErr instanceof Error ? lastErr.message : String(lastErr || 'failed to spawn shell'),
    })
    process.exit(1)
    return
  }

  send({
    type: 'ready',
    shell: chosen.shell,
    cwd,
    pid: term.pid,
  })

  term.onData((data) => {
    send({ type: 'output', data })
  })

  term.onExit(({ exitCode, signal }) => {
    send({
      type: 'exit',
      code: typeof exitCode === 'number' ? exitCode : 0,
      signal: signal ?? null,
    })
    process.exit(0)
  })
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    send({ type: 'error', message: 'invalid json' })
    return
  }

  switch (msg.type) {
    case 'start':
      start(msg)
      break
    case 'input':
      if (term && typeof msg.data === 'string') term.write(msg.data)
      break
    case 'resize':
      if (term) {
        const cols = Math.max(20, Number(msg.cols) || 80)
        const rows = Math.max(5, Number(msg.rows) || 24)
        try {
          term.resize(cols, rows)
        } catch {
          // ignore resize races
        }
      }
      break
    case 'kill':
      try {
        term?.kill()
      } catch {
        // ignore
      }
      process.exit(0)
      break
    default:
      send({ type: 'error', message: `unknown type: ${msg.type}` })
  }
})

rl.on('close', () => {
  try {
    term?.kill()
  } catch {
    // ignore
  }
  process.exit(0)
})
