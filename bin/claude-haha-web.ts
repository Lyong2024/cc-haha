#!/usr/bin/env bun
/**
 * Pure-web product CLI: start | stop | status | reset-password
 */

import { spawn, type Subprocess } from 'bun'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const ROOT = resolve(import.meta.dir, '..')

type StartOptions = {
  host: string
  port: number
  dataDir: string
  workDir?: string
  dist?: string
  cliPath?: string
}

function usage(): never {
  console.log(`Usage:
  claude-haha-web start [--host 127.0.0.1] [--port 3456] [--data-dir PATH] [--work-dir PATH] [--dist PATH]
  claude-haha-web stop
  claude-haha-web status
  claude-haha-web reset-password

Environment:
  SERVER_HOST, SERVER_PORT, HAHA_DATA_DIR, CLAUDE_H5_DIST_DIR / WEB_APP_DIST
`)
  process.exit(1)
}

function readFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  return args[i + 1]
}

function defaultDataDir(): string {
  return process.env.HAHA_DATA_DIR?.trim() ||
    join(process.env.HOME || process.env.USERPROFILE || ROOT, '.claude', 'haha-web')
}

function runtimeDir(dataDir: string): string {
  return join(dataDir, 'runtime')
}

function pidPath(dataDir: string): string {
  return join(runtimeDir(dataDir), 'server.pid')
}

function parseStartOptions(args: string[]): StartOptions {
  const host = readFlag(args, '--host') || process.env.SERVER_HOST || '127.0.0.1'
  const port = Number.parseInt(readFlag(args, '--port') || process.env.SERVER_PORT || '3456', 10)
  const dataDir = resolve(readFlag(args, '--data-dir') || defaultDataDir())
  const workDir = readFlag(args, '--work-dir')
  const dist = readFlag(args, '--dist') ||
    process.env.WEB_APP_DIST ||
    process.env.CLAUDE_H5_DIST_DIR
  const cliPath = readFlag(args, '--cli-path') || process.env.CLAUDE_CLI_PATH
  if (!Number.isFinite(port) || port <= 0) {
    console.error('Invalid --port')
    process.exit(1)
  }
  return { host, port, dataDir, workDir: workDir ? resolve(workDir) : undefined, dist, cliPath }
}

async function cmdStart(args: string[]) {
  const options = parseStartOptions(args)
  mkdirSync(runtimeDir(options.dataDir), { recursive: true })

  // Prefer usable SPA root: --dist/env → repo-root dist/ → legacy web/dist.
  const candidates = [
    options.dist ? resolve(options.dist) : null,
    join(ROOT, 'dist'),
    join(ROOT, 'web', 'dist'),
  ].filter((value): value is string => !!value)

  let distDir = candidates[0]!
  const withIndex = candidates.find((dir) => existsSync(join(dir, 'index.html')))
  if (withIndex) {
    distDir = withIndex
    if (options.dist && resolve(options.dist) !== withIndex) {
      console.warn(
        `[warn] SPA missing at ${resolve(options.dist)}; using ${withIndex}`,
      )
    }
  } else {
    console.warn(`[warn] SPA dist not found (missing index.html). Tried: ${candidates.join(', ')}`)
    console.warn('        Build with: pnpm run web:build  (outputs to repo-root dist/)')
  }

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    HAHA_WEB_MODE: '1',
    HAHA_WEB_AUTH: '1',
    HAHA_DATA_DIR: options.dataDir,
    SERVER_HOST: options.host,
    SERVER_PORT: String(options.port),
    // Always pin to the resolved path so stale CLAUDE_H5_DIST_DIR in the
    // parent environment cannot force web/dist over root dist/.
    CLAUDE_H5_DIST_DIR: distDir,
  }
  if (options.workDir) {
    env.HAHA_DEFAULT_WORK_DIR = options.workDir
  }
  if (options.cliPath) {
    env.CLAUDE_CLI_PATH = options.cliPath
  }

  const child: Subprocess = spawn({
    cmd: ['bun', 'run', join(ROOT, 'src/server/index.ts'), '--host', options.host, '--port', String(options.port)],
    cwd: ROOT,
    env,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  })

  writeFileSync(pidPath(options.dataDir), String(child.pid), 'utf8')
  console.log(`[claude-haha-web] started pid=${child.pid} http://${options.host}:${options.port}`)
  console.log(`[claude-haha-web] data-dir=${options.dataDir}`)
  console.log(`[claude-haha-web] dist=${distDir}`)
  console.log('[claude-haha-web] Admin login is required (force web auth).')

  const code = await child.exited
  try {
    unlinkSync(pidPath(options.dataDir))
  } catch {
    // ignore
  }
  process.exit(code)
}

function cmdStop(args: string[]) {
  const dataDir = resolve(readFlag(args, '--data-dir') || defaultDataDir())
  const file = pidPath(dataDir)
  if (!existsSync(file)) {
    console.log('[claude-haha-web] not running (no pid file)')
    return
  }
  const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10)
  if (!Number.isFinite(pid)) {
    console.error('[claude-haha-web] invalid pid file')
    process.exit(1)
  }
  try {
    process.kill(pid)
    console.log(`[claude-haha-web] stopped pid=${pid}`)
  } catch (error) {
    console.error(`[claude-haha-web] failed to stop pid=${pid}`, error)
  }
  try {
    unlinkSync(file)
  } catch {
    // ignore
  }
}

async function cmdStatus(args: string[]) {
  const options = parseStartOptions(args)
  const file = pidPath(options.dataDir)
  const pid = existsSync(file) ? readFileSync(file, 'utf8').trim() : null
  console.log(`data-dir: ${options.dataDir}`)
  console.log(`pid-file: ${pid ?? '(none)'}`)
  try {
    const res = await fetch(`http://${options.host === '0.0.0.0' ? '127.0.0.1' : options.host}:${options.port}/health`)
    const body = await res.json()
    console.log(`health: ${res.status}`, body)
  } catch (error) {
    console.log('health: unreachable', error instanceof Error ? error.message : error)
  }
}

async function cmdResetPassword(args: string[]) {
  const dataDir = resolve(readFlag(args, '--data-dir') || defaultDataDir())
  process.env.HAHA_DATA_DIR = dataDir
  process.env.HAHA_WEB_MODE = '1'
  process.env.HAHA_WEB_AUTH = '1'

  const { openWebControlDatabase } = await import('../src/server/services/webControlDb.ts')
  const { WebAuthService } = await import('../src/server/services/webAuthService.ts')

  const rl = createInterface({ input, output })
  try {
    const password = await rl.question('New admin password (≥8 chars): ')
    const control = openWebControlDatabase({ dataDir })
    try {
      new WebAuthService(control).resetPassword(password)
      console.log('[claude-haha-web] admin password updated; all sessions cleared')
    } finally {
      control.close()
    }
  } finally {
    rl.close()
  }
}

const [command, ...rest] = process.argv.slice(2)
switch (command) {
  case 'start':
    await cmdStart(rest)
    break
  case 'stop':
    cmdStop(rest)
    break
  case 'status':
    await cmdStatus(rest)
    break
  case 'reset-password':
    await cmdResetPassword(rest)
    break
  default:
    usage()
}
