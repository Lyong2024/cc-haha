import { api } from './client'

export type OpenHostTerminalResult = {
  ok: true
  platform: string
  cwd: string
  launcher: string
  user: string
  message: string
}

/** Ask the web server to open the host machine default terminal (OS user = server process user). */
export function openHostTerminal(cwd?: string | null) {
  return api.post<OpenHostTerminalResult>('/api/system/open-terminal', {
    cwd: cwd ?? null,
  })
}
