/**
 * Open the host machine's default terminal app (not an in-browser PTY).
 * Runs with the same OS user/permissions as the Bun server process.
 */

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir, platform as osPlatform, userInfo } from 'node:os'
import { resolve } from 'node:path'
import { ApiError } from '../middleware/errorHandler.js'

export type OpenHostTerminalResult = {
  ok: true
  platform: NodeJS.Platform
  cwd: string
  launcher: string
  user: string
  message: string
}

function resolveCwd(input?: string | null): string {
  const fallback = process.env.HAHA_DEFAULT_WORK_DIR?.trim()
    || process.cwd()
    || homedir()
  const candidate = (input?.trim() || fallback).trim()
  const absolute = resolve(candidate)
  if (!existsSync(absolute)) {
    throw ApiError.badRequest(`Directory does not exist: ${absolute}`)
  }
  let isDir = false
  try {
    isDir = statSync(absolute).isDirectory()
  } catch {
    throw ApiError.badRequest(`Cannot access path: ${absolute}`)
  }
  if (!isDir) {
    throw ApiError.badRequest(`Path is not a directory: ${absolute}`)
  }
  return absolute
}

function commandExists(command: string): boolean {
  try {
    if (process.platform === 'win32') {
      execFileSync('where.exe', [command], { stdio: 'ignore', windowsHide: true })
    } else {
      execFileSync('which', [command], { stdio: 'ignore' })
    }
    return true
  } catch {
    return false
  }
}

function launchDetached(command: string, args: string[], cwd: string): void {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: process.env,
  })
  child.on('error', () => {
    // Best-effort GUI launch; errors surface via spawn failure below.
  })
  child.unref()
}

function tryLaunch(command: string, args: string[], cwd: string): boolean {
  if (!commandExists(command) && process.platform === 'win32') {
    // `where` may miss some App Paths; still attempt spawn for wt/pwsh.
  } else if (!commandExists(command) && process.platform !== 'win32') {
    return false
  }
  try {
    launchDetached(command, args, cwd)
    return true
  } catch {
    return false
  }
}

function powershellLiteral(path: string): string {
  return `'${path.replace(/'/g, "''")}'`
}

function openWindows(cwd: string): string {
  // Windows Terminal (preferred)
  if (tryLaunch('wt.exe', ['-d', cwd], cwd)) {
    return 'Windows Terminal (wt.exe)'
  }
  // PowerShell 7+
  if (tryLaunch('pwsh.exe', ['-NoExit', '-NoLogo', '-Command', `Set-Location -LiteralPath ${powershellLiteral(cwd)}`], cwd)) {
    return 'PowerShell (pwsh.exe)'
  }
  // Windows PowerShell
  if (tryLaunch('powershell.exe', ['-NoExit', '-NoLogo', '-Command', `Set-Location -LiteralPath ${powershellLiteral(cwd)}`], cwd)) {
    return 'Windows PowerShell'
  }
  // cmd via start so a new window appears under the interactive session
  if (tryLaunch('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', `cd /d ${cwd}`], cwd)) {
    return 'Command Prompt (cmd.exe)'
  }
  throw ApiError.internal('Failed to launch a host terminal on Windows')
}

function openDarwin(cwd: string): string {
  if (tryLaunch('open', ['-a', 'Terminal', cwd], cwd)) {
    return 'Terminal.app'
  }
  if (tryLaunch('open', ['-a', 'iTerm', cwd], cwd)) {
    return 'iTerm'
  }
  throw ApiError.internal('Failed to launch Terminal.app / iTerm')
}

function openLinux(cwd: string): string {
  const candidates: Array<{ cmd: string; args: string[]; label: string }> = [
    { cmd: 'x-terminal-emulator', args: ['--working-directory', cwd], label: 'x-terminal-emulator' },
    { cmd: 'gnome-terminal', args: [`--working-directory=${cwd}`], label: 'gnome-terminal' },
    { cmd: 'konsole', args: ['--workdir', cwd], label: 'konsole' },
    { cmd: 'xfce4-terminal', args: [`--working-directory=${cwd}`], label: 'xfce4-terminal' },
    { cmd: 'kitty', args: ['--directory', cwd], label: 'kitty' },
    { cmd: 'alacritty', args: ['--working-directory', cwd], label: 'alacritty' },
    { cmd: 'xterm', args: ['-e', `cd ${JSON.stringify(cwd)} && exec $SHELL`], label: 'xterm' },
  ]
  for (const item of candidates) {
    if (tryLaunch(item.cmd, item.args, cwd)) {
      return item.label
    }
  }
  throw ApiError.internal('No known Linux terminal emulator could be launched')
}

export async function openHostTerminal(input?: {
  cwd?: string | null
}): Promise<OpenHostTerminalResult> {
  const cwd = resolveCwd(input?.cwd)
  const plat = osPlatform()
  let launcher: string
  if (plat === 'win32') {
    launcher = openWindows(cwd)
  } else if (plat === 'darwin') {
    launcher = openDarwin(cwd)
  } else {
    launcher = openLinux(cwd)
  }

  let user = 'unknown'
  try {
    user = userInfo().username
  } catch {
    // ignore
  }

  return {
    ok: true,
    platform: plat,
    cwd,
    launcher,
    user,
    message: `Opened ${launcher} as user "${user}" in ${cwd}`,
  }
}
