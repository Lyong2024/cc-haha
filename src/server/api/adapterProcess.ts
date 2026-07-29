/**
 * Pure-web IM adapter process control (no platform SDKs).
 *
 * Kept separate from adapters.ts so status/start/stop work even when optional
 * IM protocol packages (e.g. baileys) are not installed in the web runtime.
 */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import {
  listRunningAdapters,
  startAdapter,
  stopAdapter,
  refreshImPresenceFromConfig,
  type AdapterPlatform,
} from '../services/webAdapterHost.js'

const PLATFORMS = new Set<string>([
  'telegram',
  'feishu',
  'wechat',
  'dingtalk',
  'whatsapp',
])

export async function handleAdapterProcessApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    // segments: ['api', 'adapters', 'process', ...]
    const tail = segments.slice(3)

    if (req.method === 'GET' && (tail.length === 0 || tail[0] === 'status')) {
      await refreshImPresenceFromConfig()
      return Response.json({ running: listRunningAdapters() })
    }

    if (req.method === 'POST' && tail[0] === 'start') {
      const body = await req.json().catch(() => ({})) as { platform?: string }
      const platform = body.platform
      if (!platform || !PLATFORMS.has(platform)) {
        throw ApiError.badRequest('platform must be telegram|feishu|wechat|dingtalk|whatsapp')
      }
      const result = await startAdapter(platform as AdapterPlatform)
      return Response.json(result)
    }

    if (req.method === 'POST' && tail[0] === 'stop') {
      const body = await req.json().catch(() => ({})) as { platform?: string }
      const platform = body.platform
      if (!platform || !PLATFORMS.has(platform)) {
        throw ApiError.badRequest('platform must be telegram|feishu|wechat|dingtalk|whatsapp')
      }
      const result = await stopAdapter(platform as AdapterPlatform)
      return Response.json(result)
    }

    throw ApiError.notFound(`Unknown adapters process endpoint: ${tail.join('/') || '(root)'}`)
  } catch (err) {
    return errorResponse(err)
  }
}
