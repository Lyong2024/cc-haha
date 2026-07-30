/**
 * Browser device fingerprint for pure-web login lockout.
 * Primary: open-source FingerprintJS visitorId.
 * Fallback: lightweight stable hash from UA + locale + screen (no third-party network).
 */

let cachedId: string | null = null
let inflight: Promise<string> | null = null

async function fallbackFingerprint(): Promise<string> {
  const parts = [
    navigator.userAgent,
    navigator.language,
    String(navigator.hardwareConcurrency ?? ''),
    String(screen.width),
    String(screen.height),
    String(screen.colorDepth),
    String(new Date().getTimezoneOffset()),
    String(navigator.maxTouchPoints ?? 0),
  ]
  const raw = parts.join('|')
  if (globalThis.crypto?.subtle) {
    const data = new TextEncoder().encode(raw)
    const digest = await crypto.subtle.digest('SHA-256', data)
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    return `fb_${hex.slice(0, 32)}`
  }
  // Extremely old browsers: short non-crypto hash
  let h = 0
  for (let i = 0; i < raw.length; i += 1) {
    h = ((h << 5) - h + raw.charCodeAt(i)) | 0
  }
  return `fb_${(h >>> 0).toString(16)}`
}

/**
 * Resolve a stable device id for this browser profile.
 * Safe to call multiple times; result is memoized for the page lifetime.
 */
export async function getDeviceFingerprint(): Promise<string> {
  if (cachedId) return cachedId
  if (inflight) return inflight

  inflight = (async () => {
    try {
      const FingerprintJS = await import('@fingerprintjs/fingerprintjs')
      const agent = await FingerprintJS.load()
      const result = await agent.get()
      const id = result.visitorId?.trim()
      if (id) {
        cachedId = id
        return id
      }
    } catch {
      // fall through to local hash
    }
    const fb = await fallbackFingerprint()
    cachedId = fb
    return fb
  })()

  try {
    return await inflight
  } finally {
    inflight = null
  }
}

export function resetDeviceFingerprintCacheForTests(): void {
  cachedId = null
  inflight = null
}
