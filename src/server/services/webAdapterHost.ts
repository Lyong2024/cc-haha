/**
 * Spawn IM adapter processes without Electron (pure-web host).
 */

import { spawn, type Subprocess } from 'bun'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getWebPresenceService } from './webPresenceService.js'
import { adapterService } from './adapterService.js'

export type AdapterPlatform = 'telegram' | 'feishu' | 'wechat' | 'dingtalk' | 'whatsapp'

const running = new Map<AdapterPlatform, Subprocess>()

function repoRoot(): string {
  return resolve(process.env.CLAUDE_APP_ROOT || process.cwd())
}

function adapterEntry(platform: AdapterPlatform): string {
  return join(repoRoot(), 'adapters', platform, 'index.ts')
}

export function listRunningAdapters(): AdapterPlatform[] {
  return [...running.entries()]
    .filter(([, child]) => child.exitCode === null)
    .map(([platform]) => platform)
}

export async function startAdapter(platform: AdapterPlatform): Promise<{ ok: true; pid: number | undefined }> {
  const existing = running.get(platform)
  if (existing && existing.exitCode === null) {
    return { ok: true, pid: existing.pid }
  }

  const entry = adapterEntry(platform)
  if (!existsSync(entry)) {
    throw Object.assign(new Error(`Adapter entry not found: ${entry}`), { code: 'NOT_FOUND' })
  }

  const child = spawn({
    cmd: ['bun', 'run', entry],
    cwd: join(repoRoot(), 'adapters'),
    env: {
      ...process.env as Record<string, string>,
      CC_HAHA_SKIP_DOTENV: process.env.CC_HAHA_SKIP_DOTENV || '0',
    },
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'ignore',
  })

  running.set(platform, child)
  void child.exited.then(() => {
    const current = running.get(platform)
    if (current === child) running.delete(platform)
  })

  await refreshImPresenceFromConfig()
  return { ok: true, pid: child.pid }
}

export async function stopAdapter(platform: AdapterPlatform): Promise<{ ok: true }> {
  const child = running.get(platform)
  if (!child || child.exitCode !== null) {
    running.delete(platform)
    return { ok: true }
  }
  try {
    child.kill()
  } catch {
    // ignore
  }
  running.delete(platform)
  return { ok: true }
}

export async function refreshImPresenceFromConfig(): Promise<void> {
  const presence = getWebPresenceService()
  let config: Awaited<ReturnType<typeof adapterService.getConfig>>
  try {
    config = await adapterService.getConfig()
  } catch {
    return
  }

  const platforms: Array<{
    platform: AdapterPlatform
    paired?: Array<{ userId: string | number; displayName?: string }>
  }> = [
    { platform: 'telegram', paired: config.telegram?.pairedUsers },
    { platform: 'feishu', paired: config.feishu?.pairedUsers },
    { platform: 'wechat', paired: config.wechat?.pairedUsers },
    { platform: 'dingtalk', paired: config.dingtalk?.pairedUsers },
    { platform: 'whatsapp', paired: config.whatsapp?.pairedUsers },
  ]

  for (const item of platforms) {
    for (const user of item.paired ?? []) {
      presence.touchImActivity({
        platform: item.platform,
        identity: String(user.displayName || user.userId),
        meta: { userId: user.userId, running: listRunningAdapters().includes(item.platform) },
      })
    }
  }
}
